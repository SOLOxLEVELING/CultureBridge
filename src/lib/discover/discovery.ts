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
  signal?: AbortSignal,
) => Promise<QlooResult<InsightsResponse>>;

export interface DiscoveryInput {
  anchors: CulturalAnchor[];
  city: string;
  categoryTagId?: string;
  fetchInsights?: InsightsFetcher;
  maxAnchorQueries?: number;
  resultsPerQuery?: number;
  signal?: AbortSignal;
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
    signal,
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

  const singleResultsPromise = Promise.allSettled(
    effectiveAnchors.map(async (anchor) => {
      const result = await fetchInsights({
        anchors: [anchor.entityId],
        city,
        tagId: categoryTagId,
        take: resultsPerQuery,
        explainability: true,
      }, signal);
      return { anchor, result };
    }),
  );

  // When multiple anchors exist, the blended query has a distinct cache key from
  // single-anchor queries, so start it concurrently while preserving merge order.
  const blendedEarlyPromise =
    effectiveAnchors.length > 1
      ? fetchInsights(
          {
            anchors: effectiveAnchors.map((a) => a.entityId),
            city,
            tagId: categoryTagId,
            take: resultsPerQuery,
            explainability: true,
          },
          signal,
        ).then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        )
      : null;

  const singleResults = await singleResultsPromise;

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
    let blendedResult: QlooResult<InsightsResponse>;
    if (blendedEarlyPromise) {
      const outcome = await blendedEarlyPromise;
      if (!outcome.ok) throw outcome.error;
      blendedResult = outcome.value;
    } else {
      blendedResult = await fetchInsights({
        anchors: effectiveAnchors.map((a) => a.entityId),
        city,
        tagId: categoryTagId,
        take: resultsPerQuery,
        explainability: true,
      }, signal);
    }
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

  // Order accepted candidates by best query rank across single-anchor and blended
  // queries (0-based ascending), breaking ties by number of corroborating queries
  // (descending), then preserving original query order. This prevents the first
  // anchor's lower-ranked results (e.g. rank 8–9) from crowding out top-ranked
  // results (e.g. rank 0–1) from subsequent anchors or the blended query.
  accepted.sort((a, b) => {
    const rankDiff = bestSourceRank(a) - bestSourceRank(b);
    if (rankDiff !== 0) return rankDiff;
    return b.sources.length - a.sources.length;
  });

  return {
    city,
    accepted,
    review,
    rejected,
    failures,
    budget: { queriesUsed, queriesBudget, totalResults: candidateMap.size },
  };
}

function bestSourceRank(candidate: DiscoveryCandidate): number {
  if (candidate.sources.length === 0) return Number.MAX_SAFE_INTEGER;
  let best = Number.MAX_SAFE_INTEGER;
  for (const src of candidate.sources) {
    if (src.rank < best) best = src.rank;
  }
  return best;
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
