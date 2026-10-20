import { searchEntity, searchTags } from "../qloo/client";
import type { InsightsParams, QlooResult } from "../qloo/client";
import type { InsightsResponse } from "../qloo/schemas";
import { resolveEntityFromResults } from "../qloo/resolver";
import type { ResolvedEntity } from "../qloo/resolver";
import { discover } from "../discover";
import type {
  CulturalAnchor,
  DiscoveryCandidate,
  InsightsFetcher,
} from "../discover";
import { assignLabel } from "../recommend";
import type { Recommendation } from "../recommend";
import { TOOL_NAMES } from "./tool-specs";
import type {
  ToolName,
  ResolveAnchorArgs,
  DiscoverPlacesArgs,
  FindTagsArgs,
  FinalizeArgs,
} from "./tool-specs";

// --- Tool result types ---

export interface ResolveAnchorResult {
  status: "resolved" | "ambiguous" | "not_found";
  entity?: {
    entityId: string;
    name: string;
    disambiguation?: string;
  };
  candidates?: {
    entityId: string;
    name: string;
    disambiguation?: string;
  }[];
  requestedType: string;
}

export interface DiscoverPlacesResultEntry {
  entityId: string;
  name: string;
  recommendation: Recommendation | null;
  category: string | null;
  address: string | null;
  neighborhood: string | null;
  website: string | null;
  phone?: string | null;
  priceLevel?: number | null;
  location?: { lat: number; lon: number } | null;
  mappable?: boolean;
  tags?: { id: string; name: string; type: string }[];
  sourceQueryTypes?: ("single-anchor" | "blended")[];
}

export interface DiscoverPlacesResult {
  city: string;
  accepted: DiscoverPlacesResultEntry[];
  reviewCount: number;
  rejectedCount: number;
  rejectedReasons: Record<string, number>;
  failureCount: number;
  budget: { queriesUsed: number; queriesBudget: number; totalResults: number };
}

export interface FindTagsResult {
  tags: { id: string; name: string; type: string }[];
}

export interface FinalizeResult {
  status: "complete";
  summary: string;
  recommendationCount: number;
  recommendationIds: string[];
}

export type ToolResult =
  | ResolveAnchorResult
  | DiscoverPlacesResult
  | FindTagsResult
  | FinalizeResult;

export interface ToolExecutionSuccess {
  ok: true;
  toolName: ToolName;
  result: ToolResult;
}

export interface ToolExecutionError {
  ok: false;
  toolName: string;
  error: string;
}

export type ToolExecutionOutcome = ToolExecutionSuccess | ToolExecutionError;

// --- Argument validation ---

function validateResolveAnchorArgs(
  input: unknown,
): ResolveAnchorArgs | string {
  if (typeof input !== "object" || input === null) {
    return "Arguments must be an object.";
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) {
    return "query must be a non-empty string.";
  }
  if (typeof obj.type !== "string" || obj.type.trim().length === 0) {
    return "type must be a non-empty string.";
  }
  return { query: obj.query.trim(), type: obj.type.trim() };
}

function validateDiscoverPlacesArgs(
  input: unknown,
): DiscoverPlacesArgs | string {
  if (typeof input !== "object" || input === null) {
    return "Arguments must be an object.";
  }
  const obj = input as Record<string, unknown>;

  if (!Array.isArray(obj.anchor_ids) || obj.anchor_ids.length === 0) {
    return "anchor_ids must be a non-empty array.";
  }
  if (obj.anchor_ids.length > 5) {
    return "anchor_ids must have at most 5 entries.";
  }
  if (!obj.anchor_ids.every((id: unknown) => typeof id === "string" && id.trim().length > 0)) {
    return "Every anchor_id must be a non-empty string.";
  }

  if (!Array.isArray(obj.anchor_names) || obj.anchor_names.length === 0) {
    return "anchor_names must be a non-empty array.";
  }
  if (obj.anchor_names.length !== obj.anchor_ids.length) {
    return "anchor_names must have the same length as anchor_ids.";
  }
  if (!obj.anchor_names.every((n: unknown) => typeof n === "string" && n.trim().length > 0)) {
    return "Every anchor_name must be a non-empty string.";
  }

  if (typeof obj.city !== "string" || obj.city.trim().length === 0) {
    return "city must be a non-empty string.";
  }

  const categoryTagId =
    typeof obj.category_tag_id === "string" && obj.category_tag_id.trim().length > 0
      ? obj.category_tag_id.trim()
      : undefined;

  return {
    anchor_ids: obj.anchor_ids.map((id: string) => id.trim()),
    anchor_names: obj.anchor_names.map((n: string) => n.trim()),
    city: obj.city.trim(),
    category_tag_id: categoryTagId,
  };
}

