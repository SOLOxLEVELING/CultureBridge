import { z } from "zod";
import { runAgent as defaultRunAgent } from "../agent";
import type { AgentRunInput, AgentRunResult, ConfirmedAnchor } from "../agent";
import { discover as defaultDiscover } from "../discover";
import type { CulturalAnchor, DiscoveryInput } from "../discover";
import { searchEntity as defaultSearchEntity } from "../qloo/client";
import type { QlooResult } from "../qloo/client";
import type { SearchResponse } from "../qloo/schemas";
import { resolveEntityFromResults } from "../qloo/resolver";
import { candidateToEntry } from "../bedrock";
import type { DiscoverPlacesResultEntry } from "../bedrock";
import { buildStructuredOutput, StructuredOutputSchema, OutputValidationError } from "../output";
import type { StructuredOutput } from "../output";

// ── Request schema ───────────────────────────────────────────

export const KitRequestSchema = z.object({
  city: z.string().min(1).max(100),
  anchors: z
    .array(
      z.object({
        query: z.string().min(1).max(200),
        type: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(10),
  confirmedAnchors: z
    .array(
      z.object({
        entityId: z.string().min(1),
        name: z.string().min(1),
        query: z.string().min(1).max(200),
        type: z.string().min(1).max(100),
      }),
    )
    .max(5)
    .optional(),
});

export type KitRequest = z.infer<typeof KitRequestSchema>;

// ── Response types ───────────────────────────────────────────

export interface KitErrorDetail {
  code: string;
  message: string;
}

export interface KitMeta {
  runId: string;
  city: string;
  anchorCount: number;
  mode: "agent" | "deterministic";
  cached: boolean;
  durationMs: number;
}

export interface KitResponse {
  status: "success" | "empty" | "partial" | "error";
  output: StructuredOutput | null;
  error?: KitErrorDetail;
  meta: KitMeta;
}

// ── Response cache (24h TTL, instance-local) ─────────────────

interface CacheEntry {
  response: KitResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const responseCache = new Map<string, CacheEntry>();

export function buildCacheKey(req: KitRequest): string {
  const city = req.city.toLowerCase().trim();

  // Represent each anchor as a 2-tuple and sort field-by-field so that a query
  // containing "|", ";" or any other delimiter cannot collide with a different
  // query+type pair. JSON.stringify provides unambiguous, escape-safe encoding.
  const anchors = req.anchors
    .map((a): [string, string] => [a.query.toLowerCase().trim(), a.type.trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const confirmed = (req.confirmedAnchors ?? [])
    .map((c): [string, string, string] => [
      c.entityId,
      c.query.toLowerCase().trim(),
      c.type.trim(),
    ])
    .sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 :
      a[1] < b[1] ? -1 : a[1] > b[1] ? 1 :
      a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0,
    );

  return JSON.stringify({ city, anchors, confirmed });
}

function getCached(key: string): KitResponse | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry.response;
}

function setCache(key: string, response: KitResponse): void {
  responseCache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearResponseCache(): void {
  responseCache.clear();
}

// ── Rate limiter (sliding window, instance-local) ────────────

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;

const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(
  clientId: string,
  limit: number = RATE_LIMIT,
): boolean {
  const now = Date.now();
  let timestamps = rateBuckets.get(clientId);
  if (!timestamps) {
    timestamps = [];
    rateBuckets.set(clientId, timestamps);
  }
  while (timestamps.length > 0 && now - timestamps[0] >= RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) return true;
  timestamps.push(now);
  return false;
}

export function clearRateLimits(): void {
  rateBuckets.clear();
}

// ── Injectable dependencies ──────────────────────────────────

export interface KitHandlerDeps {
  runAgent?: (
    input: AgentRunInput,
    signal?: AbortSignal,
  ) => Promise<AgentRunResult>;
  searchEntity?: (
    query: string,
    take?: number,
    signal?: AbortSignal,
  ) => Promise<QlooResult<SearchResponse>>;
  discover?: (input: DiscoveryInput) => Promise<import("../discover").DiscoveryResult>;
  agentTimeoutMs?: number;
  handlerDeadlineMs?: number;
}

const DEFAULT_AGENT_TIMEOUT_MS = 12_000;
const DEFAULT_HANDLER_DEADLINE_MS = 28_000;
// Minimum remaining time needed to attempt fallback
const FALLBACK_MIN_MS = 3_000;

// ── Confirmed-anchor verification ───────────────────────────
// Re-searches Qloo for each confirmed anchor's original query
// and type. Accepts only exact entity-ID matches from the
// server-fetched results. Uses the Qloo-returned name.

export interface VerifiedAnchor {
  entityId: string;
  name: string;
}

export interface AnchorVerificationResult {
  verified: VerifiedAnchor[];
  rejected: { entityId: string; reason: string }[];
}

export async function verifyConfirmedAnchors(
  confirmedAnchors: NonNullable<KitRequest["confirmedAnchors"]>,
  anchors: KitRequest["anchors"],
  searchFn: NonNullable<KitHandlerDeps["searchEntity"]>,
  signal?: AbortSignal,
): Promise<AnchorVerificationResult> {
  const verified: VerifiedAnchor[] = [];
  const rejected: AnchorVerificationResult["rejected"] = [];
  const seenIds = new Set<string>();

  // Build a set of normalized anchor keys for O(1) lookup.
  // JSON.stringify avoids delimiter collisions when query or type contains "|".
  const anchorKeys = new Set(
    anchors.map((a) =>
      JSON.stringify([a.query.toLowerCase().trim(), a.type.trim()]),
    ),
  );

  for (const ca of confirmedAnchors) {
    if (seenIds.has(ca.entityId)) continue;

    // Check deadline before starting a new verification operation
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    // Reject confirmations whose query/type do not correspond to a submitted anchor
    const confirmationKey = JSON.stringify([ca.query.toLowerCase().trim(), ca.type.trim()]);
    if (!anchorKeys.has(confirmationKey)) {
      rejected.push({
        entityId: ca.entityId,
        reason: "no_matching_anchor",
      });
      continue;
    }

    try {
      const result = await searchFn(ca.query, undefined, signal);
      const typeMatches = result.data.results.filter((r) =>
        r.types.includes(ca.type),
      );
      const exactMatch = typeMatches.find(
        (r) => r.entity_id === ca.entityId,
      );
      if (exactMatch) {
        verified.push({
          entityId: exactMatch.entity_id,
          name: exactMatch.name,
        });
        seenIds.add(exactMatch.entity_id);
      } else {
        rejected.push({
          entityId: ca.entityId,
          reason: typeMatches.length === 0 ? "type_not_found" : "id_not_in_results",
        });
      }
    } catch (err) {
      // Do not swallow deadline/abort errors as transient search failures
      if (signal?.aborted) throw err;
      rejected.push({ entityId: ca.entityId, reason: "search_failed" });
    }
  }

  return { verified, rejected };
}

// ── Deterministic fallback ───────────────────────────────────

async function runFallback(
  req: KitRequest,
  verifiedAnchors: VerifiedAnchor[],
  deps: KitHandlerDeps,
  signal?: AbortSignal,
): Promise<StructuredOutput> {
  const searchFn = deps.searchEntity ?? defaultSearchEntity;
  const discoverFn = deps.discover ?? defaultDiscover;

  const resolvedAnchors: CulturalAnchor[] = [];
  const seenIds = new Set<string>();

  for (const va of verifiedAnchors) {
    if (!seenIds.has(va.entityId)) {
      resolvedAnchors.push({ entityId: va.entityId, name: va.name });
      seenIds.add(va.entityId);
    }
  }

  for (const anchor of req.anchors) {
    if (signal?.aborted) break;
    try {
      const result = await searchFn(anchor.query, undefined, signal);
      const resolved = resolveEntityFromResults(
        result.data.results,
        anchor.type,
      );
      if (resolved.status === "resolved" && !seenIds.has(resolved.entity.entityId)) {
        resolvedAnchors.push({
          entityId: resolved.entity.entityId,
          name: resolved.entity.name,
        });
        seenIds.add(resolved.entity.entityId);
      }
    } catch {
      // Skip failed resolutions — deterministic fallback is best-effort
    }
  }

  if (resolvedAnchors.length === 0) {
    return {
      status: "empty",
      summary: `No verified recommendations for ${req.city}.`,
      recommendations: [],
      totalRecommendations: 0,
      invalidIds: [],
    };
  }

  const discoveryResult = await discoverFn({
    anchors: resolvedAnchors,
    city: req.city,
    signal,
  });

  const acceptedRecords = new Map<string, DiscoverPlacesResultEntry>();
  for (const candidate of discoveryResult.accepted) {
    const entry = candidateToEntry(candidate);
    if (entry.recommendation) {
      acceptedRecords.set(entry.entityId, entry);
    }
  }

  const validIds = [...acceptedRecords.keys()];
  return buildStructuredOutput(req.city, validIds, [], acceptedRecords);
}

// ── Error sanitization ───────────────────────────────────────

function sanitizeError(msg: string): string {
  if (/api.?key|secret|credential|token|password|authorization/i.test(msg)) {
    return "Service configuration error.";
  }
  return msg.slice(0, 200);
}

// ── Meta builder ─────────────────────────────────────────────

function buildMeta(
  partial: Partial<KitMeta> & { durationMs: number },
): KitMeta {
  return {
    runId: partial.runId ?? "",
    city: partial.city ?? "",
    anchorCount: partial.anchorCount ?? 0,
    mode: partial.mode ?? "agent",
    cached: partial.cached ?? false,
    durationMs: partial.durationMs,
  };
}

// ── Main handler ─────────────────────────────────────────────

export async function handleKitRequest(
  body: unknown,
  clientId: string,
  deps: KitHandlerDeps = {},
): Promise<{ response: KitResponse; httpStatus: number }> {
  const startMs = Date.now();
  const elapsed = () => Date.now() - startMs;
  const deadlineMs = deps.handlerDeadlineMs ?? DEFAULT_HANDLER_DEADLINE_MS;
  const remainingMs = () => Math.max(0, deadlineMs - elapsed());

  // Request-wide deadline — started at the earliest practical point.
  // Composed into every child scope (verification, agent, fallback).
  const requestAc = new AbortController();
  const requestTimer = setTimeout(() => requestAc.abort(), deadlineMs);

  try {
    return await handleKitRequestInner(
      body,
      clientId,
      deps,
      requestAc,
      startMs,
      elapsed,
      deadlineMs,
      remainingMs,
    );
  } finally {
    clearTimeout(requestTimer);
    // Ensure all child operations are cancelled on return
    if (!requestAc.signal.aborted) requestAc.abort();
  }
}

async function handleKitRequestInner(
  body: unknown,
  clientId: string,
  deps: KitHandlerDeps,
  requestAc: AbortController,
  startMs: number,
  elapsed: () => number,
  deadlineMs: number,
  remainingMs: () => number,
): Promise<{ response: KitResponse; httpStatus: number }> {
  // 1. Input validation
  const parsed = KitRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    return {
      httpStatus: 400,
      response: {
        status: "error",
        output: null,
        error: { code: "invalid_request", message: issues.join("; ") },
        meta: buildMeta({ durationMs: elapsed() }),
      },
    };
  }

  // 2. Rate limit
  if (checkRateLimit(clientId)) {
    return {
      httpStatus: 429,
      response: {
        status: "error",
        output: null,
        error: {
          code: "rate_limited",
          message: "Too many requests. Try again later.",
        },
        meta: buildMeta({ durationMs: elapsed() }),
      },
    };
  }

  const req = parsed.data;

  // 3. Cache check
  const cacheKey = buildCacheKey(req);
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      httpStatus: 200,
      response: {
        ...cached,
        meta: { ...cached.meta, cached: true, durationMs: elapsed() },
      },
    };
  }

  // 4. Verify confirmed anchors server-side (under request deadline)
  const searchFn = deps.searchEntity ?? defaultSearchEntity;
  let verifiedAnchors: VerifiedAnchor[] = [];
  if (req.confirmedAnchors && req.confirmedAnchors.length > 0) {
    try {
      const verification = await verifyConfirmedAnchors(
        req.confirmedAnchors,
        req.anchors,
        searchFn,
        requestAc.signal,
      );
      verifiedAnchors = verification.verified;
    } catch {
      // Verification interrupted by request deadline
      if (requestAc.signal.aborted) {
        return {
          httpStatus: 504,
          response: {
            status: "error",
            output: null,
            error: {
              code: "deadline_exceeded",
              message: "Request deadline expired during anchor verification.",
            },
            meta: buildMeta({
              city: req.city,
              anchorCount: req.anchors.length,
              durationMs: elapsed(),
            }),
          },
        };
      }
      // Non-deadline verification failure — proceed with no verified anchors
    }
  }

  // Check remaining time after verification, before starting agent.
  // If the request deadline is already expired, return immediately.
  if (requestAc.signal.aborted || remainingMs() === 0) {
    return {
      httpStatus: 504,
      response: {
        status: "error",
        output: null,
        error: {
          code: "deadline_exceeded",
          message: "Not enough time remaining after anchor verification.",
        },
        meta: buildMeta({
          city: req.city,
          anchorCount: req.anchors.length,
          durationMs: elapsed(),
        }),
      },
    };
  }

  // Build ConfirmedAnchor[] for the agent from verified anchors only
  const confirmedForAgent: ConfirmedAnchor[] = verifiedAnchors.map((va) => ({
    entityId: va.entityId,
    name: va.name,
  }));

  let mode: "agent" | "deterministic" = "agent";
  let output: StructuredOutput | undefined;
  let runId = crypto.randomUUID();

  // 5. Try the Bedrock agent with cancellation support
  const agentRunner =
    deps.runAgent ??
    ((input: AgentRunInput, signal?: AbortSignal) =>
      defaultRunAgent(input, undefined, signal));
  const timeoutMs = Math.min(
    deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    remainingMs(),
  );

  const agentAc = new AbortController();
  // Compose: request deadline cancels agent scope
  const onRequestAbortForAgent = () => agentAc.abort();
  requestAc.signal.addEventListener("abort", onRequestAbortForAgent, { once: true });
  if (requestAc.signal.aborted) agentAc.abort();

  try {
    const agentTimer = setTimeout(() => agentAc.abort(), timeoutMs);

    const result = await Promise.race([
      agentRunner(
        {
          city: req.city,
          anchors: req.anchors,
          confirmedAnchors: confirmedForAgent.length > 0
            ? confirmedForAgent
            : undefined,
        },
        agentAc.signal,
      ),
      new Promise<never>((_, reject) => {
        agentAc.signal.addEventListener("abort", () =>
          reject(new Error("Agent timeout")),
          { once: true },
        );
      }),
    ]).finally(() => clearTimeout(agentTimer));

    runId = result.runId;

    if (result.output) {
      const check = StructuredOutputSchema.safeParse(result.output);

      if (!check.success) {
        return {
          httpStatus: 500,
          response: {
            status: "error",
            output: null,
            error: {
              code: "output_validation_failed",
              message: "Internal output validation failed.",
            },
            meta: buildMeta({
              runId,
              city: req.city,
              anchorCount: req.anchors.length,
              mode: "agent",
              durationMs: elapsed(),
            }),
          },
        };
      }

      if (
        result.finalization &&
        result.finalization.recommendationCount > 0 &&
        result.output.recommendations.length === 0
      ) {
        return {
          httpStatus: 500,
          response: {
            status: "error",
            output: null,
            error: {
              code: "output_validation_failed",
              message: "Internal output validation produced unexpected result.",
            },
            meta: buildMeta({
              runId,
              city: req.city,
              anchorCount: req.anchors.length,
              mode: "agent",
              durationMs: elapsed(),
            }),
          },
        };
      }

      output = result.output;
    } else if (result.status === "output_validation_failed") {
      // The agent runner's buildStructuredOutput threw OutputValidationError.
      // Do not fall back — this is an internal failure, not a transient upstream error.
      return {
        httpStatus: 500,
        response: {
          status: "error",
          output: null,
          error: {
            code: "output_validation_failed",
            message: "Internal output validation failed.",
          },
          meta: buildMeta({
            runId,
            city: req.city,
            anchorCount: req.anchors.length,
            mode: "agent",
            durationMs: elapsed(),
          }),
        },
      };
    } else if (result.status !== "completed") {
      throw new Error(`Agent terminated: ${result.status}`);
    }
  } catch {
    if (!agentAc.signal.aborted) agentAc.abort();
    // If the request deadline fired, don't attempt fallback
    if (requestAc.signal.aborted) {
      return {
        httpStatus: 504,
        response: {
          status: "error",
          output: null,
          error: {
            code: "deadline_exceeded",
            message: "Request deadline expired during agent execution.",
          },
          meta: buildMeta({
            runId,
            city: req.city,
            anchorCount: req.anchors.length,
            mode: "agent",
            durationMs: elapsed(),
          }),
        },
      };
    }
    mode = "deterministic";
  } finally {
    requestAc.signal.removeEventListener("abort", onRequestAbortForAgent);
  }

  // 6. Deterministic fallback — only if enough time remains
  if (!output && mode === "deterministic") {
    if (remainingMs() < FALLBACK_MIN_MS) {
      return {
        httpStatus: 504,
        response: {
          status: "error",
          output: null,
          error: {
            code: "deadline_exceeded",
            message: "Not enough time remaining for fallback discovery.",
          },
          meta: buildMeta({
            runId,
            city: req.city,
            anchorCount: req.anchors.length,
            mode: "deterministic",
            durationMs: elapsed(),
          }),
        },
      };
    }

    const fallbackAc = new AbortController();
    // Compose: request deadline cancels fallback scope
    const onRequestAbortForFallback = () => fallbackAc.abort();
    requestAc.signal.addEventListener("abort", onRequestAbortForFallback, { once: true });
    if (requestAc.signal.aborted) fallbackAc.abort();
    const fallbackTimer = setTimeout(
      () => fallbackAc.abort(),
      remainingMs(),
    );

    try {
      output = await runFallback(
        req,
        verifiedAnchors,
        deps,
        fallbackAc.signal,
      );
    } catch (err) {
      if (err instanceof OutputValidationError) {
        return {
          httpStatus: 500,
          response: {
            status: "error",
            output: null,
            error: {
              code: "output_validation_failed",
              message: "Internal output validation failed.",
            },
            meta: buildMeta({
              runId,
              city: req.city,
              anchorCount: req.anchors.length,
              mode: "deterministic",
              durationMs: elapsed(),
            }),
          },
        };
      }
      if (requestAc.signal.aborted) {
        return {
          httpStatus: 504,
          response: {
            status: "error",
            output: null,
            error: {
              code: "deadline_exceeded",
              message: "Request deadline expired during fallback discovery.",
            },
            meta: buildMeta({
              runId,
              city: req.city,
              anchorCount: req.anchors.length,
              mode: "deterministic",
              durationMs: elapsed(),
            }),
          },
        };
      }
      const msg =
        err instanceof Error ? sanitizeError(err.message) : "Unknown error";
      return {
        httpStatus: 502,
        response: {
          status: "error",
          output: null,
          error: {
            code: "upstream_failure",
            message: `Discovery service is temporarily unavailable. ${msg}`,
          },
          meta: buildMeta({
            runId,
            city: req.city,
            anchorCount: req.anchors.length,
            mode: "deterministic",
            durationMs: elapsed(),
          }),
        },
      };
    } finally {
      clearTimeout(fallbackTimer);
      requestAc.signal.removeEventListener("abort", onRequestAbortForFallback);
    }
  }

  // 7. Default empty if agent completed but produced no output
  if (!output) {
    output = {
      status: "empty",
      summary: `No verified recommendations for ${req.city}.`,
      recommendations: [],
      totalRecommendations: 0,
      invalidIds: [],
    };
  }

  const kitResponse: KitResponse = {
    status: output.status,
    output,
    meta: buildMeta({
      runId,
      city: req.city,
      anchorCount: req.anchors.length,
      mode,
      cached: false,
      durationMs: elapsed(),
    }),
  };

  setCache(cacheKey, kitResponse);

  return { httpStatus: 200, response: kitResponse };
}
