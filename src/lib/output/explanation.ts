import type { Recommendation } from "../recommend";
import type { DiscoverPlacesResultEntry } from "../bedrock";
import type { ExplanationBasis, VerifiedExplanation } from "./schema";

// ── Fact set construction ─────────────────────────────────────

export function buildExplanationBasis(
  rec: Recommendation,
  entry: DiscoverPlacesResultEntry,
): ExplanationBasis {
  const sourceTypes = entry.sourceQueryTypes ?? [];
  return {
    label: rec.label,
    hasSingleAnchorSource:
      sourceTypes.includes("single-anchor") ||
      rec.connectionProvenance.length > 0,
    hasBlendedSource: sourceTypes.includes("blended"),
    hasCategoryEvidence: rec.categoryEvidence != null,
    hasVenueEvidence: !!(entry.address || entry.phone || entry.website),
    anchorNames: rec.connectionProvenance.map((p) => p.anchorName),
    category: entry.category,
  };
}

// ── Deterministic explanation templates ───────────────────────

function formatAnchorList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function generateDeterministicExplanation(
  basis: ExplanationBasis,
): string {
  switch (basis.label) {
    case "connection": {
      if (basis.anchorNames.length === 0) {
        return "Surfaced in a taste-profile search.";
      }
      return `Qloo's taste graph surfaced this place when asked about ${formatAnchorList(basis.anchorNames)}.`;
    }
    case "useful-place": {
      if (basis.category) {
        return `A ${basis.category} with practical venue details.`;
      }
      return "A practical venue with useful details.";
    }
    case "exploratory":
      return "An exploratory suggestion surfaced in a broader search.";
  }
}

// ── Verification ──────────────────────────────────────────────

export function verifyExplanation(
  text: string,
  basis: ExplanationBasis,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (basis.label !== "connection") {
    if (
      /\bconnected to\b|\bassociation with\b|\blinked to\b|\brelationship with\b/i.test(
        text,
      )
    ) {
      violations.push(
        "Claims anchor-specific connection without connection label",
      );
    }
  }

  if (/\d+\s*%/.test(text)) {
    violations.push("Contains fabricated percentage");
  }

  if (/\b(confidence|probability|match score|match rate)\b/i.test(text)) {
    violations.push("Contains fabricated confidence or match claim");
  }

  if (
    !basis.hasSingleAnchorSource &&
    /\b(because of your love of|fans of|based on your interest in)\b/i.test(
      text,
    )
  ) {
    violations.push(
      "Claims specific interest connection without single-anchor evidence",
    );
  }

  if (
    !basis.hasVenueEvidence &&
    /\b(open until|hours?:|closes? at|opening hours)\b/i.test(text)
  ) {
    violations.push("Claims opening hours without supporting data");
  }

  return { valid: violations.length === 0, violations };
}

// ── Top-level generation with verification ────────────────────

export function generateVerifiedExplanation(
  rec: Recommendation,
  entry: DiscoverPlacesResultEntry,
  modelText?: string,
): VerifiedExplanation {
  const basis = buildExplanationBasis(rec, entry);

  if (modelText) {
    const { valid } = verifyExplanation(modelText, basis);
    if (valid) {
      return { text: modelText, basis, verified: true, fallback: false };
    }
  }

  const labelerText = rec.explanation;
  const { valid: labelerValid } = verifyExplanation(labelerText, basis);
  if (labelerValid) {
    return { text: labelerText, basis, verified: true, fallback: false };
  }

  const fallbackText = generateDeterministicExplanation(basis);
  return { text: fallbackText, basis, verified: true, fallback: true };
}
