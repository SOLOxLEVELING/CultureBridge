import type { DocumentType } from "@smithy/types";
import {
  converse as bedrockConverse,
  extractToolUses,
  ALL_TOOL_SPECS,
  TOOL_NAMES,
  dispatchToolCall as defaultDispatchToolCall,
} from "../bedrock";
import type {
  ConverseTurn,
  ConverseInput,
  ConverseOutput,
  ToolDeps,
  ToolExecutionOutcome,
  ResolveAnchorResult,
  DiscoverPlacesResult,
  DiscoverPlacesResultEntry,
  FindTagsResult,
  FinalizeResult,
} from "../bedrock";
import { buildStructuredOutput, OutputValidationError } from "../output";
import type { StructuredOutput } from "../output";
import {
  searchEntity as realSearchEntity,
  searchTags as realSearchTags,
  insights as realInsights,
} from "../qloo/client";

// ── Constants ──────────────────────────────────────────────────
// Tool-call limit: individual tool invocations per run.
export const TOOL_CALL_LIMIT = 12;
// Total wall-clock budget. Conservative for Vercel Hobby (30 s).
export const TOTAL_RUN_TIMEOUT_MS = 25_000;
// Per-operation ceiling (Bedrock call or tool dispatch).
export const OPERATION_TIMEOUT_MS = 15_000;
// Outbound (non-cached) Qloo HTTP requests per run.
// Covers: 5 search + 12 insights + 5 tags + headroom.
// The Qloo client retries 5xx/429 internally (up to 2 retries = 3 attempts
// per logical call). This budget counts logical outbound calls; retry
// attempts are handled inside the Qloo client and are not counted here.
export const QLOO_REQUEST_BUDGET = 25;
const MAX_CONVERSE_TURNS = 10;

// ── Public types ───────────────────────────────────────────────

export interface AnchorSpec {
  query: string;
  type: string;
}

export interface ConfirmedAnchor {
  entityId: string;
  name: string;
}

export interface AgentRunInput {
  city: string;
  anchors: AnchorSpec[];
  confirmedAnchors?: ConfirmedAnchor[];
}

export type TerminationReason =
  | "completed"
  | "call_limit_reached"
  | "total_timeout"
  | "qloo_budget_exhausted"
  | "model_error"
  | "invalid_finalization"
  | "output_validation_failed"
  | "malformed_response"
  | "content_filtered";

export type TraceEventStatus =
  | "success"
  | "validation_error"
  | "execution_error"
  | "timeout"
  | "budget_blocked"
  | "city_mismatch"
  | "untrusted_anchor"
  | "filtered_ids"
  | "info"
  | "fallback_triggered"
  | "fallback_success"
  | "fallback_no_results"
  | "fallback_skipped"
  | "fallback_exhausted"
  | "duplicate_blocked";

export type FallbackStage = "alt_tag" | "drop_tag" | "broaden";

export interface TraceEvent {
  id: number;
  timestamp: string;
  durationMs: number;
  type: "model_call" | "tool_dispatch" | "termination" | "fallback";
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  status: TraceEventStatus;
  acceptedCount?: number;
  reviewCount?: number;
  rejectedCount?: number;
  rejectedReasons?: Record<string, number>;
  qlooRequestsMade?: number;
  qlooCacheHits?: number;
  terminationReason?: TerminationReason;
  fallbackUsed: boolean;
  detail?: string;
  fallbackStage?: FallbackStage;
  fallbackReason?: string;
  originalTagId?: string;
  alternativeTagId?: string;
  anchorIdsUsed?: string[];
  tagDropped?: boolean;
  cached?: boolean;
}

export interface AgentRunResult {
  runId: string;
  status: TerminationReason;
  finalization?: {
    summary: string;
    recommendationIds: string[];
    recommendationCount: number;
  };
  output?: StructuredOutput;
  trace: TraceEvent[];
  toolCallCount: number;
  qlooOutboundRequests: number;
  qlooCacheHits: number;
  totalDurationMs: number;
}

// ── Injectable deps ────────────────────────────────────────────

export interface AgentRunnerDeps {
  converse: (input: ConverseInput) => Promise<ConverseOutput>;
  dispatchToolCall: (
    toolName: string,
    toolInput: unknown,
    deps?: ToolDeps,
    signal?: AbortSignal,
  ) => Promise<ToolExecutionOutcome>;
  toolDeps?: ToolDeps;
  operationTimeoutMs?: number;
  totalRunTimeoutMs?: number;
}

const DEFAULT_RUNNER_DEPS: AgentRunnerDeps = {
  converse: bedrockConverse,
  dispatchToolCall: defaultDispatchToolCall,
};

// ── Budget tracker ─────────────────────────────────────────────

// Tracks logical Qloo API operations, not individual HTTP attempts.
// The Qloo client retries 5xx/429 internally (MAX_RETRIES=2 → up to 3 attempts
// per logical call). Budget of 25 outbound → up to 75 HTTP attempts worst case.
// Cached responses (24h TTL) are tracked separately; not counted as outbound.
class QlooBudgetTracker {
  outbound = 0;
  cacheHits = 0;
  constructor(readonly limit: number) {}
  get remaining(): number {
    return this.limit - this.outbound;
  }
  get totalCalls(): number {
    return this.outbound + this.cacheHits;
  }
  canAfford(estimated: number): boolean {
    return this.outbound + estimated <= this.limit;
  }
  recordOutbound(): void {
    this.outbound++;
  }
  recordCacheHit(): void {
    this.cacheHits++;
  }
}

// ── Trusted state ──────────────────────────────────────────────

interface TrustedState {
  city: string;
  confirmedAnchors: Map<string, ConfirmedAnchor>;
  acceptedRecommendations: Map<string, DiscoverPlacesResultEntry>;
}

// ── Helpers ────────────────────────────────────────────────────

