import { z } from "zod";

// ── Atomic schemas ────────────────────────────────────────────

export const TagInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});
export type TagInfo = z.infer<typeof TagInfoSchema>;

export const CoordinateSchema = z.object({
  lat: z.number(),
  lon: z.number(),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;

export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

// ── Place details ─────────────────────────────────────────────

export const PlaceDetailsSchema = z.object({
  address: z.string().nullable(),
  neighborhood: z.string().nullable(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  priceLevel: z.number().nullable(),
  location: CoordinateSchema.nullable(),
  mappable: z.boolean(),
});
export type PlaceDetails = z.infer<typeof PlaceDetailsSchema>;

// ── Provenance ────────────────────────────────────────────────

export const ConnectionProvenanceOutputSchema = z.object({
  anchorId: z.string(),
  anchorName: z.string(),
  rank: z.number(),
  queryId: z.string(),
});

export const CategoryEvidenceOutputSchema = z.object({
  requestedCategory: z.string(),
  score: z.number(),
  position: z.number().nullable(),
  conflict: z.boolean(),
});

export const RecommendationProvenanceSchema = z.object({
  queryMode: z.enum(["single-anchor", "blended", "mixed"]),
  anchorIds: z.array(z.string()),
  connectionProvenance: z.array(ConnectionProvenanceOutputSchema),
  categoryEvidence: CategoryEvidenceOutputSchema.nullable(),
});
export type RecommendationProvenance = z.infer<typeof RecommendationProvenanceSchema>;

// ── Explanation ───────────────────────────────────────────────

export const ExplanationBasisSchema = z.object({
  label: z.enum(["connection", "useful-place", "exploratory"]),
  hasSingleAnchorSource: z.boolean(),
  hasBlendedSource: z.boolean(),
  hasCategoryEvidence: z.boolean(),
  hasVenueEvidence: z.boolean(),
  anchorNames: z.array(z.string()),
  category: z.string().nullable(),
});
export type ExplanationBasis = z.infer<typeof ExplanationBasisSchema>;

export const VerifiedExplanationSchema = z.object({
  text: z.string(),
  basis: ExplanationBasisSchema,
  verified: z.boolean(),
  fallback: z.boolean(),
});
export type VerifiedExplanation = z.infer<typeof VerifiedExplanationSchema>;

// ── Recommendation ────────────────────────────────────────────

export const LabelSchema = z.enum(["connection", "useful-place", "exploratory"]);

export const StructuredRecommendationSchema = z.object({
  entityId: z.string(),
  name: z.string(),
  label: LabelSchema,
  categories: z.array(z.string()),
  provenance: RecommendationProvenanceSchema,
  details: PlaceDetailsSchema,
  tags: z.array(TagInfoSchema),
  explanation: VerifiedExplanationSchema,
});
export type StructuredRecommendation = z.infer<typeof StructuredRecommendationSchema>;

// ── Top-level output ──────────────────────────────────────────

export const StructuredOutputSchema = z.object({
  status: z.enum(["success", "empty", "partial"]),
  summary: z.string(),
  recommendations: z.array(StructuredRecommendationSchema),
  totalRecommendations: z.number(),
  invalidIds: z.array(z.string()),
});
export type StructuredOutput = z.infer<typeof StructuredOutputSchema>;
