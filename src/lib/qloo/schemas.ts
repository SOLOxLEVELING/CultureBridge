import { z } from "zod";

// --- Search endpoint ---

export const SearchEntitySchema = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  types: z.array(z.string()),
  disambiguation: z.string().optional(),
  popularity: z.number().optional(),
});
export type SearchEntity = z.infer<typeof SearchEntitySchema>;

export const SearchResponseSchema = z.looseObject({
  results: z.array(SearchEntitySchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// --- Tags endpoint ---

export const TagParentSchema = z.looseObject({
  type: z.string(),
});

export const TagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  popularity: z.number().optional(),
  parents: z.array(TagParentSchema).optional(),
});
export type Tag = z.infer<typeof TagSchema>;

export const TagsResponseSchema = z.looseObject({
  results: z.looseObject({
    tags: z.array(TagSchema),
  }),
});
export type TagsResponse = z.infer<typeof TagsResponseSchema>;

// --- Insights endpoint ---

export const EntityTagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  weight: z.number().nullable().optional(),
});
export type EntityTag = z.infer<typeof EntityTagSchema>;

export const LocationSchema = z.looseObject({
  lat: z.number(),
  lon: z.number(),
  geohash: z.string().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const ExplainabilityScoreSchema = z.looseObject({
  entity_id: z.string(),
  score: z.number(),
});

export const ExplainabilitySchema = z.looseObject({
  "signal.interests.entities": z
    .array(ExplainabilityScoreSchema)
    .optional(),
});

export const QueryInfoSchema = z.looseObject({
  affinity: z.number().optional(),
  distance: z.number().optional(),
  measurements: z
    .looseObject({ audience_growth: z.number().optional() })
    .optional(),
  explainability: ExplainabilitySchema.optional(),
});
export type QueryInfo = z.infer<typeof QueryInfoSchema>;

export const InsightEntityPropertiesSchema = z.looseObject({
  is_closed: z.boolean().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  neighborhood: z.string().optional(),
  price_level: z.number().nullable().optional(),
  hotel_class: z.number().nullable().optional(),
  star_rating: z.number().nullable().optional(),
  number_of_rooms: z.number().nullable().optional(),
  check_in_time: z.string().nullable().optional(),
  check_out_time: z.string().nullable().optional(),
});
export type InsightEntityProperties = z.infer<
  typeof InsightEntityPropertiesSchema
>;

export const InsightEntitySchema = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  properties: InsightEntityPropertiesSchema.optional(),
  location: LocationSchema.optional(),
  tags: z.array(EntityTagSchema).optional(),
  query: QueryInfoSchema.optional(),
  popularity: z.number().optional(),
  disambiguation: z.string().nullable().optional(),
});
export type InsightEntity = z.infer<typeof InsightEntitySchema>;

export const InsightsResponseSchema = z.looseObject({
  results: z.looseObject({
    entities: z.array(InsightEntitySchema),
  }),
});
export type InsightsResponse = z.infer<typeof InsightsResponseSchema>;
