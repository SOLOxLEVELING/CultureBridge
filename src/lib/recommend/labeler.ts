import type { DiscoveryCandidate, QuerySource } from "../discover/discovery";
import type { CategoryEvidence } from "../validate/validator";
import type { InsightEntity } from "../qloo/schemas";

// --- Types ---

export type RecommendationLabel = "connection" | "useful-place" | "exploratory";

export interface ConnectionProvenance {
  anchorId: string;
  anchorName: string;
  rank: number;
  queryId: string;
}

export interface Recommendation {
  entityId: string;
  name: string;
  label: RecommendationLabel;
  connectionProvenance: ConnectionProvenance[];
  categoryEvidence: CategoryEvidence | undefined;
  explanation: string;
}

// --- Constants ---

const CONNECTION_RANK_THRESHOLD = 9;

// --- Precedence: Connection > Useful place > Exploratory ---
//
// Connection: accepted + single-anchor source with rank 0–9 + anchorId present.
// Useful place: accepted + category evidence + practical venue evidence, no
//   qualifying Connection provenance.
// Exploratory: any other accepted candidate (blended-only, rank 10+, or missing
//   category/venue evidence).

function getQualifyingConnectionSources(
  sources: QuerySource[],
): QuerySource[] {
  return sources.filter(
    (s) =>
      s.queryType === "single-anchor" &&
      s.anchorId != null &&
      s.anchorName != null &&
      s.rank <= CONNECTION_RANK_THRESHOLD,
  );
}

export function hasPracticalVenueEvidence(entity: InsightEntity): boolean {
  const p = entity.properties;
  if (!p) return false;
  return !!(p.website || p.phone || p.address);
}

function formatAnchorList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// --- Label assignment (single candidate) ---

export function assignLabel(
  candidate: DiscoveryCandidate,
): Recommendation | null {
  if (candidate.validation.verdict !== "accepted") {
    return null;
  }

  const qualifyingSources = getQualifyingConnectionSources(candidate.sources);

  if (qualifyingSources.length > 0) {
    const provenance: ConnectionProvenance[] = qualifyingSources.map((s) => ({
      anchorId: s.anchorId!,
      anchorName: s.anchorName!,
      rank: s.rank,
      queryId: s.queryId,
    }));

    const anchorNames = provenance.map((p) => p.anchorName);
    return {
      entityId: candidate.entityId,
      name: candidate.name,
      label: "connection",
      connectionProvenance: provenance,
      categoryEvidence: candidate.validation.categoryEvidence,
      explanation: `Qloo's taste graph surfaced this place when asked about ${formatAnchorList(anchorNames)}.`,
    };
  }

  if (
    candidate.validation.categoryEvidence &&
    hasPracticalVenueEvidence(candidate.entity)
  ) {
    return {
      entityId: candidate.entityId,
      name: candidate.name,
      label: "useful-place",
      connectionProvenance: [],
      categoryEvidence: candidate.validation.categoryEvidence,
      explanation: `A ${candidate.validation.categoryEvidence.requestedCategory} with practical venue details.`,
    };
  }

  return {
    entityId: candidate.entityId,
    name: candidate.name,
    label: "exploratory",
    connectionProvenance: [],
    categoryEvidence: candidate.validation.categoryEvidence,
    explanation:
      "An exploratory suggestion, not a verified direct cultural association.",
  };
}

// --- Batch labeling (accepted candidates only) ---

export function labelDiscoveryResults(
  accepted: DiscoveryCandidate[],
): Recommendation[] {
  const results: Recommendation[] = [];
  for (const candidate of accepted) {
    const rec = assignLabel(candidate);
    if (rec) {
      results.push(rec);
    }
  }
  return results;
}
