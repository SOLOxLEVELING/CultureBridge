import { z } from "zod";
import { runAgent as defaultRunAgent } from "../agent";
import type { AgentRunInput, AgentRunResult } from "../agent";
import { discover as defaultDiscover } from "../discover";
import type { CulturalAnchor, DiscoveryInput } from "../discover";
import { searchEntity as defaultSearchEntity } from "../qloo/client";
import type { QlooResult } from "../qloo/client";
import type { SearchResponse } from "../qloo/schemas";
import { resolveEntityFromResults } from "../qloo/resolver";
import { candidateToEntry } from "../bedrock";
import type { DiscoverPlacesResultEntry } from "../bedrock";
import { buildStructuredOutput, StructuredOutputSchema } from "../output";
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
// Caches only schema-validated successful outputs.
// Instance-local: each serverless instance has its own cache.
// On Vercel, cold starts clear the cache; this is acceptable
// for the hackathon deployment stage.

interface CacheEntry {
  response: KitResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const responseCache = new Map<string, CacheEntry>();

export function buildCacheKey(req: KitRequest): string {
  const city = req.city.toLowerCase().trim();
  const anchors = req.anchors
    .map((a) => `${a.query.toLowerCase().trim()}|${a.type.trim()}`)
    .sort()
    .join(";");
  const confirmed = (req.confirmedAnchors ?? [])
    .map((c) => c.entityId)
    .sort()
    .join(";");
  return `kit:${city}::${anchors}::${confirmed}`;
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
// 10 requests per 60-second window per client identifier.
// Instance-local: each serverless instance tracks independently.
// On Vercel with multiple instances, effective rate is multiplied
// by instance count. Acceptable for the hackathon stage.

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;

const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  let timestamps = rateBuckets.get(clientId);
  if (!timestamps) {
    timestamps = [];
    rateBuckets.set(clientId, timestamps);
  }
  while (timestamps.length > 0 && now - timestamps[0] >= RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT) return true;
  timestamps.push(now);
  return false;
}

export function clearRateLimits(): void {
  rateBuckets.clear();
}

// ── Injectable dependencies ──────────────────────────────────

export interface KitHandlerDeps {
  runAgent?: (input: AgentRunInput) => Promise<AgentRunResult>;
  searchEntity?: (
    query: string,
    take?: number,
    signal?: AbortSignal,
  ) => Promise<QlooResult<SearchResponse>>;
  discover?: (input: DiscoveryInput) => Promise<import("../discover").DiscoveryResult>;
  agentTimeoutMs?: number;
}

const DEFAULT_AGENT_TIMEOUT_MS = 12_000;

// ── Deterministic fallback ───────────────────────────────────
// Reuses the existing discovery, validation, labeling, and
// output-builder pipeline. Does NOT use the Bedrock agent loop.

async function runFallback(
  req: KitRequest,
  deps: KitHandlerDeps,
): Promise<StructuredOutput> {
  const searchFn = deps.searchEntity ?? defaultSearchEntity;
  const discoverFn = deps.discover ?? defaultDiscover;

  const resolvedAnchors: CulturalAnchor[] = [];
  const seenIds = new Set<string>();

  for (const c of req.confirmedAnchors ?? []) {
    if (!seenIds.has(c.entityId)) {
      resolvedAnchors.push({ entityId: c.entityId, name: c.name });
      seenIds.add(c.entityId);
    }
  }

  for (const anchor of req.anchors) {
    try {
      const result = await searchFn(anchor.query);
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

  // 1. Input validation — cheap, runs before rate-limit so
  //    malformed requests don't consume rate-limit slots
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

  // 2. Rate limit — checked before any expensive work
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

  let mode: "agent" | "deterministic" = "agent";
  let output: StructuredOutput | undefined;
  let runId = crypto.randomUUID();

  // 4. Try the Bedrock agent
  const agentRunner = deps.runAgent ?? defaultRunAgent;
  const timeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  try {
    let agentTimer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      agentRunner({
        city: req.city,
        anchors: req.anchors,
        confirmedAnchors: req.confirmedAnchors,
      }),
      new Promise<never>((_, reject) => {
        agentTimer = setTimeout(
          () => reject(new Error("Agent timeout")),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(agentTimer!));

    runId = result.runId;

    if (result.output) {
      const check = StructuredOutputSchema.safeParse(result.output);

      if (!check.success) {
        // Schema validation failed at API boundary
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

      // Detect internal validation collapse: agent finalized with
      // recommendations but builder produced empty output
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
    } else if (result.status !== "completed") {
      // Agent terminated without output — fall through to fallback
      throw new Error(`Agent terminated: ${result.status}`);
    }
  } catch {
    mode = "deterministic";
  }

  // 5. Deterministic fallback
  if (!output && mode === "deterministic") {
    try {
      output = await runFallback(req, deps);
    } catch (err) {
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
    }
  }

  // 6. Default empty if agent completed but produced no output
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

  // 7. Cache only validated successful outputs (not errors)
  setCache(cacheKey, kitResponse);

  return { httpStatus: 200, response: kitResponse };
}