function validateFindTagsArgs(input: unknown): FindTagsArgs | string {
  if (typeof input !== "object" || input === null) {
    return "Arguments must be an object.";
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) {
    return "query must be a non-empty string.";
  }
  return { query: obj.query.trim() };
}

function validateFinalizeArgs(input: unknown): FinalizeArgs | string {
  if (typeof input !== "object" || input === null) {
    return "Arguments must be an object.";
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    return "summary must be a non-empty string.";
  }
  if (!Array.isArray(obj.recommendation_ids)) {
    return "recommendation_ids must be an array.";
  }
  if (
    !obj.recommendation_ids.every(
      (id: unknown) => typeof id === "string",
    )
  ) {
    return "Every recommendation_id must be a string.";
  }
  return {
    summary: obj.summary.trim(),
    recommendation_ids: obj.recommendation_ids as string[],
  };
}

// --- Tool execution functions ---

export interface ToolDeps {
  searchEntity: typeof searchEntity;
  searchTags: typeof searchTags;
  fetchInsights?: InsightsFetcher;
}

const DEFAULT_DEPS: ToolDeps = {
  searchEntity,
  searchTags,
};

async function executeResolveAnchor(
  args: ResolveAnchorArgs,
  deps: ToolDeps,
  signal?: AbortSignal,
): Promise<ResolveAnchorResult> {
  const searchResult = await deps.searchEntity(args.query, undefined, signal);
  const resolved = resolveEntityFromResults(
    searchResult.data.results,
    args.type,
  );

  if (resolved.status === "resolved") {
    return {
      status: "resolved",
      entity: {
        entityId: resolved.entity.entityId,
        name: resolved.entity.name,
        disambiguation: resolved.entity.disambiguation,
      },
      requestedType: args.type,
    };
  }

  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: resolved.candidates.map((c: ResolvedEntity) => ({
        entityId: c.entityId,
        name: c.name,
        disambiguation: c.disambiguation,
      })),
      requestedType: args.type,
    };
  }

  return { status: "not_found", requestedType: args.type };
}

function candidateToEntry(
  candidate: DiscoveryCandidate,
): DiscoverPlacesResultEntry {
  const rec = assignLabel(candidate);
  const tags = candidate.entity.tags ?? [];
  const categoryTag = tags.find((t) =>
    t.id.startsWith("urn:tag:category:place:"),
  );
  const loc = candidate.entity.location;
  const validLocation =
    loc?.lat != null && loc?.lon != null
      ? { lat: loc.lat, lon: loc.lon }
      : null;
  return {
    entityId: candidate.entityId,
    name: candidate.name,
    recommendation: rec,
    category: categoryTag?.name ?? null,
    address: candidate.entity.properties?.address ?? null,
    neighborhood: candidate.entity.properties?.neighborhood ?? null,
    website: candidate.entity.properties?.website ?? null,
    phone: candidate.entity.properties?.phone ?? null,
    priceLevel: candidate.entity.properties?.price_level ?? null,
    location: validLocation,
    mappable: candidate.validation.mappable,
    tags: tags.map((t) => ({ id: t.id, name: t.name, type: t.type })),
    sourceQueryTypes: [...new Set(candidate.sources.map((s) => s.queryType))],
  };
}

