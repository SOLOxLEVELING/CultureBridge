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
  FinalizeResult,
} from "../bedrock";
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
  | "info";

export interface TraceEvent {
  id: number;
  timestamp: string;
  durationMs: number;
  type: "model_call" | "tool_dispatch" | "termination";
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
}

export interface AgentRunResult {
  runId: string;
  status: TerminationReason;
  finalization?: {
    summary: string;
    recommendationIds: string[];
    recommendationCount: number;
  };
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
  acceptedRecommendations: Map<string, { name: string; label: string }>;
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
): Promise<T> {
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ac.abort();
        reject(new OperationTimeoutError(label, ms));
      },
      ms,
    );
    try {
      startOp(ac.signal).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          if (ac.signal.aborted) return;
          reject(e);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
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
  let terminationReason: TerminationReason | undefined;

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
    return elapsed() >= totalTimeout;
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
        (signal) => deps.converse({ system: systemPrompt, messages, tools: toolConfig, signal }),
        Math.min(opTimeout, remaining()),
        "bedrock_converse",
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
          (signal) => deps.dispatchToolCall(name, dispatchInput, trackedDeps, signal),
          Math.min(opTimeout, remaining()),
          `tool:${name}`,
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
          for (const e of r.accepted) {
            if (e.recommendation) {
              trusted.acceptedRecommendations.set(e.entityId, {
                name: e.name,
                label: e.recommendation.label,
              });
            }
          }

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
          toolResults.push({
            toolUseId: tuId,
            result: outcome.result,
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
    trace,
    toolCallCount,
    qlooOutboundRequests: budget.outbound,
    qlooCacheHits: budget.cacheHits,
    totalDurationMs: Date.now() - runStart,
  };
}
