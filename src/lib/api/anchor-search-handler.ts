import { z } from "zod";
import { searchEntity as defaultSearchEntity } from "../qloo/client";
import type { QlooResult } from "../qloo/client";
import type { SearchResponse } from "../qloo/schemas";
import { resolveEntityFromResults } from "../qloo/resolver";
import {
  SUPPORTED_ANCHOR_TYPES,
  SupportedAnchorTypeSchema,
  isSupportedAnchorType,
} from "../input/presets";
import type { SupportedAnchorType } from "../input/presets";
import { checkRateLimit } from "./kit-handler";

// ── Constants ────────────────────────────────────────────────

export const ANCHOR_SEARCH_RATE_LIMIT = 30;
export const MAX_ANCHOR_CANDIDATES = 5;

// ── Schemas ──────────────────────────────────────────────────

export const AnchorSearchRequestSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Query is required.")
    .max(200, "Query must be 200 characters or fewer."),
  type: SupportedAnchorTypeSchema,
});

export type AnchorSearchRequest = z.infer<typeof AnchorSearchRequestSchema>;

export const AnchorCandidateSchema = z.object({
  entityId: z.string().min(1),
  name: z.string().min(1),
  types: z.array(z.enum(SUPPORTED_ANCHOR_TYPES)).min(1),
  disambiguation: z.string().optional(),
});

export type AnchorCandidate = z.infer<typeof AnchorCandidateSchema>;

export const AnchorSearchResponseSchema = z.object({
  status: z.enum(["matches", "no_matches", "error"]),
  resolutionStatus: z.enum(["resolved", "ambiguous", "not_found"]),
  query: z.string(),
  requestedType: z.string(),
  candidates: z.array(AnchorCandidateSchema),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type AnchorSearchResponse = z.infer<typeof AnchorSearchResponseSchema>;

// ── Injectable dependencies ──────────────────────────────────

export interface AnchorSearchDeps {
  searchEntity?: (
    query: string,
    take?: number,
    signal?: AbortSignal,
  ) => Promise<QlooResult<SearchResponse>>;
  rateLimit?: number;
}

// ── Error sanitization ───────────────────────────────────────

export function sanitizeAnchorLookupError(err: unknown): string {
  if (!(err instanceof Error)) {
    return "Entity lookup failed. Please try again.";
  }
  const msg = err.message;
  if (
    /api.?key|secret|credential|token|password|authorization|qloo_api_key|bearer/i.test(
      msg,
    )
  ) {
    return "Entity lookup service configuration error.";
  }
  if (/qloo api|returned \d{3}|fetch|network|econnrefused|etimedout/i.test(msg)) {
    return "Unable to reach Qloo entity search right now. Please retry.";
  }
  return "Entity lookup failed. Please try again.";
}

// ── Rate limit helper ────────────────────────────────────────

export function checkAnchorSearchRateLimit(
  clientId: string,
  limit: number = ANCHOR_SEARCH_RATE_LIMIT,
): boolean {
  return checkRateLimit(`anchor-search:${clientId}`, limit);
}

// ── Handler ──────────────────────────────────────────────────

export async function handleAnchorSearch(
  body: unknown,
  clientId: string,
  deps: AnchorSearchDeps = {},
): Promise<{ response: AnchorSearchResponse; httpStatus: number }> {
  // 1. Validate request with Zod
  const parsed = AnchorSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "request"}: ${i.message}`,
    );
    return {
      httpStatus: 400,
      response: {
        status: "error",
        resolutionStatus: "not_found",
        query: "",
        requestedType: "",
        candidates: [],
        error: {
          code: "invalid_request",
          message: issues.join("; "),
        },
      },
    };
  }

  const req = parsed.data;

  // 2. Enforce rate limit before upstream call
  const limit = deps.rateLimit ?? ANCHOR_SEARCH_RATE_LIMIT;
  if (checkAnchorSearchRateLimit(clientId, limit)) {
    return {
      httpStatus: 429,
      response: {
        status: "error",
        resolutionStatus: "not_found",
        query: req.query,
        requestedType: req.type,
        candidates: [],
        error: {
          code: "rate_limited",
          message: "Too many anchor lookups. Please wait a moment and try again.",
        },
      },
    };
  }

  // 3. Query Qloo search server-side and resolve candidates using project conventions
  const searchFn = deps.searchEntity ?? defaultSearchEntity;

  try {
    const searchResult = await searchFn(req.query);
    const rawResults = searchResult.data.results;
    const resolved = resolveEntityFromResults(rawResults, req.type);

    if (resolved.status === "not_found") {
      return {
        httpStatus: 200,
        response: {
          status: "no_matches",
          resolutionStatus: "not_found",
          query: req.query,
          requestedType: req.type,
          candidates: [],
        },
      };
    }

    const resolvedEntities =
      resolved.status === "resolved" ? [resolved.entity] : resolved.candidates;

    // Collect supported types across all rows sharing each entity_id
    const typesByEntityId = new Map<string, Set<SupportedAnchorType>>();
    for (const row of rawResults) {
      let set = typesByEntityId.get(row.entity_id);
      if (!set) {
        set = new Set<SupportedAnchorType>();
        typesByEntityId.set(row.entity_id, set);
      }
      for (const t of row.types) {
        if (isSupportedAnchorType(t)) {
          set.add(t);
        }
      }
    }

    const candidates: AnchorCandidate[] = resolvedEntities
      .slice(0, MAX_ANCHOR_CANDIDATES)
      .map((entity) => {
        const typeSet = typesByEntityId.get(entity.entityId) ?? new Set<SupportedAnchorType>();
        typeSet.add(req.type);
        const disambig = entity.disambiguation?.trim();
        return AnchorCandidateSchema.parse({
          entityId: entity.entityId,
          name: entity.name.trim(),
          types: [...typeSet],
          ...(disambig && disambig.length > 0
            ? { disambiguation: disambig.slice(0, 120) }
            : {}),
        });
      });

    return {
      httpStatus: 200,
      response: {
        status: "matches",
        resolutionStatus: resolved.status,
        query: req.query,
        requestedType: req.type,
        candidates,
      },
    };
  } catch (err) {
    return {
      httpStatus: 502,
      response: {
        status: "error",
        resolutionStatus: "not_found",
        query: req.query,
        requestedType: req.type,
        candidates: [],
        error: {
          code: "lookup_failed",
          message: sanitizeAnchorLookupError(err),
        },
      },
    };
  }
}