async function executeDiscoverPlaces(
  args: DiscoverPlacesArgs,
  deps: ToolDeps,
  signal?: AbortSignal,
): Promise<DiscoverPlacesResult> {
  const anchors: CulturalAnchor[] = args.anchor_ids.map((id, i) => ({
    entityId: id,
    name: args.anchor_names[i],
  }));

  const result = await discover({
    anchors,
    city: args.city,
    categoryTagId: args.category_tag_id,
    fetchInsights: deps.fetchInsights,
    signal,
  });

  const accepted = result.accepted.map(candidateToEntry);

  const rejectedReasons: Record<string, number> = {};
  for (const r of result.rejected) {
    const reason = r.validation.reason ?? "unknown";
    rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
  }

  return {
    city: args.city,
    accepted,
    reviewCount: result.review.length,
    rejectedCount: result.rejected.length,
    rejectedReasons,
    failureCount: result.failures.length,
    budget: result.budget,
  };
}

async function executeFindTags(
  args: FindTagsArgs,
  deps: ToolDeps,
  signal?: AbortSignal,
): Promise<FindTagsResult> {
  const result = await deps.searchTags(args.query, 5, signal);
  return {
    tags: result.data.results.tags.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
    })),
  };
}

function executeFinalize(args: FinalizeArgs): FinalizeResult {
  return {
    status: "complete",
    summary: args.summary,
    recommendationCount: args.recommendation_ids.length,
    recommendationIds: args.recommendation_ids,
  };
}

// --- Dispatch ---

export async function dispatchToolCall(
  toolName: string,
  toolInput: unknown,
  deps: ToolDeps = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  if (toolName === TOOL_NAMES.RESOLVE_ANCHOR) {
    const validated = validateResolveAnchorArgs(toolInput);
    if (typeof validated === "string") {
      return { ok: false, toolName, error: validated };
    }
    try {
      const result = await executeResolveAnchor(validated, deps, signal);
      return { ok: true, toolName: TOOL_NAMES.RESOLVE_ANCHOR, result };
    } catch (err) {
      return { ok: false, toolName, error: sanitizeError(err) };
    }
  }

  if (toolName === TOOL_NAMES.DISCOVER_PLACES) {
    const validated = validateDiscoverPlacesArgs(toolInput);
    if (typeof validated === "string") {
      return { ok: false, toolName, error: validated };
    }
    try {
      const result = await executeDiscoverPlaces(validated, deps, signal);
      return { ok: true, toolName: TOOL_NAMES.DISCOVER_PLACES, result };
    } catch (err) {
      return { ok: false, toolName, error: sanitizeError(err) };
    }
  }

  if (toolName === TOOL_NAMES.FIND_TAGS) {
    const validated = validateFindTagsArgs(toolInput);
    if (typeof validated === "string") {
      return { ok: false, toolName, error: validated };
    }
    try {
      const result = await executeFindTags(validated, deps, signal);
      return { ok: true, toolName: TOOL_NAMES.FIND_TAGS, result };
    } catch (err) {
      return { ok: false, toolName, error: sanitizeError(err) };
    }
  }

  if (toolName === TOOL_NAMES.FINALIZE) {
    const validated = validateFinalizeArgs(toolInput);
    if (typeof validated === "string") {
      return { ok: false, toolName, error: validated };
    }
    const result = executeFinalize(validated);
    return { ok: true, toolName: TOOL_NAMES.FINALIZE, result };
  }

  return {
    ok: false,
    toolName,
    error: `Unknown tool: ${toolName}`,
  };
}

// --- Error sanitization ---

function sanitizeError(err: unknown): string {
  if (!(err instanceof Error)) return "Tool execution failed.";
  const msg = err.message;
  if (/api.?key|secret|credential|token|password/i.test(msg)) {
    return "Tool execution failed due to a configuration error.";
  }
  return msg.slice(0, 500);
}
