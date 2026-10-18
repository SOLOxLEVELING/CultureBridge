import type { InsightEntity, InsightsResponse } from "../qloo/schemas";
import type { QlooResult, InsightsParams } from "../qloo/client";
import { insights as qlooInsights } from "../qloo/client";
import { validateEntity } from "../validate";
import type { ValidationResult } from "../validate";

// --- Types ---

export interface CulturalAnchor {
  entityId: string;
  name: string;
}

export type QueryType = "single-anchor" | "blended";

export interface QuerySource {
  queryId: string;
  queryType: QueryType;
  anchorId?: string;
  anchorName?: string;
  city: string;
  rank: number;
}

export interface DiscoveryCandidate {
  entityId: string;
  name: string;
  entity: InsightEntity;
  validation: ValidationResult;
  sources: QuerySource[];
}

export interface QueryFailure {
  queryId: string;
  queryType: QueryType;
  anchorId?: string;
  anchorName?: string;
  error: string;
}

export interface DiscoveryBudget {
  queriesUsed: number;
  queriesBudget: number;
  totalResults: number;
}

export interface DiscoveryResult {
  city: string;
  accepted: DiscoveryCandidate[];
  review: DiscoveryCandidate[];
  rejected: DiscoveryCandidate[];
  failures: QueryFailure[];
  budget: DiscoveryBudget;
}

// --- Configuration ---

export const DEFAULT_MAX_ANCHOR_QUERIES = 5;
export const DEFAULT_RESULTS_PER_QUERY = 10;

export type InsightsFetcher = (
  params: InsightsParams,
) => Promise<QlooResult<InsightsResponse>>;

export interface DiscoveryInput {
  anchors: CulturalAnchor[];
  city: string;
  categoryTagId?: string;
  fetchInsights?: InsightsFetcher;
  maxAnchorQueries?: number;
  resultsPerQuery?: number;
}

// --- Core discovery ---

export async function discover(
  input: DiscoveryInput,
): Promise<DiscoveryResult> {
  const {
    anchors,
    city,
    categoryTagId,
    fetchInsights = qlooInsights,
    maxAnchorQueries = DEFAULT_MAX_ANCHOR_QUERIES,
    resultsPerQuery = DEFAULT_RESULTS_PER_QUERY,
  } = input;

  const effectiveAnchors = anchors.slice(0, maxAnchorQueries);

  if (effectiveAnchors.length === 0) {
    return {
      city,
      accepted: [],
      review: [],
      rejected: [],
      failures: [],
      budget: { queriesUsed: 0, queriesBudget: 0, totalResults: 0 },
    };
  }

  const queriesBudget = effectiveAnchors.length + 1;
  const candidateMap = new Map<string, DiscoveryCandidate>();
  const failures: QueryFailure[] = [];
  let queriesUsed = 0;

  const singleResults = await Promise.allSettled(
    effectiveAnchors.map(async (anchor) => {
      const result = await fetchInsights({
        anchors: [anchor.entityId],
        city,
        tagId: categoryTagId,
        take: resultsPerQuery,
        explainability: true,
      });
      return { anchor, result };
    }),
  );

  for (let i = 0; i < singleResults.length; i++) {
    queriesUsed++;
    const settled = singleResults[i];
    const anchor = effectiveAnchors[i];
    const queryId = `anchor:${anchor.entityId}`;

    if (settled.status === "rejected") {
      failures.push({
        queryId,
        queryType: "single-anchor",
        anchorId: anchor.entityId,
        anchorName: anchor.name,
        error:
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason),
      });
      continue;
    }

    const entities = settled.value.result.data.results.entities;
    for (let rank = 0; rank < entities.length; rank++) {
      mergeCandidate(
        candidateMap,
        entities[rank],
        {
          queryId,
          queryType: "single-anchor",
          anchorId: anchor.entityId,
          anchorName: anchor.name,
          city,
          rank,
        },
        categoryTagId,
      );
    }
  }

  try {
    const blendedResult = await fetchInsights({
      anchors: effectiveAnchors.map((a) => a.entityId),
      city,
      tagId: categoryTagId,
      take: resultsPerQuery,
      explainability: true,
    });
    queriesUsed++;

    const entities = blendedResult.data.results.entities;
    for (let rank = 0; rank < entities.length; rank++) {
      mergeCandidate(
        candidateMap,
        entities[rank],
        { queryId: "blended", queryType: "blended", city, rank },
        categoryTagId,
      );
    }
  } catch (err) {
    queriesUsed++;
    failures.push({
      queryId: "blended",
      queryType: "blended",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const accepted: DiscoveryCandidate[] = [];
  const review: DiscoveryCandidate[] = [];
  const rejected: DiscoveryCandidate[] = [];

  for (const candidate of candidateMap.values()) {
    switch (candidate.validation.verdict) {
      case "accepted":
        accepted.push(candidate);
        break;
      case "review":
        review.push(candidate);
        break;
      case "rejected":
        rejected.push(candidate);
        break;
    }
  }

  return {
    city,
    accepted,
    review,
    rejected,
    failures,
    budget: { queriesUsed, queriesBudget, totalResults: candidateMap.size },
  };
}

function mergeCandidate(
  map: Map<string, DiscoveryCandidate>,
  entity: InsightEntity,
  source: QuerySource,
  categoryTagId?: string,
): void {
  const existing = map.get(entity.entity_id);
  if (existing) {
    existing.sources.push(source);
    return;
  }

  map.set(entity.entity_id, {
    entityId: entity.entity_id,
    name: entity.name,
    entity,
    validation: validateEntity(entity, categoryTagId),
    sources: [source],
  });
}
