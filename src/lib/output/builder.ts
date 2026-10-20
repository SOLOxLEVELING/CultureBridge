import type { DiscoverPlacesResultEntry } from "../bedrock";
import type {
  StructuredRecommendation,
  StructuredOutput,
  PlaceDetails,
  RecommendationProvenance,
} from "./schema";
import { isValidCoordinate } from "./schema";
import { generateVerifiedExplanation } from "./explanation";

// ── Field builders ────────────────────────────────────────────

function buildLocation(
  entry: DiscoverPlacesResultEntry,
): { lat: number; lon: number } | null {
  const loc = entry.location;
  if (!loc) return null;
  if (!isValidCoordinate(loc.lat, loc.lon)) return null;
  return { lat: loc.lat, lon: loc.lon };
}

function buildPlaceDetails(entry: DiscoverPlacesResultEntry): PlaceDetails {
  const location = buildLocation(entry);
  return {
    address: entry.address,
    neighborhood: entry.neighborhood,
    website: entry.website,
    phone: entry.phone ?? null,
    priceLevel: entry.priceLevel ?? null,
    location,
    mappable: location !== null && (entry.mappable !== false),
  };
}

function buildProvenance(
  entry: DiscoverPlacesResultEntry,
): RecommendationProvenance {
  const rec = entry.recommendation!;
  const sourceTypes = entry.sourceQueryTypes ?? [];
  const hasSingleAnchor =
    sourceTypes.includes("single-anchor") ||
    rec.connectionProvenance.length > 0;
  const hasBlended = sourceTypes.includes("blended");

  let queryMode: "single-anchor" | "blended" | "mixed";
  if (hasSingleAnchor && hasBlended) queryMode = "mixed";
  else if (hasSingleAnchor) queryMode = "single-anchor";
  else queryMode = "blended";

  return {
    queryMode,
    anchorIds: rec.connectionProvenance.map((p) => p.anchorId),
    connectionProvenance: rec.connectionProvenance.map((p) => ({
      anchorId: p.anchorId,
      anchorName: p.anchorName,
      rank: p.rank,
      queryId: p.queryId,
    })),
    categoryEvidence: rec.categoryEvidence ?? null,
  };
}

function buildCategories(entry: DiscoverPlacesResultEntry): string[] {
  if (entry.tags && entry.tags.length > 0) {
    const categoryTags = entry.tags.filter((t) =>
      t.id.startsWith("urn:tag:category:place:"),
    );
    if (categoryTags.length > 0) return categoryTags.map((t) => t.name);
  }
  return entry.category ? [entry.category] : [];
}

// ── Single recommendation builder ─────────────────────────────

export function buildRecommendation(
  entry: DiscoverPlacesResultEntry,
): StructuredRecommendation | null {
  const rec = entry.recommendation;
  if (!rec) return null;

  return {
    entityId: entry.entityId,
    name: entry.name,
    label: rec.label,
    categories: buildCategories(entry),
    provenance: buildProvenance(entry),
    details: buildPlaceDetails(entry),
    tags: entry.tags ?? [],
    explanation: generateVerifiedExplanation(rec, entry),
  };
}

// ── Full output builder ───────────────────────────────────────

export function buildStructuredOutput(
  summary: string,
  validIds: string[],
  invalidIds: string[],
  acceptedRecords: Map<string, DiscoverPlacesResultEntry>,
): StructuredOutput {
  const recommendations: StructuredRecommendation[] = [];

  for (const id of validIds) {
    const entry = acceptedRecords.get(id);
    if (!entry) continue;
    const rec = buildRecommendation(entry);
    if (rec) recommendations.push(rec);
  }

  let status: "success" | "empty" | "partial";
  if (recommendations.length === 0) {
    status = "empty";
  } else if (invalidIds.length > 0) {
    status = "partial";
  } else {
    status = "success";
  }

  return {
    status,
    summary,
    recommendations,
    totalRecommendations: recommendations.length,
    invalidIds,
  };
}
