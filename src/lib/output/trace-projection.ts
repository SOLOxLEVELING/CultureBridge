import { z } from "zod";
import type { FallbackStage, TerminationReason, TraceEvent, TraceEventStatus } from "../agent/runner";

// ── Allowlisted schemas for public search process projection ──

export const PublicCacheStatusSchema = z.enum(["cached", "live", "mixed"]);
export type PublicCacheStatus = z.infer<typeof PublicCacheStatusSchema>;

export const PublicStepKindSchema = z.enum([
  "anchor_verification",
  "anchor_resolution",
  "place_discovery",
  "tag_lookup",
  "fallback_step",
  "output_verification",
  "agent_planning",
  "completion",
]);
export type PublicStepKind = z.infer<typeof PublicStepKindSchema>;

export const PublicStepStatusSchema = z.enum([
  "ok",
  "warning",
  "recovered",
  "skipped",
  "failed",
]);
export type PublicStepStatus = z.infer<typeof PublicStepStatusSchema>;

export const PublicQueryScopeSchema = z.enum([
  "single-anchor",
  "blended",
  "single-and-blended",
]);
export type PublicQueryScope = z.infer<typeof PublicQueryScopeSchema>;

export const PublicStepCountsSchema = z.strictObject({
  accepted: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  rejectedReasons: z.record(z.string(), z.number().int().nonnegative()),
});
export type PublicStepCounts = z.infer<typeof PublicStepCountsSchema>;

export const PublicFallbackDetailSchema = z.strictObject({
  stage: z.enum(["triggered", "alt_tag", "drop_tag", "broaden", "exhausted", "deterministic"]),
  stageLabel: z.string(),
  reason: z.string(),
  recovered: z.boolean(),
  originalCategory: z.string().nullable(),
  alternativeCategory: z.string().nullable(),
});
export type PublicFallbackDetail = z.infer<typeof PublicFallbackDetailSchema>;

export const PublicSearchStepSchema = z.strictObject({
  stepNumber: z.number().int().positive(),
  attemptNumber: z.number().int().positive(),
  kind: PublicStepKindSchema,
  title: z.string(),
  detail: z.string(),
  status: PublicStepStatusSchema,
  durationMs: z.number().int().nonnegative(),
  cacheStatus: PublicCacheStatusSchema.nullable(),
  queryScope: PublicQueryScopeSchema.nullable(),
  anchorCount: z.number().int().nonnegative().nullable(),
  categoryTag: z.string().nullable(),
  counts: PublicStepCountsSchema.nullable(),
  fallback: PublicFallbackDetailSchema.nullable(),
});
export type PublicSearchStep = z.infer<typeof PublicSearchStepSchema>;

export const PublicProcessOutcomeSchema = z.enum([
  "completed",
  "partial",
  "empty",
  "timeout",
  "error",
]);
export type PublicProcessOutcome = z.infer<typeof PublicProcessOutcomeSchema>;

export const PublicSearchProcessSchema = z.strictObject({
  city: z.string(),
  qlooGrounded: z.boolean(),
  mode: z.enum(["agent", "deterministic"]),
  modeLabel: z.string(),
  fallbackTriggered: z.boolean(),
  fallbackReason: z.string().nullable(),
  fallbackRecovered: z.boolean(),
  cached: z.boolean(),
  qlooCacheStatus: PublicCacheStatusSchema,
  durationMs: z.number().int().nonnegative(),
  outcome: PublicProcessOutcomeSchema,
  outcomeSummary: z.string(),
  totals: PublicStepCountsSchema,
  steps: z.array(PublicSearchStepSchema),
});
export type PublicSearchProcess = z.infer<typeof PublicSearchProcessSchema>;

// ── Sanitization & allowlist helpers ─────────────────────────

const FORBIDDEN_TOKEN_PATTERN =
  /api.?key|\bsecret\b|credential|\btoken\b|password|authorization|bearer|x-api-key|qloo_api_key|aws_access_key|aws_secret|sk-[a-z0-9_-]+|hackathon\.api\.qloo\.com|\/v2\/insights|toolCallCount|qlooOutboundRequests|finalization|\btrace\b|https?:\/\/[^\s]+/i;

const ALLOWED_REJECTION_REASONS: Record<string, string> = {
  closed: "closed",
  hotel_accommodation: "hotel_accommodation",
  transit_airport: "transit_airport",
  missing_name: "missing_name",
  duplicate: "duplicate",
  category_conflict: "category_conflict",
  weak_category_evidence: "weak_category_evidence",
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  "urn:entity:artist": "Artist",
  "urn:entity:tv_show": "TV show",
  "urn:entity:movie": "Movie",
  "urn:entity:brand": "Brand",
  "urn:entity:person": "Person",
};

const ALLOWED_TRACE_STATUSES = new Set<TraceEventStatus>([
  "success",
  "validation_error",
  "execution_error",
  "timeout",
  "budget_blocked",
  "city_mismatch",
  "untrusted_anchor",
  "filtered_ids",
  "info",
  "fallback_triggered",
  "fallback_success",
  "fallback_no_results",
  "fallback_skipped",
  "fallback_exhausted",
  "duplicate_blocked",
]);