function estimateQlooCalls(toolName: string, toolInput: unknown): number {
  if (toolName === TOOL_NAMES.RESOLVE_ANCHOR) return 1;
  if (toolName === TOOL_NAMES.FIND_TAGS) return 1;
  if (toolName === TOOL_NAMES.FINALIZE) return 0;
  if (toolName === TOOL_NAMES.DISCOVER_PLACES) {
    const inp = toolInput as { anchor_ids?: unknown[] };
    return (Array.isArray(inp?.anchor_ids) ? inp.anchor_ids.length : 1) + 1;
  }
  return 0;
}

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  const copy = { ...(input as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    if (/key|secret|token|password|credential|auth/i.test(key)) {
      copy[key] = "[REDACTED]";
    }
  }
  return copy;
}

function sanitizeErrorForTrace(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  if (/api.?key|secret|credential|token|password|authorization/i.test(err.message)) {
    return "Operation failed due to a configuration error.";
  }
  return err.message.slice(0, 500);
}

function buildSystemPrompt(
  city: string,
  anchors: AnchorSpec[],
  confirmed: ConfirmedAnchor[],
): string {
  const lines: string[] = [
    `You are CultureBridge, a cultural onboarding agent. Discover places in ${city} based on the user's cultural tastes.`,
    "",
    "Steps: resolve each anchor → discover places → finalize with accepted recommendation IDs.",
    `Destination city: ${city}. Do not change it.`,
    "Only use entity IDs from tool results. Only finalize with accepted recommendation IDs.",
  ];
  if (anchors.length > 0) {
    lines.push("", "Anchors to resolve:");
    for (const a of anchors) lines.push(`- "${a.query}" (${a.type})`);
  }
  if (confirmed.length > 0) {
    lines.push("", "Pre-confirmed anchors:");
    for (const c of confirmed) lines.push(`- ${c.name} (${c.entityId})`);
  }
  return lines.join("\n");
}

function buildInitialMessage(
  city: string,
  anchors: AnchorSpec[],
  confirmed: ConfirmedAnchor[],
): string {
  const lines = [`Discover places in ${city} for a newcomer.`];
  if (anchors.length > 0) {
    lines.push("", "Resolve these taste anchors:");
    for (const a of anchors) lines.push(`- "${a.query}" (${a.type})`);
  }
  if (confirmed.length > 0) {
    lines.push("", "Pre-confirmed anchors:");
    for (const c of confirmed) lines.push(`- ${c.name} (${c.entityId})`);
  }
  lines.push("", "Discover places and finalize with your top recommendations.");
  return lines.join("\n");
}

function buildToolResultsMessage(
  results: { toolUseId: string; result: unknown; isError: boolean }[],
): ConverseTurn {
  return {
    role: "user",
    content: results.map((r) => ({
      toolResult: {
        toolUseId: r.toolUseId,
        content: [{ json: (r.result ?? { error: "null" }) as DocumentType }],
        status: r.isError ? ("error" as const) : undefined,
      },
    })),
  };
}

export class OperationTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`"${label}" timed out after ${ms}ms`);
    this.name = "OperationTimeoutError";
  }
}