const ALLOWED_FALLBACK_STAGES = new Set<FallbackStage>([
  "alt_tag",
  "drop_tag",
  "broaden",
]);

const ALLOWED_TERMINATION_REASONS = new Set<TerminationReason>([
  "completed",
  "call_limit_reached",
  "total_timeout",
  "qloo_budget_exhausted",
  "model_error",
  "invalid_finalization",
  "output_validation_failed",
  "malformed_response",
  "content_filtered",
]);

export function sanitizePublicText(raw: unknown, fallback: string = ""): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  if (FORBIDDEN_TOKEN_PATTERN.test(trimmed)) {
    return fallback || "Redacted value";
  }
  if (/\d+\s*%|\bconfidence\b/i.test(trimmed)) {
    return fallback || "Redacted value";
  }
  return trimmed.slice(0, 120);
}

function sanitizeDuration(val: unknown): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return 0;
  return Math.round(val);
}

function sanitizeCount(val: unknown): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return 0;
  return Math.floor(val);
}

export function sanitizeRejectedReasons(
  raw: unknown,
): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const count = sanitizeCount(value);
    if (count <= 0) continue;
    const normalizedKey = ALLOWED_REJECTION_REASONS[key] ?? "other";
    result[normalizedKey] = (result[normalizedKey] ?? 0) + count;
  }
  return result;
}

export function formatRejectionReasonLabel(reasonKey: string): string {
  switch (reasonKey) {
    case "hotel_accommodation":
      return "hotel / lodging";
    case "transit_airport":
      return "transit / station";
    case "closed":
      return "closed venue";
    case "duplicate":
      return "duplicate entity";
    case "category_conflict":
      return "conflicting primary category";
    case "missing_name":
      return "missing venue name";
    case "weak_category_evidence":
      return "weak category evidence";
    default:
      return "validation rule";
  }
}

function formatRejectionSummary(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).filter(([, c]) => c > 0);
  if (entries.length === 0) return "";
  const parts = entries.map(
    ([key, count]) => `${count} ${formatRejectionReasonLabel(key)}`,
  );
  return ` (${parts.join(", ")})`;
}

function formatTagSlug(rawTagId: unknown): string | null {
  if (typeof rawTagId !== "string") return null;
  const trimmed = rawTagId.trim();
  if (!trimmed.startsWith("urn:tag:")) return null;
  const parts = trimmed.split(":");
  const last = parts[parts.length - 1] ?? "";
  const cleaned = last.replace(/_/g, " ").trim();
  return sanitizePublicText(cleaned, "") || null;
}

function formatEntityTypeLabel(rawType: unknown): string {
  if (typeof rawType !== "string") return "Entity";
  if (rawType in ENTITY_TYPE_LABELS) {
    return ENTITY_TYPE_LABELS[rawType];
  }
  if (rawType.startsWith("urn:entity:")) {
    const slug = rawType.slice("urn:entity:".length).replace(/_/g, " ");
    return sanitizePublicText(slug, "Entity");
  }
  return "Entity";
}

function formatFallbackStageLabel(stage: FallbackStage): string {
  switch (stage) {
    case "alt_tag":
      return "Stage 1 · Grounded alternative category tag";
    case "drop_tag":
      return "Stage 2 · Drop category filter & classify from entity tags";
    case "broaden":
      return "Stage 3 · Broaden anchor set";
  }
}

function describeAgentFallbackReason(
  terminationReason?: TerminationReason,
  agentErrorOccurred?: boolean,
): string {
  switch (terminationReason) {
    case "total_timeout":
      return "Agent run reached its time budget; switched to deterministic Qloo discovery.";
    case "call_limit_reached":
      return "Agent reached the 12-call limit without finalizing; switched to deterministic Qloo discovery.";
    case "qloo_budget_exhausted":
      return "Agent Qloo request budget was reached; switched to deterministic Qloo discovery.";
    case "invalid_finalization":
      return "Agent candidate selection referenced unverified IDs; switched to deterministic Qloo discovery.";
    case "malformed_response":
    case "content_filtered":
    case "model_error":
      return "Bedrock agent orchestration was unavailable; ran deterministic Qloo discovery directly.";
    default:
      return agentErrorOccurred
        ? "Bedrock agent orchestration timed out or was unavailable; ran deterministic Qloo discovery directly."
        : "Ran deterministic Qloo discovery pipeline directly.";
  }
}

// ── Input contract for projection ────────────────────────────

export interface DeterministicDiscoverySummary {
  resolvedAnchorNames: string[];
  unresolvedCount: number;
  singleAnchorQueriesCount: number;
  blendedQueryRun: boolean;
  acceptedCount: number;
  reviewCount: number;
  rejectedCount: number;
  rejectedReasons: Record<string, number>;
  failureCount: number;
}

export interface TraceProjectionInput {
  city?: string;
  mode?: "agent" | "deterministic";
  cached?: boolean;
  durationMs?: number;
  outcome?: PublicProcessOutcome;
  anchorCount?: number;
  verifiedAnchors?: readonly { name: string }[];
  rejectedConfirmationsCount?: number;
  agentTerminationReason?: TerminationReason;
  agentFailedBeforeFallback?: boolean;
  traceEvents?: readonly unknown[];
  deterministicDiscovery?: DeterministicDiscoverySummary;
}

// ── Main projection function ─────────────────────────────────

export function projectPublicTrace(
  inputOrEvents: TraceProjectionInput | readonly unknown[],
  options?: Omit<TraceProjectionInput, "traceEvents">,
): PublicSearchProcess {
  const input: TraceProjectionInput = Array.isArray(inputOrEvents)
    ? { ...(options ?? {}), traceEvents: inputOrEvents }
    : (inputOrEvents as TraceProjectionInput);

  const city = sanitizePublicText(input.city, "Selected city");
  const mode: "agent" | "deterministic" =
    input.mode === "deterministic" ? "deterministic" : "agent";
  const cached = Boolean(input.cached);
  const durationMs = sanitizeDuration(input.durationMs);
  const rawEvents = Array.isArray(input.traceEvents) ? input.traceEvents : [];

  const steps: PublicSearchStep[] = [];
  let nextStepNumber = 1;
  const attemptCounts = new Map<string, number>();

  let totalAccepted = 0;
  let totalReview = 0;
  let totalRejected = 0;
  const totalRejectedReasons: Record<string, number> = {};

  let anyFallbackTriggered = mode === "deterministic";
  let anyFallbackRecovered = false;
  let observedLiveCalls = 0;
  let observedCacheHits = 0;
  let prevQlooOutbound = 0;
  let prevQlooCacheHits = 0;
  let observedTerminationReason: TerminationReason | undefined =
    input.agentTerminationReason &&
    ALLOWED_TERMINATION_REASONS.has(input.agentTerminationReason)
      ? input.agentTerminationReason
      : undefined;

  function bumpAttempt(key: string): number {
    const next = (attemptCounts.get(key) ?? 0) + 1;
    attemptCounts.set(key, next);
    return next;
  }

  function accumulateCounts(counts: PublicStepCounts): void {
    totalAccepted += counts.accepted;
    totalReview += counts.review;
    totalRejected += counts.rejected;
    for (const [k, v] of Object.entries(counts.rejectedReasons)) {
      totalRejectedReasons[k] = (totalRejectedReasons[k] ?? 0) + v;
    }
  }

  // 1. Server-side confirmed anchor verification step (if verified anchors provided)
  if (input.verifiedAnchors && input.verifiedAnchors.length > 0) {
    const safeNames = input.verifiedAnchors
      .map((a) => sanitizePublicText(a?.name, "Confirmed anchor"))
      .filter(Boolean);
    const rejectedConf = sanitizeCount(input.rejectedConfirmationsCount);
    const attempt = bumpAttempt("anchor_verification");

    steps.push({
      stepNumber: nextStepNumber++,
      attemptNumber: attempt,
      kind: "anchor_verification",
      title: `Verified ${safeNames.length} confirmed ${safeNames.length === 1 ? "anchor" : "anchors"} in Qloo`,
      detail: `Re-verified exact Qloo entity IDs for ${safeNames.join(", ")}${rejectedConf > 0 ? ` (${rejectedConf} unverified selection rejected)` : ""}.`,
      status: "ok",
      durationMs: 0,
      cacheStatus: "live",
      queryScope: null,
      anchorCount: safeNames.length,
      categoryTag: null,
      counts: null,
      fallback: null,
    });
  }

  // 2. Process allowlisted agent TraceEvent items in sequence
  for (const rawItem of rawEvents) {
    if (typeof rawItem !== "object" || rawItem === null) continue;
    const ev = rawItem as Partial<TraceEvent> & Record<string, unknown>;

    const evType = ev.type;
    if (
      evType !== "model_call" &&
      evType !== "tool_dispatch" &&
      evType !== "fallback" &&
      evType !== "termination"
    ) {
      continue;
    }

    const evStatus: TraceEventStatus =
      typeof ev.status === "string" &&
      ALLOWED_TRACE_STATUSES.has(ev.status as TraceEventStatus)
        ? (ev.status as TraceEventStatus)
        : "info";

    const stepDuration = sanitizeDuration(ev.durationMs);

    if (
      typeof ev.terminationReason === "string" &&
      ALLOWED_TERMINATION_REASONS.has(ev.terminationReason as TerminationReason)
    ) {
      observedTerminationReason = ev.terminationReason as TerminationReason;
    }

    // Track Qloo outbound vs cache hit deltas from allowlisted numeric counters
    let stepCacheStatus: PublicCacheStatus | null = null;
    const curOutbound =
      typeof ev.qlooRequestsMade === "number" && Number.isFinite(ev.qlooRequestsMade)
        ? Math.max(0, Math.floor(ev.qlooRequestsMade))
        : null;
    const curCacheHits =
      typeof ev.qlooCacheHits === "number" && Number.isFinite(ev.qlooCacheHits)
        ? Math.max(0, Math.floor(ev.qlooCacheHits))
        : null;

    const deltaOutbound =
      curOutbound !== null ? Math.max(0, curOutbound - prevQlooOutbound) : 0;
    const deltaCache =
      curCacheHits !== null ? Math.max(0, curCacheHits - prevQlooCacheHits) : 0;
    if (curOutbound !== null) prevQlooOutbound = curOutbound;
    if (curCacheHits !== null) prevQlooCacheHits = curCacheHits;

    if (ev.cached === true) {
      stepCacheStatus = "cached";
      observedCacheHits += Math.max(1, deltaCache);
    } else if (curOutbound !== null || curCacheHits !== null) {
      observedLiveCalls += deltaOutbound;
      observedCacheHits += deltaCache;

      if (deltaCache > 0 && deltaOutbound > 0) stepCacheStatus = "mixed";
      else if (deltaCache > 0) stepCacheStatus = "cached";
      else if (deltaOutbound > 0) stepCacheStatus = "live";
    }

    // ── 2a. Model orchestration call ──
    if (evType === "model_call") {
      if (evStatus === "timeout" || evStatus === "execution_error") {
        const attempt = bumpAttempt("model_call");
        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "agent_planning",
          title:
            evStatus === "timeout"
              ? "Agent planning step timed out"
              : "Agent planning step stopped safely",
          detail:
            evStatus === "timeout"
              ? "Bedrock Converse step exceeded its per-operation time budget."
              : "Bedrock Converse step encountered an upstream error; no unverified data was used.",
          status: "failed",
          durationMs: stepDuration,
          cacheStatus: null,
          queryScope: null,
          anchorCount: null,
          categoryTag: null,
          counts: null,
          fallback: null,
        });
      }
      continue;
    }

    // ── 2b. Tool dispatch ──
    if (evType === "tool_dispatch") {
      const toolName = typeof ev.toolName === "string" ? ev.toolName : "";
      const rawInput =
        typeof ev.toolInput === "object" && ev.toolInput !== null
          ? (ev.toolInput as Record<string, unknown>)
          : {};

      if (toolName === "resolve_anchor") {
        const safeQuery = sanitizePublicText(rawInput.query, "cultural anchor");
        const typeLabel = formatEntityTypeLabel(rawInput.type);
        const attempt = bumpAttempt(`resolve:${safeQuery.toLowerCase()}:${typeLabel}`);
        const attemptSuffix = attempt > 1 ? ` (attempt #${attempt})` : "";

        let status: PublicStepStatus = "ok";
        let detail = `Resolved "${safeQuery}" as ${typeLabel} via Qloo entity search.`;
        if (evStatus === "timeout") {
          status = "failed";
          detail = `Qloo entity lookup for "${safeQuery}" timed out.`;
        } else if (evStatus === "budget_blocked") {
          status = "skipped";
          detail = `Skipped lookup for "${safeQuery}" because the call or Qloo request limit was reached.`;
        } else if (evStatus !== "success") {
          status = "failed";
          detail = `Qloo entity lookup for "${safeQuery}" did not complete.`;
        }

        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "anchor_resolution",
          title: `Qloo anchor lookup: "${safeQuery}" (${typeLabel})${attemptSuffix}`,
          detail,
          status,
          durationMs: stepDuration,
          cacheStatus: stepCacheStatus ?? (evStatus === "success" ? "live" : null),
          queryScope: null,
          anchorCount: 1,
          categoryTag: null,
          counts: null,
          fallback: null,
        });
        continue;
      }

      if (toolName === "discover_places") {
        const anchorIds = Array.isArray(rawInput.anchor_ids)
          ? rawInput.anchor_ids
          : [];
        const anchorCount = Math.min(Math.max(anchorIds.length, 0), 10);
        const categoryTag = formatTagSlug(rawInput.category_tag_id);
        const attemptKey = `discover:${categoryTag ?? "broad"}:${anchorCount}`;
        const attempt = bumpAttempt(attemptKey);
        const attemptSuffix = attempt > 1 ? ` (attempt #${attempt})` : "";

        const counts: PublicStepCounts | null =
          evStatus === "success"
            ? {
                accepted: sanitizeCount(ev.acceptedCount),
                review: sanitizeCount(ev.reviewCount),
                rejected: sanitizeCount(ev.rejectedCount),
                rejectedReasons: sanitizeRejectedReasons(ev.rejectedReasons),
              }
            : null;

        if (counts) {
          accumulateCounts(counts);
        }

        let status: PublicStepStatus = "ok";
        let title = `Qloo place discovery in ${city}${categoryTag ? ` · ${categoryTag}` : " (broad)"}${attemptSuffix}`;
        let detail = "";

        if (evStatus === "success" && counts) {
          status = counts.accepted > 0 ? "ok" : "warning";
          const queryDesc =
            anchorCount > 0
              ? `Ran ${anchorCount} single-anchor Qloo ${anchorCount === 1 ? "query" : "queries"} + 1 blended profile query`
              : "Ran Qloo taste-graph insights queries";
          detail = `${queryDesc}${categoryTag ? ` filtered by "${categoryTag}"` : ""}. Validator accepted ${counts.accepted}, held ${counts.review} for review, and rejected ${counts.rejected}${formatRejectionSummary(counts.rejectedReasons)}.`;
        } else if (evStatus === "city_mismatch") {
          status = "failed";
          title = `Blocked out-of-scope city query${attemptSuffix}`;
          detail = `Trust guard restricted place discovery to ${city}.`;
        } else if (evStatus === "untrusted_anchor") {
          status = "failed";
          title = `Blocked unconfirmed anchor entity ID${attemptSuffix}`;
          detail = "Trust guard rejected discovery using an unconfirmed anchor ID.";
        } else if (evStatus === "duplicate_blocked") {
          status = "skipped";
          title = `Skipped duplicate exhausted discovery objective${attemptSuffix}`;
          detail = "This anchor and category combination already completed its fallback chain.";
        } else if (evStatus === "budget_blocked") {
          status = "skipped";
          title = `Discovery skipped · request budget reached${attemptSuffix}`;
          detail = "Hard tool-call or Qloo request ceiling prevented an additional query.";
        } else if (evStatus === "timeout") {
          status = "failed";
          detail = "Qloo place discovery timed out before completion.";
        } else {
          status = "failed";
          detail = "Qloo place discovery encountered an error and was safely skipped.";
        }

        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "place_discovery",
          title,
          detail,
          status,
          durationMs: stepDuration,
          cacheStatus: stepCacheStatus ?? (evStatus === "success" ? "live" : null),
          queryScope: "single-and-blended",
          anchorCount: anchorCount > 0 ? anchorCount : null,
          categoryTag,
          counts,
          fallback: null,
        });
        continue;
      }

      if (toolName === "find_tags") {
        const safeQuery = sanitizePublicText(rawInput.query, "category");
        const attempt = bumpAttempt(`find_tags:${safeQuery.toLowerCase()}`);
        const attemptSuffix = attempt > 1 ? ` (attempt #${attempt})` : "";

        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "tag_lookup",
          title: `Qloo category tag lookup: "${safeQuery}"${attemptSuffix}`,
          detail:
            evStatus === "success"
              ? `Searched Qloo /v2/tags for grounded place-category tags matching "${safeQuery}".`
              : `Category tag lookup for "${safeQuery}" did not return usable tags.`,
          status: evStatus === "success" ? "ok" : "warning",
          durationMs: stepDuration,
          cacheStatus: stepCacheStatus ?? (evStatus === "success" ? "live" : null),
          queryScope: null,
          anchorCount: null,
          categoryTag: safeQuery,
          counts: null,
          fallback: null,
        });
        continue;
      }

      if (toolName === "finalize") {
        // NEVER read rawInput.summary or rawInput.recommendation_ids
        const attempt = bumpAttempt(`output_verification:${evStatus}`);
        if (evStatus === "filtered_ids") {
          steps.push({
            stepNumber: nextStepNumber++,
            attemptNumber: attempt,
            kind: "output_verification",
            title: "Filtered unverified candidate IDs",
            detail:
              "Removed candidate IDs that were not present in the validator's accepted set.",
            status: "warning",
            durationMs: stepDuration,
            cacheStatus: null,
            queryScope: null,
            anchorCount: null,
            categoryTag: null,
            counts: null,
            fallback: null,
          });
        } else if (evStatus === "success") {
          steps.push({
            stepNumber: nextStepNumber++,
            attemptNumber: attempt,
            kind: "output_verification",
            title: "Verified structured output & explanations",
            detail:
              "Validated output schema, deterministic evidence labels, and grounded explanation text.",
            status: "ok",
            durationMs: stepDuration,
            cacheStatus: null,
            queryScope: null,
            anchorCount: null,
            categoryTag: null,
            counts: null,
            fallback: null,
          });
        } else {
          steps.push({
            stepNumber: nextStepNumber++,
            attemptNumber: attempt,
            kind: "output_verification",
            title: "Candidate selection rejected by output verifier",
            detail:
              "Candidate selection did not pass deterministic verification.",
            status: "failed",
            durationMs: stepDuration,
            cacheStatus: null,
            queryScope: null,
            anchorCount: null,
            categoryTag: null,
            counts: null,
            fallback: null,
          });
        }
        continue;
      }

      continue;
    }

    // ── 2c. Fallback chain event ──
    if (evType === "fallback") {
      anyFallbackTriggered = true;
      const rawStage =
        typeof ev.fallbackStage === "string" &&
        ALLOWED_FALLBACK_STAGES.has(ev.fallbackStage as FallbackStage)
          ? (ev.fallbackStage as FallbackStage)
          : null;
      const origCategory = formatTagSlug(ev.originalTagId);
      const altCategory = formatTagSlug(ev.alternativeTagId);
      const anchorCount = Array.isArray(ev.anchorIdsUsed)
        ? Math.min(ev.anchorIdsUsed.length, 10)
        : null;

      const hasCounts =
        typeof ev.acceptedCount === "number" ||
        typeof ev.reviewCount === "number" ||
        typeof ev.rejectedCount === "number";
      const counts: PublicStepCounts | null = hasCounts
        ? {
            accepted: sanitizeCount(ev.acceptedCount),
            review: sanitizeCount(ev.reviewCount),
            rejected: sanitizeCount(ev.rejectedCount),
            rejectedReasons: sanitizeRejectedReasons(ev.rejectedReasons),
          }
        : null;

      if (counts) {
        accumulateCounts(counts);
      }

      const recovered =
        evStatus === "fallback_success" && (counts?.accepted ?? 0) > 0;
      if (recovered) {
        anyFallbackRecovered = true;
      }

      const attemptKey = `fallback:${rawStage ?? evStatus}:${origCategory ?? ""}:${altCategory ?? ""}`;
      const attempt = bumpAttempt(attemptKey);

      if (evStatus === "fallback_triggered") {
        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "fallback_step",
          title: `Fallback triggered${origCategory ? ` for "${origCategory}"` : ""}`,
          detail:
            "Initial category discovery returned 0 accepted places; starting approved deterministic fallback chain.",
          status: "warning",
          durationMs: stepDuration,
          cacheStatus: null,
          queryScope: null,
          anchorCount,
          categoryTag: origCategory,
          counts: null,
          fallback: {
            stage: "triggered",
            stageLabel: "Fallback chain initiated",
            reason: "Initial query returned 0 accepted places after validation.",
            recovered: false,
            originalCategory: origCategory,
            alternativeCategory: null,
          },
        });
        continue;
      }

      if (evStatus === "fallback_exhausted") {
        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "fallback_step",
          title: `Fallback stages completed${origCategory ? ` for "${origCategory}"` : ""} with 0 accepted places`,
          detail:
            "All approved fallback stages ran without finding verifiable places for this objective.",
          status: "warning",
          durationMs: stepDuration,
          cacheStatus: null,
          queryScope: null,
          anchorCount,
          categoryTag: origCategory,
          counts: null,
          fallback: {
            stage: "exhausted",
            stageLabel: "All fallback stages attempted",
            reason: "No fallback stage produced accepted places.",
            recovered: false,
            originalCategory: origCategory,
            alternativeCategory: null,
          },
        });
        continue;
      }

      if (rawStage) {
        const stageLabel = formatFallbackStageLabel(rawStage);
        let status: PublicStepStatus = "warning";
        let title = stageLabel;
        let reason = "";
        let detail = "";

        if (rawStage === "alt_tag") {
          const isKnownEmptyCoffee =
            ev.originalTagId === "urn:tag:category:place:coffee";
          if (evStatus === "fallback_skipped") {
            status = "skipped";
            title = `${stageLabel} · Skipped`;
            reason = isKnownEmptyCoffee
              ? "Known empty Qloo tag (coffee); skipped directly to Stage 2."
              : "No grounded alternative place-category tag available in Qloo.";
            detail = reason;
          } else if (evStatus === "budget_blocked") {
            status = "skipped";
            title = `${stageLabel} · Budget reached`;
            reason = "Stopped due to tool-call or Qloo request budget.";
            detail = reason;
          } else if (recovered && counts) {
            status = "recovered";
            title = `${stageLabel} · Recovered ${counts.accepted} ${counts.accepted === 1 ? "place" : "places"}`;
            reason = `Queried grounded alternative tag${altCategory ? ` "${altCategory}"` : ""}.`;
            detail = `${reason} Validator accepted ${counts.accepted}, held ${counts.review} for review, and rejected ${counts.rejected}${formatRejectionSummary(counts.rejectedReasons)}.`;
          } else {
            status = "warning";
            title = `${stageLabel} · 0 accepted places`;
            reason = `Tried alternative tag${altCategory ? ` "${altCategory}"` : ""} but 0 places passed validation.`;
            detail = counts
              ? `${reason} (${counts.review} review, ${counts.rejected} rejected${formatRejectionSummary(counts.rejectedReasons)}).`
              : reason;
          }
        } else if (rawStage === "drop_tag") {
          if (evStatus === "budget_blocked") {
            status = "skipped";
            title = `${stageLabel} · Budget reached`;
            reason = "Stopped due to tool-call or Qloo request budget.";
            detail = reason;
          } else if (recovered && counts) {
            status = "recovered";
            title = `${stageLabel} · Recovered ${counts.accepted} ${counts.accepted === 1 ? "place" : "places"}`;
            reason = `Dropped category filter${origCategory ? ` "${origCategory}"` : ""} and classified from Qloo entity tags.`;
            detail = `${reason} Validator accepted ${counts.accepted}, held ${counts.review} for review, and rejected ${counts.rejected}${formatRejectionSummary(counts.rejectedReasons)}.`;
          } else {
            status = "warning";
            title = `${stageLabel} · 0 accepted places`;
            reason = `Dropped category filter${origCategory ? ` "${origCategory}"` : ""} but 0 places passed validation.`;
            detail = counts
              ? `${reason} (${counts.review} review, ${counts.rejected} rejected${formatRejectionSummary(counts.rejectedReasons)}).`
              : reason;
          }
        } else if (rawStage === "broaden") {
          if (evStatus === "fallback_skipped") {
            status = "skipped";
            title = `${stageLabel} · Skipped`;
            reason = "No additional confirmed anchors available to broaden the query.";
            detail = reason;
          } else if (evStatus === "budget_blocked") {
            status = "skipped";
            title = `${stageLabel} · Budget reached`;
            reason = "Stopped due to Qloo request or time budget.";
            detail = reason;
          } else if (recovered && counts) {
            status = "recovered";
            title = `${stageLabel} · Recovered ${counts.accepted} ${counts.accepted === 1 ? "place" : "places"}`;
            reason = `Broadened Qloo query across ${anchorCount ?? "all"} confirmed anchors.`;
            detail = `${reason} Validator accepted ${counts.accepted}, held ${counts.review} for review, and rejected ${counts.rejected}${formatRejectionSummary(counts.rejectedReasons)}.`;
          } else {
            status = "warning";
            title = `${stageLabel} · 0 accepted places`;
            reason = "Broadened anchor set returned 0 accepted places after validation.";
            detail = counts
              ? `${reason} (${counts.review} review, ${counts.rejected} rejected${formatRejectionSummary(counts.rejectedReasons)}).`
              : reason;
          }
        }

        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "fallback_step",
          title,
          detail,
          status,
          durationMs: stepDuration,
          cacheStatus: stepCacheStatus,
          queryScope:
            rawStage === "drop_tag" || rawStage === "broaden" || rawStage === "alt_tag"
              ? "single-and-blended"
              : null,
          anchorCount,
          categoryTag: altCategory ?? origCategory,
          counts,
          fallback: {
            stage: rawStage,
            stageLabel,
            reason,
            recovered,
            originalCategory: origCategory,
            alternativeCategory: altCategory,
          },
        });
      }
      continue;
    }

    // ── 2d. Termination event ──
    if (evType === "termination") {
      if (
        observedTerminationReason &&
        observedTerminationReason !== "completed"
      ) {
        const attempt = bumpAttempt(`termination:${observedTerminationReason}`);
        steps.push({
          stepNumber: nextStepNumber++,
          attemptNumber: attempt,
          kind: "completion",
          title:
            observedTerminationReason === "total_timeout"
              ? "Agent run reached time limit"
              : observedTerminationReason === "call_limit_reached"
                ? "Agent run reached 12-call limit"
                : observedTerminationReason === "qloo_budget_exhausted"
                  ? "Agent run reached Qloo request budget"
                  : "Agent run ended early",
          detail: describeAgentFallbackReason(observedTerminationReason, true),
          status: mode === "deterministic" ? "warning" : "failed",
          durationMs: stepDuration,
          cacheStatus: null,
          queryScope: null,
          anchorCount: null,
          categoryTag: null,
          counts: null,
          fallback: null,
        });
      }
    }
  }

  // 3. Deterministic fallback steps (when mode === "deterministic")
  const fallbackReason =
    mode === "deterministic"
      ? describeAgentFallbackReason(
          observedTerminationReason,
          input.agentFailedBeforeFallback ?? true,
        )
      : anyFallbackTriggered
        ? "Category query returned 0 accepted results; agent executed approved fallback stages."
        : null;

  if (mode === "deterministic") {
    const det = input.deterministicDiscovery;
    const resolvedNames = (det?.resolvedAnchorNames ?? [])
      .map((n) => sanitizePublicText(n, ""))
      .filter(Boolean);
    const singleCount = sanitizeCount(
      det?.singleAnchorQueriesCount ??
        (resolvedNames.length > 0 ? resolvedNames.length : input.anchorCount),
    );
    const attempt = bumpAttempt("deterministic_fallback");

    if (input.outcome === "timeout" && !det) {
      steps.push({
        stepNumber: nextStepNumber++,
        attemptNumber: attempt,
        kind: "fallback_step",
        title: `Deterministic Qloo discovery in ${city} timed out`,
        detail:
          "Request deadline expired before deterministic Qloo discovery could complete.",
        status: "failed",
        durationMs,
        cacheStatus: null,
        queryScope: null,
        anchorCount: singleCount > 0 ? singleCount : null,
        categoryTag: null,
        counts: null,
        fallback: {
          stage: "deterministic",
          stageLabel: "Deterministic Qloo discovery fallback",
          reason: fallbackReason ?? "Switched to deterministic Qloo discovery.",
          recovered: false,
          originalCategory: null,
          alternativeCategory: null,
        },
      });
    } else if (input.outcome === "error" && !det) {
      steps.push({
        stepNumber: nextStepNumber++,
        attemptNumber: attempt,
        kind: "fallback_step",
        title: `Deterministic Qloo discovery in ${city} stopped`,
        detail:
          observedTerminationReason === "output_validation_failed"
            ? "Deterministic discovery output did not pass schema validation."
            : "Deterministic Qloo discovery stopped due to an upstream service error.",
        status: "failed",
        durationMs,
        cacheStatus: null,
        queryScope: null,
        anchorCount: singleCount > 0 ? singleCount : null,
        categoryTag: null,
        counts: null,
        fallback: {
          stage: "deterministic",
          stageLabel: "Deterministic Qloo discovery fallback",
          reason: fallbackReason ?? "Switched to deterministic Qloo discovery.",
          recovered: false,
          originalCategory: null,
          alternativeCategory: null,
        },
      });
    } else {
      const detAccepted = sanitizeCount(det?.acceptedCount);
      const detReview = sanitizeCount(det?.reviewCount);
      const detRejected = sanitizeCount(det?.rejectedCount);
      const detReasons = sanitizeRejectedReasons(det?.rejectedReasons);

      const detCounts: PublicStepCounts = {
        accepted: detAccepted,
        review: detReview,
        rejected: detRejected,
        rejectedReasons: detReasons,
      };
      accumulateCounts(detCounts);

      if (detAccepted > 0) {
        anyFallbackRecovered = true;
      }

      const zeroResolvedAnchors =
        det !== undefined && det.singleAnchorQueriesCount === 0;

      steps.push({
        stepNumber: nextStepNumber++,
        attemptNumber: attempt,
        kind: "fallback_step",
        title: `Deterministic Qloo discovery in ${city}`,
        detail: zeroResolvedAnchors
          ? `No anchors could be resolved in Qloo for ${city}.`
          : singleCount > 0
            ? `Executed deterministic Qloo pipeline (${singleCount} single-anchor ${singleCount === 1 ? "query" : "queries"}${det?.blendedQueryRun !== false ? " + 1 blended profile query" : ""})${resolvedNames.length > 0 ? ` for ${resolvedNames.join(", ")}` : ""}. Validator accepted ${detAccepted}, held ${detReview} for review, and rejected ${detRejected}${formatRejectionSummary(detReasons)}.`
            : `Executed deterministic Qloo pipeline in ${city}. Validator accepted ${detAccepted}, held ${detReview} for review, and rejected ${detRejected}${formatRejectionSummary(detReasons)}.`,
        status: detAccepted > 0 ? "recovered" : "warning",
        durationMs,
        cacheStatus: cached ? "cached" : "live",
        queryScope: zeroResolvedAnchors ? null : "single-and-blended",
        anchorCount: singleCount > 0 ? singleCount : null,
        categoryTag: null,
        counts: detCounts,
        fallback: {
          stage: "deterministic",
          stageLabel: "Deterministic Qloo discovery fallback",
          reason: fallbackReason ?? "Switched to deterministic Qloo discovery.",
          recovered: detAccepted > 0,
          originalCategory: null,
          alternativeCategory: null,
        },
      });
    }
  }

  // 4. Determine overall cache status and outcome
  let qlooCacheStatus: PublicCacheStatus;
  if (cached) {
    qlooCacheStatus = "cached";
  } else if (observedCacheHits > 0 && observedLiveCalls > 0) {
    qlooCacheStatus = "mixed";
  } else if (observedCacheHits > 0 && observedLiveCalls === 0) {
    qlooCacheStatus = "cached";
  } else {
    qlooCacheStatus = "live";
  }

  const outcome: PublicProcessOutcome =
    input.outcome ??
    (totalAccepted > 0
      ? "completed"
      : observedTerminationReason === "total_timeout"
        ? "timeout"
        : "empty");

  const outcomeSummary = (() => {
    switch (outcome) {
      case "completed":
        return mode === "deterministic"
          ? `Completed via deterministic Qloo discovery in ${city}.`
          : `Completed via agent-assisted Qloo discovery in ${city}.`;
      case "partial":
        return `Completed in ${city}; unverified candidate IDs were filtered out.`;
      case "empty":
        return `Completed search in ${city}; 0 places passed deterministic verification.`;
      case "timeout":
        return `Search for ${city} timed out before completion.`;
      case "error":
        return `Search for ${city} stopped due to a controlled error.`;
    }
  })();

  const projection: PublicSearchProcess = {
    city,
    qlooGrounded: true,
    mode,
    modeLabel:
      mode === "deterministic"
        ? "Deterministic Qloo discovery (fallback mode)"
        : "Agent-assisted discovery (Bedrock + Qloo)",
    fallbackTriggered: anyFallbackTriggered,
    fallbackReason,
    fallbackRecovered: anyFallbackRecovered,
    cached,
    qlooCacheStatus,
    durationMs,
    outcome,
    outcomeSummary,
    totals: {
      accepted: totalAccepted,
      review: totalReview,
      rejected: totalRejected,
      rejectedReasons: totalRejectedReasons,
    },
    steps,
  };

  return PublicSearchProcessSchema.parse(projection);
}