function withTimeout<T>(
  startOp: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();

  if (parentSignal?.aborted) {
    ac.abort();
    return Promise.reject(new OperationTimeoutError(label, 0));
  }

  const onParentAbort = () => ac.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    };
    const timer = setTimeout(
      () => {
        ac.abort();
        cleanup();
        reject(new OperationTimeoutError(label, ms));
      },
      ms,
    );

    if (ac.signal.aborted) {
      cleanup();
      reject(new OperationTimeoutError(label, 0));
      return;
    }

    try {
      startOp(ac.signal).then(
        (v) => {
          cleanup();
          resolve(v);
        },
        (e) => {
          cleanup();
          if (ac.signal.aborted) return;
          reject(e);
        },
      );
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

// ── Fallback infrastructure ───────────────────────────────────

const KNOWN_EMPTY_TAGS = new Set(["urn:tag:category:place:coffee"]);
const PLACE_CATEGORY_PREFIX = "urn:tag:category:place:";

function tagSlug(tagId: string): string {
  return tagId.startsWith(PLACE_CATEGORY_PREFIX)
    ? tagId.slice(PLACE_CATEGORY_PREFIX.length)
    : tagId;
}

function tagSlugToQuery(tagId: string): string {
  return tagSlug(tagId).replace(/_/g, " ");
}

function isPlaceCategoryTag(tagId: string): boolean {
  return tagId.startsWith(PLACE_CATEGORY_PREFIX);
}

interface FallbackAttempt {
  stage: FallbackStage;
  outcome: "success" | "no_results" | "skipped" | "budget_blocked";
  reason?: string;
  tagId?: string;
  anchorIds?: string[];
  acceptedCount: number;
}

interface FallbackObjective {
  key: string;
  anchorIds: string[];
  city: string;
  originalTagId: string | undefined;
  initialAccepted: number;
  attempts: FallbackAttempt[];
  exhausted: boolean;
}

class FallbackTracker {
  private objectives = new Map<string, FallbackObjective>();

  private makeKey(anchorIds: string[], city: string, tagId: string | undefined): string {
    return [...anchorIds].sort().join(",") + "|" + city + "|" + (tagId ?? "");
  }

  registerInitial(
    anchorIds: string[],
    city: string,
    tagId: string | undefined,
    acceptedCount: number,
  ): FallbackObjective {
    const key = this.makeKey(anchorIds, city, tagId);
    const existing = this.objectives.get(key);
    if (existing) {
      existing.initialAccepted = acceptedCount;
      return existing;
    }
    const obj: FallbackObjective = {
      key,
      anchorIds,
      city,
      originalTagId: tagId,
      initialAccepted: acceptedCount,
      attempts: [],
      exhausted: false,
    };
    this.objectives.set(key, obj);
    return obj;
  }

  getObjective(anchorIds: string[], city: string, tagId: string | undefined): FallbackObjective | undefined {
    return this.objectives.get(this.makeKey(anchorIds, city, tagId));
  }

  isExhausted(anchorIds: string[], city: string, tagId: string | undefined): boolean {
    const obj = this.getObjective(anchorIds, city, tagId);
    return !!obj?.exhausted;
  }

  hasAttemptedTag(objective: FallbackObjective, tagId: string): boolean {
    if (tagId === objective.originalTagId) return true;
    return objective.attempts.some((a) => a.tagId === tagId);
  }

  recordAttempt(objective: FallbackObjective, attempt: FallbackAttempt): void {
    objective.attempts.push(attempt);
  }

  markExhausted(objective: FallbackObjective): void {
    objective.exhausted = true;
  }
}

interface FallbackChainParams {
  anchorIds: string[];
  anchorNames: string[];
  city: string;
  originalTagId: string | undefined;
  objective: FallbackObjective;
  tracker: FallbackTracker;
  confirmedAnchors: Map<string, ConfirmedAnchor>;
  deps: AgentRunnerDeps;
  trackedDeps: ToolDeps;
  budget: QlooBudgetTracker;
  toolCallCount: number;
  toolCallLimit: number;
  opTimeout: number;
  remaining: () => number;
  isTimedOut: () => boolean;
  emit: (event: Omit<TraceEvent, "id">) => void;
  parentSignal?: AbortSignal;
}

interface FallbackChainResult {
  bestResult: DiscoverPlacesResult | null;
  additionalToolCalls: number;
}

async function executeFallbackChain(
  params: FallbackChainParams,
): Promise<FallbackChainResult> {
  const {
    anchorIds,
    anchorNames,
    city,
    originalTagId,
    objective,
    tracker,
    confirmedAnchors,
    deps,
    trackedDeps,
    budget,
    opTimeout,
    remaining,
    isTimedOut,
    emit,
    parentSignal,
  } = params;
  let { toolCallCount, toolCallLimit } = params;
  let additionalToolCalls = 0;
  let bestResult: DiscoverPlacesResult | null = null;

  function canProceed(): boolean {
    return !isTimedOut() && toolCallCount < toolCallLimit;
  }

  function estimateDiscoverQloo(ids: string[]): number {
    return ids.length + 1;
  }

  async function dispatchInternal(
    toolName: string,
    toolInput: unknown,
  ): Promise<ToolExecutionOutcome | null> {
    const estimated = estimateQlooCalls(toolName, toolInput);
    if (estimated > 0 && !budget.canAfford(estimated)) return null;
    const totalBefore = budget.totalCalls;
    try {
      const outcome = await withTimeout(
        (signal) => deps.dispatchToolCall(toolName, toolInput, trackedDeps, signal),
        Math.min(opTimeout, remaining()),
        `fallback:${toolName}`,
        parentSignal,
      );
      if (budget.totalCalls === totalBefore && estimated > 0 && outcome.ok) {
        for (let i = 0; i < estimated; i++) budget.recordOutbound();
      }
      return outcome;
    } catch {
      return null;
    }
  }

  // ── Stage 1: Alternative tag ──
  const hasTag = !!originalTagId;
  if (hasTag) {
    if (KNOWN_EMPTY_TAGS.has(originalTagId!)) {
      const attempt: FallbackAttempt = {
        stage: "alt_tag",
        outcome: "skipped",
        reason: `Known empty tag: ${originalTagId}`,
        acceptedCount: 0,
      };
      tracker.recordAttempt(objective, attempt);
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "fallback",
        status: "fallback_skipped",
        fallbackUsed: true,
        fallbackStage: "alt_tag",
        fallbackReason: `Known empty tag: ${originalTagId}`,
        originalTagId: originalTagId!,
      });
    } else if (canProceed()) {
      // Call find_tags to get alternatives
      toolCallCount++;
      additionalToolCalls++;
      const findTagsOutcome = await dispatchInternal("find_tags", {
        query: tagSlugToQuery(originalTagId!),
      });

      let alternativeTagId: string | undefined;
      if (findTagsOutcome?.ok) {
        const tagsResult = findTagsOutcome.result as FindTagsResult;
        for (const tag of tagsResult.tags) {
          if (
            isPlaceCategoryTag(tag.id) &&
            tag.id !== originalTagId &&
            !KNOWN_EMPTY_TAGS.has(tag.id) &&
            !tracker.hasAttemptedTag(objective, tag.id)
          ) {
            alternativeTagId = tag.id;
            break;
          }
        }
      }

      if (alternativeTagId && canProceed()) {
        toolCallCount++;
        additionalToolCalls++;
        const discoverOutcome = await dispatchInternal("discover_places", {
          anchor_ids: anchorIds,
          anchor_names: anchorNames,
          city,
          category_tag_id: alternativeTagId,
        });

        if (discoverOutcome?.ok) {
          const r = discoverOutcome.result as DiscoverPlacesResult;
          const attempt: FallbackAttempt = {
            stage: "alt_tag",
            outcome: r.accepted.length > 0 ? "success" : "no_results",
            tagId: alternativeTagId,
            acceptedCount: r.accepted.length,
          };
          tracker.recordAttempt(objective, attempt);
          emit({
            timestamp: new Date().toISOString(),
            durationMs: 0,
            type: "fallback",
            status: r.accepted.length > 0 ? "fallback_success" : "fallback_no_results",
            fallbackUsed: true,
            fallbackStage: "alt_tag",
            fallbackReason: "Trying grounded alternative tag",
            originalTagId: originalTagId!,
            alternativeTagId,
            acceptedCount: r.accepted.length,
            reviewCount: r.reviewCount,
            rejectedCount: r.rejectedCount,
            rejectedReasons: r.rejectedReasons,
            qlooRequestsMade: budget.outbound,
            qlooCacheHits: budget.cacheHits,
            cached: r.budget.queriesUsed === 0,
          });
          if (r.accepted.length > 0) {
            bestResult = r;
            return { bestResult, additionalToolCalls };
          }
        } else {
          const attempt: FallbackAttempt = {
            stage: "alt_tag",
            outcome: "no_results",
            tagId: alternativeTagId,
            reason: "Dispatch failed",
            acceptedCount: 0,
          };
          tracker.recordAttempt(objective, attempt);
          emit({
            timestamp: new Date().toISOString(),
            durationMs: 0,
            type: "fallback",
            status: "fallback_no_results",
            fallbackUsed: true,
            fallbackStage: "alt_tag",
            fallbackReason: "Alternative tag dispatch failed",
            originalTagId: originalTagId!,
            alternativeTagId,
            acceptedCount: 0,
          });
        }
      } else if (!alternativeTagId) {
        const attempt: FallbackAttempt = {
          stage: "alt_tag",
          outcome: "skipped",
          reason: "No grounded alternative tag found",
          acceptedCount: 0,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: "fallback_skipped",
          fallbackUsed: true,
          fallbackStage: "alt_tag",
          fallbackReason: "No grounded alternative tag found",
          originalTagId: originalTagId!,
        });
      } else {
        // Can't proceed (budget/timeout)
        const attempt: FallbackAttempt = {
          stage: "alt_tag",
          outcome: "budget_blocked",
          reason: "Budget or timeout constraint",
          acceptedCount: 0,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: "budget_blocked",
          fallbackUsed: true,
          fallbackStage: "alt_tag",
          fallbackReason: "Budget or timeout constraint",
        });
      }
    } else {
      // Can't proceed for Stage 1
      const attempt: FallbackAttempt = {
        stage: "alt_tag",
        outcome: "budget_blocked",
        reason: "Budget or timeout constraint",
        acceptedCount: 0,
      };
      tracker.recordAttempt(objective, attempt);
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "fallback",
        status: "budget_blocked",
        fallbackUsed: true,
        fallbackStage: "alt_tag",
        fallbackReason: "Budget or timeout constraint",
      });
    }

    // ── Stage 2: Drop tag ──
    if (canProceed()) {
      toolCallCount++;
      additionalToolCalls++;
      const discoverOutcome = await dispatchInternal("discover_places", {
        anchor_ids: anchorIds,
        anchor_names: anchorNames,
        city,
      });

      if (discoverOutcome?.ok) {
        const r = discoverOutcome.result as DiscoverPlacesResult;
        const attempt: FallbackAttempt = {
          stage: "drop_tag",
          outcome: r.accepted.length > 0 ? "success" : "no_results",
          acceptedCount: r.accepted.length,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: r.accepted.length > 0 ? "fallback_success" : "fallback_no_results",
          fallbackUsed: true,
          fallbackStage: "drop_tag",
          fallbackReason: "Dropped category tag, classifying from entity tags",
          originalTagId: originalTagId!,
          tagDropped: true,
          anchorIdsUsed: anchorIds,
          acceptedCount: r.accepted.length,
          reviewCount: r.reviewCount,
          rejectedCount: r.rejectedCount,
          rejectedReasons: r.rejectedReasons,
          qlooRequestsMade: budget.outbound,
          qlooCacheHits: budget.cacheHits,
        });
        if (r.accepted.length > 0) {
          bestResult = r;
          return { bestResult, additionalToolCalls };
        }
      } else {
        const attempt: FallbackAttempt = {
          stage: "drop_tag",
          outcome: "no_results",
          reason: "Dispatch failed",
          acceptedCount: 0,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: "fallback_no_results",
          fallbackUsed: true,
          fallbackStage: "drop_tag",
          fallbackReason: "Tagless dispatch failed",
          originalTagId: originalTagId!,
          tagDropped: true,
          acceptedCount: 0,
        });
      }
    } else {
      const attempt: FallbackAttempt = {
        stage: "drop_tag",
        outcome: "budget_blocked",
        reason: "Budget or timeout constraint",
        acceptedCount: 0,
      };
      tracker.recordAttempt(objective, attempt);
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "fallback",
        status: "budget_blocked",
        fallbackUsed: true,
        fallbackStage: "drop_tag",
        fallbackReason: "Budget or timeout constraint",
      });
    }
  }

  // ── Stage 3: Broaden anchors ──
  const allConfirmedIds = [...confirmedAnchors.keys()];
  const currentAnchorSet = new Set(anchorIds);
  const additionalAnchors = allConfirmedIds.filter(
    (id) => !currentAnchorSet.has(id),
  );

  if (additionalAnchors.length === 0) {
    const attempt: FallbackAttempt = {
      stage: "broaden",
      outcome: "skipped",
      reason: "No additional trusted anchors available",
      acceptedCount: 0,
    };
    tracker.recordAttempt(objective, attempt);
    emit({
      timestamp: new Date().toISOString(),
      durationMs: 0,
      type: "fallback",
      status: "fallback_skipped",
      fallbackUsed: true,
      fallbackStage: "broaden",
      fallbackReason: "No additional trusted anchors available",
      anchorIdsUsed: anchorIds,
    });
  } else if (canProceed()) {
    const broadenedIds = [...anchorIds, ...additionalAnchors].slice(0, 5);
    const broadenedNames = broadenedIds.map(
      (id) => confirmedAnchors.get(id)!.name,
    );

    const estimated = estimateDiscoverQloo(broadenedIds);
    if (!budget.canAfford(estimated)) {
      const attempt: FallbackAttempt = {
        stage: "broaden",
        outcome: "budget_blocked",
        reason: `Need ${estimated} Qloo calls, ${budget.remaining} remaining`,
        anchorIds: broadenedIds,
        acceptedCount: 0,
      };
      tracker.recordAttempt(objective, attempt);
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "fallback",
        status: "budget_blocked",
        fallbackUsed: true,
        fallbackStage: "broaden",
        fallbackReason: `Qloo budget insufficient: need ${estimated}, have ${budget.remaining}`,
        anchorIdsUsed: broadenedIds,
      });
    } else {
      toolCallCount++;
      additionalToolCalls++;
      const discoverOutcome = await dispatchInternal("discover_places", {
        anchor_ids: broadenedIds,
        anchor_names: broadenedNames,
        city,
      });

      if (discoverOutcome?.ok) {
        const r = discoverOutcome.result as DiscoverPlacesResult;
        const attempt: FallbackAttempt = {
          stage: "broaden",
          outcome: r.accepted.length > 0 ? "success" : "no_results",
          anchorIds: broadenedIds,
          acceptedCount: r.accepted.length,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: r.accepted.length > 0 ? "fallback_success" : "fallback_no_results",
          fallbackUsed: true,
          fallbackStage: "broaden",
          fallbackReason: "Broadened anchor set with additional confirmed anchors",
          anchorIdsUsed: broadenedIds,
          acceptedCount: r.accepted.length,
          reviewCount: r.reviewCount,
          rejectedCount: r.rejectedCount,
          rejectedReasons: r.rejectedReasons,
          qlooRequestsMade: budget.outbound,
          qlooCacheHits: budget.cacheHits,
        });
        if (r.accepted.length > 0) {
          bestResult = r;
          return { bestResult, additionalToolCalls };
        }
      } else {
        const attempt: FallbackAttempt = {
          stage: "broaden",
          outcome: "no_results",
          reason: "Dispatch failed",
          anchorIds: broadenedIds,
          acceptedCount: 0,
        };
        tracker.recordAttempt(objective, attempt);
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "fallback",
          status: "fallback_no_results",
          fallbackUsed: true,
          fallbackStage: "broaden",
          fallbackReason: "Broadened dispatch failed",
          anchorIdsUsed: broadenedIds,
          acceptedCount: 0,
        });
      }
    }
  } else {
    const attempt: FallbackAttempt = {
      stage: "broaden",
      outcome: "budget_blocked",
      reason: "Budget or timeout constraint",
      acceptedCount: 0,
    };
    tracker.recordAttempt(objective, attempt);
    emit({
      timestamp: new Date().toISOString(),
      durationMs: 0,
      type: "fallback",
      status: "budget_blocked",
      fallbackUsed: true,
      fallbackStage: "broaden",
      fallbackReason: "Budget or timeout constraint",
    });
  }

  // All stages exhausted
  tracker.markExhausted(objective);
  emit({
    timestamp: new Date().toISOString(),
    durationMs: 0,
    type: "fallback",
    status: "fallback_exhausted",
    fallbackUsed: true,
    fallbackReason: "All fallback stages exhausted",
    anchorIdsUsed: anchorIds,
    originalTagId,
  });

  return { bestResult, additionalToolCalls };
}

function createTrackedToolDeps(
  baseDeps: ToolDeps | undefined,
  budget: QlooBudgetTracker,
): ToolDeps {
  const se = baseDeps?.searchEntity ?? realSearchEntity;
  const st = baseDeps?.searchTags ?? realSearchTags;
  const fi = baseDeps?.fetchInsights ?? realInsights;

  return {
    searchEntity: async (query: string, take?: number, signal?: AbortSignal) => {
      const result = await se(query, take, signal);
      if (result.meta.cached) budget.recordCacheHit();
      else budget.recordOutbound();
      return result;
    },
    searchTags: async (query: string, take?: number, signal?: AbortSignal) => {
      const result = await st(query, take, signal);
      if (result.meta.cached) budget.recordCacheHit();
      else budget.recordOutbound();
      return result;
    },
    fetchInsights: async (params, signal?: AbortSignal) => {
      const result = await fi(params, signal);
      if (result.meta.cached) budget.recordCacheHit();
      else budget.recordOutbound();
      return result;
    },
  };
}

// ── Main runner ────────────────────────────────────────────────

export async function runAgent(
  input: AgentRunInput,
  deps: AgentRunnerDeps = DEFAULT_RUNNER_DEPS,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const runId = crypto.randomUUID();
  const runStart = Date.now();
  const trace: TraceEvent[] = [];
  let nextEventId = 0;
  const budget = new QlooBudgetTracker(QLOO_REQUEST_BUDGET);
  const opTimeout = deps.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  const totalTimeout = deps.totalRunTimeoutMs ?? TOTAL_RUN_TIMEOUT_MS;

  const trusted: TrustedState = {
    city: input.city,
    confirmedAnchors: new Map(),
    acceptedRecommendations: new Map(),
  };
  for (const a of input.confirmedAnchors ?? []) {
    trusted.confirmedAnchors.set(a.entityId, a);
  }

  let toolCallCount = 0;
  let finalization: AgentRunResult["finalization"] | undefined;
  let structuredOutput: StructuredOutput | undefined;
  let terminationReason: TerminationReason | undefined;
  const fallbackTracker = new FallbackTracker();

  const trackedDeps = createTrackedToolDeps(deps.toolDeps, budget);
  const confirmed = input.confirmedAnchors ?? [];
  const systemPrompt = buildSystemPrompt(input.city, input.anchors, confirmed);
  const messages: ConverseTurn[] = [
    {
      role: "user",
      content: [
        { text: buildInitialMessage(input.city, input.anchors, confirmed) },
      ],
    },
  ];
  const toolConfig = { tools: ALL_TOOL_SPECS };

  function emit(event: Omit<TraceEvent, "id">): void {
    trace.push({ id: nextEventId++, ...event });
  }
  function elapsed(): number {
    return Date.now() - runStart;
  }
  function remaining(): number {
    return Math.max(0, totalTimeout - elapsed());
  }
  function isTimedOut(): boolean {
    return elapsed() >= totalTimeout || !!signal?.aborted;
  }

  // ── Agent loop ─────────────────────────────────────────────
  for (let turn = 0; turn < MAX_CONVERSE_TURNS && !terminationReason; turn++) {
    if (isTimedOut()) {
      terminationReason = "total_timeout";
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "termination",
        status: "info",
        terminationReason: "total_timeout",
        fallbackUsed: false,
      });
      break;
    }

    // ── Bedrock Converse call ──
    let output: ConverseOutput;
    const t0 = Date.now();
    try {
      output = await withTimeout(
        (opSignal) => deps.converse({ system: systemPrompt, messages, tools: toolConfig, signal: opSignal }),
        Math.min(opTimeout, remaining()),
        "bedrock_converse",
        signal,
      );
      emit({
        timestamp: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        type: "model_call",
        status: "success",
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        stopReason: output.stopReason,
        fallbackUsed: false,
      });
    } catch (err) {
      const isTimeout = err instanceof OperationTimeoutError;
      terminationReason = isTimeout
        ? (isTimedOut() ? "total_timeout" : "model_error")
        : "model_error";
      emit({
        timestamp: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        type: "model_call",
        status: isTimeout ? "timeout" : "execution_error",
        detail: sanitizeErrorForTrace(err),
        terminationReason,
        fallbackUsed: false,
      });
      break;
    }

    // ── Stop-reason gates ──
    if (output.stopReason === "content_filtered") {
      terminationReason = "content_filtered";
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "termination",
        status: "info",
        terminationReason,
        fallbackUsed: false,
      });
      break;
    }

    if (!output.content || output.content.length === 0) {
      terminationReason = "malformed_response";
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "termination",
        status: "info",
        terminationReason,
        detail: "Empty content",
        fallbackUsed: false,
      });
      break;
    }

    const toolUses = extractToolUses(output.content);

    if (toolUses.length === 0) {
      terminationReason = "malformed_response";
      emit({
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: "termination",
        status: "info",
        terminationReason,
        detail:
          output.stopReason === "max_tokens"
            ? "Truncated at max_tokens"
            : "Model ended without finalize",
        fallbackUsed: false,
      });
      break;
    }

    messages.push({ role: "assistant", content: output.content });

    // ── Process tool-use blocks ──
    const toolResults: {
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }[] = [];
    let shouldBreak = false;

    for (const tu of toolUses) {
      const name = tu.name ?? "unknown";
      const rawInput = tu.input ?? {};
      const tuId = tu.toolUseId ?? `synth-${nextEventId}`;
      const sanitized = sanitizeToolInput(rawInput);

      // ── Tool-call limit ──
      if (toolCallCount >= TOOL_CALL_LIMIT) {
        if (!terminationReason) terminationReason = "call_limit_reached";
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "tool_dispatch",
          toolName: name,
          toolInput: sanitized,
          status: "budget_blocked",
          detail: `Limit ${TOOL_CALL_LIMIT} reached`,
          terminationReason: "call_limit_reached",
          fallbackUsed: false,
        });
        toolResults.push({
          toolUseId: tuId,
          result: { error: "Tool call limit reached." },
          isError: true,
        });
        shouldBreak = true;
        continue;
      }
      toolCallCount++;

      // ── Run-timeout guard ──
      if (isTimedOut()) {
        terminationReason = "total_timeout";
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "tool_dispatch",
          toolName: name,
          toolInput: sanitized,
          status: "timeout",
          terminationReason: "total_timeout",
          fallbackUsed: false,
        });
        toolResults.push({
          toolUseId: tuId,
          result: { error: "Run timeout." },
          isError: true,
        });
        shouldBreak = true;
        continue;
      }

      // ── Trust enforcement for discover_places ──
      let dispatchInput: unknown = rawInput;
      if (name === TOOL_NAMES.DISCOVER_PLACES) {
        const dp = rawInput as Record<string, unknown>;

        // Duplicate detection: block re-discovery of exhausted objectives
        if (Array.isArray(dp.anchor_ids)) {
          const dpCity = typeof dp.city === "string" ? dp.city : trusted.city;
          const dpTag = typeof dp.category_tag_id === "string" ? dp.category_tag_id : undefined;
          if (fallbackTracker.isExhausted(dp.anchor_ids as string[], dpCity, dpTag)) {
            emit({
              timestamp: new Date().toISOString(),
              durationMs: 0,
              type: "tool_dispatch",
              toolName: name,
              toolInput: sanitized,
              status: "duplicate_blocked",
              detail: "Fallback chain already exhausted for this objective",
              fallbackUsed: false,
            });
            toolResults.push({
              toolUseId: tuId,
              result: {
                error: "This discovery objective has already been attempted and its fallback chain exhausted. Try different anchors or finalize.",
              },
              isError: true,
            });
            continue;
          }
        }

        // City must match the trusted destination
        if (typeof dp.city === "string" && dp.city !== trusted.city) {
          emit({
            timestamp: new Date().toISOString(),
            durationMs: 0,
            type: "tool_dispatch",
            toolName: name,
            toolInput: sanitized,
            status: "city_mismatch",
            detail: `Requested "${dp.city}", trusted "${trusted.city}"`,
            fallbackUsed: false,
          });
          toolResults.push({
            toolUseId: tuId,
            result: {
              error: `Discovery is restricted to ${trusted.city}.`,
            },
            isError: true,
          });
          continue;
        }

        // Every anchor ID must be in the trusted set
        if (Array.isArray(dp.anchor_ids)) {
          const untrusted = (dp.anchor_ids as string[]).filter(
            (id) => !trusted.confirmedAnchors.has(id),
          );
          if (untrusted.length > 0) {
            emit({
              timestamp: new Date().toISOString(),
              durationMs: 0,
              type: "tool_dispatch",
              toolName: name,
              toolInput: sanitized,
              status: "untrusted_anchor",
              detail: `Unknown IDs: ${untrusted.join(", ")}`,
              fallbackUsed: false,
            });
            toolResults.push({
              toolUseId: tuId,
              result: {
                error: `Anchor IDs not confirmed: ${untrusted.join(", ")}`,
              },
              isError: true,
            });
            continue;
          }

          // Override model-provided names with trusted names
          dispatchInput = {
            ...dp,
            anchor_names: (dp.anchor_ids as string[]).map(
              (id) => trusted.confirmedAnchors.get(id)!.name,
            ),
          };
        }
      }

      // ── Qloo budget pre-check ──
      const estimatedQloo = estimateQlooCalls(name, rawInput);
      if (estimatedQloo > 0 && !budget.canAfford(estimatedQloo)) {
        terminationReason = "qloo_budget_exhausted";
        emit({
          timestamp: new Date().toISOString(),
          durationMs: 0,
          type: "tool_dispatch",
          toolName: name,
          toolInput: sanitized,
          status: "budget_blocked",
          qlooRequestsMade: budget.outbound,
          detail: `Need ${estimatedQloo}, ${budget.remaining} remaining`,
          terminationReason: "qloo_budget_exhausted",
          fallbackUsed: false,
        });
        toolResults.push({
          toolUseId: tuId,
          result: { error: "Qloo request budget exhausted." },
          isError: true,
        });
        shouldBreak = true;
        continue;
      }

      // ── Dispatch ──
      const dt0 = Date.now();
      const totalBefore = budget.totalCalls;
      try {
        const outcome = await withTimeout(
          (opSignal) => deps.dispatchToolCall(name, dispatchInput, trackedDeps, opSignal),
          Math.min(opTimeout, remaining()),
          `tool:${name}`,
          signal,
        );
        const dur = Date.now() - dt0;

        // If tracked deps didn't fire (mocked dispatch), record estimates
        if (
          budget.totalCalls === totalBefore &&
          estimatedQloo > 0 &&
          outcome.ok
        ) {
          for (let i = 0; i < estimatedQloo; i++) budget.recordOutbound();
        }

        if (!outcome.ok) {
          emit({
            timestamp: new Date(dt0).toISOString(),
            durationMs: dur,
            type: "tool_dispatch",
            toolName: name,
            toolInput: sanitized,
            status: "execution_error",
            detail: outcome.error,
            fallbackUsed: false,
          });
          toolResults.push({
            toolUseId: tuId,
            result: { error: outcome.error },
            isError: true,
          });
          continue;
        }

        // ── Post-dispatch: update trusted state ──
        if (name === TOOL_NAMES.RESOLVE_ANCHOR) {
          const r = outcome.result as ResolveAnchorResult;
          if (r.status === "resolved" && r.entity) {
            trusted.confirmedAnchors.set(r.entity.entityId, {
              entityId: r.entity.entityId,
              name: r.entity.name,
            });
          }
          // Ambiguous → NOT added. Must resolve more specifically first.

          emit({
            timestamp: new Date(dt0).toISOString(),
            durationMs: dur,
            type: "tool_dispatch",
            toolName: name,
            toolInput: sanitized,
            status: "success",
            qlooRequestsMade: budget.outbound,
            qlooCacheHits: budget.cacheHits,
            fallbackUsed: false,
          });
          toolResults.push({
            toolUseId: tuId,
            result: outcome.result,
            isError: false,
          });
          continue;
        }

        if (name === TOOL_NAMES.DISCOVER_PLACES) {
          const r = outcome.result as DiscoverPlacesResult;
          const dpInput = dispatchInput as {
            anchor_ids: string[];
            anchor_names: string[];
            city: string;
            category_tag_id?: string;
          };

          // Emit initial discover trace
          emit({
            timestamp: new Date(dt0).toISOString(),
            durationMs: dur,
            type: "tool_dispatch",
            toolName: name,
            toolInput: sanitized,
            status: "success",
            acceptedCount: r.accepted.length,
            reviewCount: r.reviewCount,
            rejectedCount: r.rejectedCount,
            rejectedReasons: r.rejectedReasons,
            qlooRequestsMade: budget.outbound,
            qlooCacheHits: budget.cacheHits,
            fallbackUsed: false,
          });

          let bestResult = r;
          let fallbackUsedHere = false;

          // Trigger fallback chain when 0 accepted results
          if (
            r.accepted.length === 0 &&
            !isTimedOut() &&
            toolCallCount < TOOL_CALL_LIMIT
          ) {
            const objective = fallbackTracker.registerInitial(
              dpInput.anchor_ids,
              dpInput.city,
              dpInput.category_tag_id,
              0,
            );

            emit({
              timestamp: new Date().toISOString(),
              durationMs: 0,
              type: "fallback",
              status: "fallback_triggered",
              fallbackUsed: true,
              fallbackReason: "Discovery returned 0 accepted results",
              originalTagId: dpInput.category_tag_id,
              anchorIdsUsed: dpInput.anchor_ids,
            });

            const fbResult = await executeFallbackChain({
              anchorIds: dpInput.anchor_ids,
              anchorNames: dpInput.anchor_names,
              city: dpInput.city,
              originalTagId: dpInput.category_tag_id,
              objective,
              tracker: fallbackTracker,
              confirmedAnchors: trusted.confirmedAnchors,
              deps,
              trackedDeps,
              budget,
              toolCallCount,
              toolCallLimit: TOOL_CALL_LIMIT,
              opTimeout,
              remaining,
              isTimedOut,
              emit,
              parentSignal: signal,
            });

            toolCallCount += fbResult.additionalToolCalls;
            if (fbResult.bestResult) {
              bestResult = fbResult.bestResult;
              fallbackUsedHere = true;
            }

            if (!objective.exhausted) {
              fallbackTracker.markExhausted(objective);
            }
          }

          // Register accepted recommendations from bestResult
          for (const e of bestResult.accepted) {
            if (e.recommendation) {
              trusted.acceptedRecommendations.set(e.entityId, e);
            }
          }

          toolResults.push({
            toolUseId: tuId,
            result: fallbackUsedHere
              ? {
                  ...bestResult,
                  fallbackApplied: {
                    originalTagId: dpInput.category_tag_id,
                    stagesAttempted: fallbackTracker
                      .getObjective(dpInput.anchor_ids, dpInput.city, dpInput.category_tag_id)
                      ?.attempts.map((a) => a.stage) ?? [],
                  },
                }
              : bestResult,
            isError: false,
          });
          continue;
        }

        if (name === TOOL_NAMES.FINALIZE) {
          const r = outcome.result as FinalizeResult;
          const validIds: string[] = [];
          const invalidIds: string[] = [];
          for (const id of r.recommendationIds) {
            if (trusted.acceptedRecommendations.has(id)) {
              validIds.push(id);
            } else {
              invalidIds.push(id);
            }
          }

          if (invalidIds.length > 0) {
            emit({
              timestamp: new Date().toISOString(),
              durationMs: 0,
              type: "tool_dispatch",
              toolName: name,
              toolInput: sanitized,
              status: "filtered_ids",
              detail: `Removed ${invalidIds.length}: ${invalidIds.join(", ")}`,
              fallbackUsed: false,
            });
          }

          // All IDs invalid when at least one was provided → invalid finalization
          if (validIds.length === 0 && r.recommendationIds.length > 0) {
            terminationReason = "invalid_finalization";
            emit({
              timestamp: new Date(dt0).toISOString(),
              durationMs: dur,
              type: "tool_dispatch",
              toolName: name,
              toolInput: sanitized,
              status: "execution_error",
              detail: "All recommendation IDs were invalid",
              terminationReason: "invalid_finalization",
              fallbackUsed: false,
            });
            toolResults.push({
              toolUseId: tuId,
              result: {
                error:
                  "All recommendation IDs were unknown or not accepted.",
              },
              isError: true,
            });
            shouldBreak = true;
            continue;
          }

          finalization = {
            summary: r.summary,
            recommendationIds: validIds,
            recommendationCount: validIds.length,
          };
          try {
            structuredOutput = buildStructuredOutput(
              trusted.city,
              validIds,
              invalidIds,
              trusted.acceptedRecommendations,
            );
          } catch (buildErr) {
            if (buildErr instanceof OutputValidationError) {
              emit({
                timestamp: new Date(dt0).toISOString(),
                durationMs: Date.now() - dt0,
                type: "tool_dispatch",
                toolName: name,
                toolInput: sanitized,
                status: "execution_error",
                detail: "Output schema validation failed during finalization",
                terminationReason: "output_validation_failed",
                fallbackUsed: false,
              });
              toolResults.push({
                toolUseId: tuId,
                result: { error: "Output validation failed." },
                isError: true,
              });
              terminationReason = "output_validation_failed";
              shouldBreak = true;
              continue;
            }
            throw buildErr;
          }
          terminationReason = "completed";
          emit({
            timestamp: new Date(dt0).toISOString(),
            durationMs: dur,
            type: "tool_dispatch",
            toolName: name,
            toolInput: sanitized,
            status: "success",
            terminationReason: "completed",
            qlooRequestsMade: budget.outbound,
            qlooCacheHits: budget.cacheHits,
            fallbackUsed: false,
          });
          toolResults.push({
            toolUseId: tuId,
            result: {
              status: "complete",
              summary: r.summary,
              recommendationCount: validIds.length,
              recommendationIds: validIds,
            },
            isError: false,
          });
          shouldBreak = true;
          continue;
        }

        // Generic success (find_tags, etc.)
        emit({
          timestamp: new Date(dt0).toISOString(),
          durationMs: dur,
          type: "tool_dispatch",
          toolName: name,
          toolInput: sanitized,
          status: "success",
          qlooRequestsMade: budget.outbound,
          qlooCacheHits: budget.cacheHits,
          fallbackUsed: false,
        });
        toolResults.push({
          toolUseId: tuId,
          result: outcome.result,
          isError: false,
        });
      } catch (err) {
        const dur = Date.now() - dt0;
        const isTimeout = err instanceof OperationTimeoutError;
        emit({
          timestamp: new Date(dt0).toISOString(),
          durationMs: dur,
          type: "tool_dispatch",
          toolName: name,
          toolInput: sanitized,
          status: isTimeout ? "timeout" : "execution_error",
          detail: sanitizeErrorForTrace(err),
          fallbackUsed: false,
        });
        toolResults.push({
          toolUseId: tuId,
          result: {
            error: isTimeout ? "Tool timed out." : "Tool execution failed.",
          },
          isError: true,
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push(buildToolResultsMessage(toolResults));
    }
    if (shouldBreak) break;
  }

  // Fell through MAX_CONVERSE_TURNS without terminating
  if (!terminationReason) {
    terminationReason = "malformed_response";
    emit({
      timestamp: new Date().toISOString(),
      durationMs: 0,
      type: "termination",
      status: "info",
      terminationReason,
      detail: `Max turns (${MAX_CONVERSE_TURNS}) without finalize`,
      fallbackUsed: false,
    });
  }

  return {
    runId,
    status: terminationReason,
    finalization,
    output: structuredOutput,
    trace,
    toolCallCount,
    qlooOutboundRequests: budget.outbound,
    qlooCacheHits: budget.cacheHits,
    totalDurationMs: Date.now() - runStart,
  };
}
