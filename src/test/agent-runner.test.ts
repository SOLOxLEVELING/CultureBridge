import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import {
  runAgent,
  compactDiscoverResultForModel,
  TOOL_CALL_LIMIT,
  QLOO_REQUEST_BUDGET,
} from "../lib/agent";
import type { AgentRunnerDeps, AgentRunInput } from "../lib/agent";
import type {
  ConverseInput,
  ConverseOutput,
  StopReason,
  ToolDeps,
  ToolExecutionOutcome,
  ResolveAnchorResult,
  DiscoverPlacesResult,
  FinalizeResult,
  FindTagsResult,
} from "../lib/bedrock";
import { dispatchToolCall as realDispatchToolCall } from "../lib/bedrock";
import type { SearchResponse } from "../lib/qloo/schemas";
import type { QlooResult } from "../lib/qloo/client";

// ── Mock helpers ──────────────────────────────────────────────

function makeOutput(
  content: ContentBlock[],
  stopReason: StopReason = "tool_use",
): ConverseOutput {
  return { content, stopReason, inputTokens: 100, outputTokens: 50, latencyMs: 200 };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { toolUse: { toolUseId: id, name, input: input as DocumentType } };
}

function text(t: string): ContentBlock {
  return { text: t };
}

function scriptedConverse(
  responses: ConverseOutput[],
): (input: ConverseInput) => Promise<ConverseOutput> {
  let idx = 0;
  return async () => {
    if (idx >= responses.length) throw new Error(`Unexpected converse call #${idx + 1}`);
    return responses[idx++];
  };
}

function scriptedDispatch(
  outcomes: ToolExecutionOutcome[],
): (name: string, input: unknown, deps?: ToolDeps) => Promise<ToolExecutionOutcome> {
  let idx = 0;
  return async (name: string) => {
    if (idx >= outcomes.length) return { ok: false, toolName: name, error: "No more outcomes" };
    return outcomes[idx++];
  };
}

// Dispatch that passes through finalize args (so the runner's ID filter works)
function passthroughDispatch(
  toolOutcomes: Record<string, ToolExecutionOutcome[]>,
): (name: string, input: unknown, deps?: ToolDeps) => Promise<ToolExecutionOutcome> {
  const counters: Record<string, number> = {};
  return async (name: string, input: unknown) => {
    counters[name] = (counters[name] ?? 0);
    const queue = toolOutcomes[name];
    if (name === "finalize") {
      const inp = input as { summary: string; recommendation_ids: string[] };
      return {
        ok: true,
        toolName: "finalize",
        result: {
          status: "complete",
          summary: inp.summary,
          recommendationCount: inp.recommendation_ids.length,
          recommendationIds: inp.recommendation_ids,
        } satisfies FinalizeResult,
      };
    }
    if (queue && counters[name] < queue.length) {
      return queue[counters[name]++];
    }
    return { ok: false, toolName: name, error: `No mock for ${name}` };
  };
}

// Standard mock outcomes
const RESOLVED_RADIOHEAD: ToolExecutionOutcome = {
  ok: true,
  toolName: "resolve_anchor",
  result: {
    status: "resolved",
    entity: { entityId: "R-1", name: "Radiohead" },
    requestedType: "urn:entity:artist",
  } satisfies ResolveAnchorResult,
};

const AMBIGUOUS_OFFICE: ToolExecutionOutcome = {
  ok: true,
  toolName: "resolve_anchor",
  result: {
    status: "ambiguous",
    candidates: [
      { entityId: "OFF-UK", name: "The Office (UK)" },
      { entityId: "OFF-US", name: "The Office (US)" },
    ],
    requestedType: "urn:entity:tv_show",
  } satisfies ResolveAnchorResult,
};

const DISCOVER_RESULT: ToolExecutionOutcome = {
  ok: true,
  toolName: "discover_places",
  result: {
    city: "Berlin",
    accepted: [
      {
        entityId: "V-1", name: "Cool Venue",
        recommendation: {
          entityId: "V-1", name: "Cool Venue", label: "connection",
          connectionProvenance: [{ anchorId: "R-1", anchorName: "Radiohead", rank: 0, queryId: "anchor:R-1" }],
          categoryEvidence: undefined, explanation: "Taste graph.",
        },
        category: "Bar", address: "123 Street", neighborhood: "Mitte", website: null,
      },
      {
        entityId: "V-2", name: "Nice Cafe",
        recommendation: {
          entityId: "V-2", name: "Nice Cafe", label: "exploratory",
          connectionProvenance: [], categoryEvidence: undefined, explanation: "Exploratory.",
        },
        category: "Cafe", address: "456 Ave", neighborhood: "Kreuzberg", website: "https://nice.cafe",
      },
    ],
    reviewCount: 1, rejectedCount: 2,
    rejectedReasons: { hotel_accommodation: 2 },
    failureCount: 0,
    budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 5 },
  } satisfies DiscoverPlacesResult,
};

function makeFinalizeOutcome(ids: string[]): ToolExecutionOutcome {
  return {
    ok: true,
    toolName: "finalize",
    result: {
      status: "complete",
      summary: "Done.",
      recommendationCount: ids.length,
      recommendationIds: ids,
    } satisfies FinalizeResult,
  };
}

const FINALIZE_EMPTY = makeFinalizeOutcome([]);

const DEFAULT_INPUT: AgentRunInput = {
  city: "Berlin",
  anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
};

// ── Tests ─────────────────────────────────────────────────────

describe("runAgent — successful completion", () => {
  it("completes a resolve → discover → finalize loop with correct tool result IDs", async () => {
    const converse = scriptedConverse([
      makeOutput([
        text("Resolving Radiohead."),
        toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" }),
      ]),
      makeOutput([
        toolUse("c2", "discover_places", { anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c3", "finalize", { summary: "Found venues in Berlin.", recommendation_ids: ["V-1", "V-2"] }),
      ]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: passthroughDispatch({
        resolve_anchor: [RESOLVED_RADIOHEAD],
        discover_places: [DISCOVER_RESULT],
      }),
    });

    assert.equal(result.status, "completed");
    assert.ok(result.finalization);
    assert.equal(result.finalization!.summary, "Found venues in Berlin.");
    assert.deepEqual(result.finalization!.recommendationIds, ["V-1", "V-2"]);
    assert.equal(result.finalization!.recommendationCount, 2);
    assert.equal(result.toolCallCount, 3);
    assert.ok(result.runId.length > 0);

    const modelCalls = result.trace.filter((e) => e.type === "model_call");
    const toolDispatches = result.trace.filter((e) => e.type === "tool_dispatch");
    assert.equal(modelCalls.length, 3);
    assert.equal(toolDispatches.length, 3);
    assert.equal(toolDispatches[0].toolName, "resolve_anchor");
    assert.equal(toolDispatches[1].toolName, "discover_places");
    assert.equal(toolDispatches[2].toolName, "finalize");

    const discoverTrace = toolDispatches[1];
    assert.equal(discoverTrace.acceptedCount, 2);
    assert.equal(discoverTrace.rejectedCount, 2);
    assert.deepEqual(discoverTrace.rejectedReasons, { hotel_accommodation: 2 });

    for (let i = 0; i < result.trace.length; i++) {
      assert.equal(result.trace[i].id, i);
    }
    for (const event of result.trace) {
      assert.equal(event.fallbackUsed, false);
    }
  });

  it("accepts pre-confirmed anchors and skips resolution", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["PRE-1"], anchor_names: ["Pre"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["V-1"] }),
      ]),
    ]);

    const result = await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "PRE-1", name: "PreConfirmed" }] },
      { converse, dispatchToolCall: passthroughDispatch({ discover_places: [DISCOVER_RESULT] }) },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.toolCallCount, 2);
  });
});

describe("runAgent — multiple tool-use blocks", () => {
  it("processes two tool uses in a single model response", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" }),
        toolUse("c2", "resolve_anchor", { query: "Prateek Kuhad", type: "urn:entity:artist" }),
      ]),
      makeOutput([
        toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] }),
      ]),
    ]);

    const resolvedPK: ToolExecutionOutcome = {
      ok: true, toolName: "resolve_anchor",
      result: { status: "resolved", entity: { entityId: "PK-1", name: "Prateek Kuhad" }, requestedType: "urn:entity:artist" } satisfies ResolveAnchorResult,
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([RESOLVED_RADIOHEAD, resolvedPK, FINALIZE_EMPTY]),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.toolCallCount, 3);
    const resolves = result.trace.filter((e) => e.toolName === "resolve_anchor");
    assert.equal(resolves.length, 2);
  });

  it("counts repeated tool calls as distinct events", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([RESOLVED_RADIOHEAD, RESOLVED_RADIOHEAD, FINALIZE_EMPTY]),
    });

    assert.equal(result.toolCallCount, 3);
    const resolves = result.trace.filter((e) => e.toolName === "resolve_anchor");
    assert.equal(resolves.length, 2);
    assert.notEqual(resolves[0].id, resolves[1].id);
  });
});

describe("runAgent — tool call limit", () => {
  it("enforces 12-call hard limit before the 13th can execute", async () => {
    // 6 turns × 2 tool uses per turn = 12 calls, then 7th turn has 1 more → blocked
    const responses: ConverseOutput[] = [];
    const outcomes: ToolExecutionOutcome[] = [];

    for (let i = 0; i < 6; i++) {
      responses.push(makeOutput([
        toolUse(`a${i}`, "resolve_anchor", { query: "Test", type: "urn:entity:artist" }),
        toolUse(`b${i}`, "resolve_anchor", { query: "Test2", type: "urn:entity:artist" }),
      ]));
      outcomes.push(RESOLVED_RADIOHEAD, RESOLVED_RADIOHEAD);
    }
    // 7th turn: this would be the 13th call → blocked
    responses.push(makeOutput([
      toolUse("overflow", "finalize", { summary: "Done.", recommendation_ids: [] }),
    ]));
    outcomes.push(FINALIZE_EMPTY);

    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch(outcomes),
    });

    assert.equal(result.status, "call_limit_reached");
    assert.equal(result.toolCallCount, TOOL_CALL_LIMIT);
    assert.equal(result.finalization, undefined);

    const blocked = result.trace.filter((e) => e.status === "budget_blocked");
    assert.ok(blocked.length > 0);
    assert.ok(blocked[0].detail!.includes("Limit"));
  });

  it("counts multiple tool-use blocks in one response toward the limit", async () => {
    // 1 turn with 11 tool uses, then 1 turn with 2 tool uses = 13 total, 13th blocked
    const elevenUses: ContentBlock[] = [];
    const elevenOutcomes: ToolExecutionOutcome[] = [];
    for (let i = 0; i < 11; i++) {
      elevenUses.push(toolUse(`a${i}`, "resolve_anchor", { query: "Test", type: "urn:entity:artist" }));
      elevenOutcomes.push(RESOLVED_RADIOHEAD);
    }

    const responses = [
      makeOutput(elevenUses),
      makeOutput([
        toolUse("b0", "resolve_anchor", { query: "Test", type: "urn:entity:artist" }),
        toolUse("b1", "finalize", { summary: "Done.", recommendation_ids: [] }),
      ]),
    ];

    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch([...elevenOutcomes, RESOLVED_RADIOHEAD, FINALIZE_EMPTY]),
    });

    assert.equal(result.toolCallCount, 12);
    const blocked = result.trace.filter((e) => e.status === "budget_blocked");
    assert.equal(blocked.length, 1);
  });

  it("counts trust-blocked discover_places calls toward the 12-call limit", async () => {
    const responses: ConverseOutput[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push(makeOutput([
        toolUse(`a${i}`, "discover_places", { anchor_ids: ["R-1"], anchor_names: ["R"], city: "Tokyo" }),
        toolUse(`b${i}`, "discover_places", { anchor_ids: ["R-1"], anchor_names: ["R"], city: "Tokyo" }),
      ]));
    }
    responses.push(makeOutput([
      toolUse("fin", "finalize", { summary: "Done.", recommendation_ids: [] }),
    ]));

    const result = await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }] },
      { converse: scriptedConverse(responses), dispatchToolCall: passthroughDispatch({}) },
    );

    assert.equal(result.status, "call_limit_reached");
    assert.equal(result.toolCallCount, TOOL_CALL_LIMIT);
    const cityBlocks = result.trace.filter((e) => e.status === "city_mismatch");
    assert.equal(cityBlocks.length, 12);
    const budgetBlocked = result.trace.filter((e) => e.status === "budget_blocked");
    assert.ok(budgetBlocked.length > 0);
  });

  it("counts untrusted-anchor rejections toward the 12-call limit", async () => {
    const responses: ConverseOutput[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push(makeOutput([
        toolUse(`a${i}`, "discover_places", { anchor_ids: ["FAKE"], anchor_names: ["?"], city: "Berlin" }),
        toolUse(`b${i}`, "discover_places", { anchor_ids: ["FAKE"], anchor_names: ["?"], city: "Berlin" }),
      ]));
    }
    responses.push(makeOutput([
      toolUse("fin", "finalize", { summary: "Done.", recommendation_ids: [] }),
    ]));

    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: passthroughDispatch({}),
    });

    assert.equal(result.status, "call_limit_reached");
    assert.equal(result.toolCallCount, TOOL_CALL_LIMIT);
    const anchorBlocks = result.trace.filter((e) => e.status === "untrusted_anchor");
    assert.equal(anchorBlocks.length, 12);
  });
});

describe("runAgent — timeouts", () => {
  it("terminates on Bedrock call error (simulated timeout)", async () => {
    let callCount = 0;
    const converse = async (): Promise<ConverseOutput> => {
      callCount++;
      if (callCount === 1) {
        return makeOutput([toolUse("c1", "resolve_anchor", { query: "Test", type: "urn:entity:artist" })]);
      }
      await new Promise((_, reject) => setTimeout(() => reject(new Error("connection timed out")), 10));
      throw new Error("unreachable");
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([RESOLVED_RADIOHEAD]),
    });

    assert.equal(result.status, "model_error");
    assert.ok(result.trace.some((e) => e.status === "execution_error"));
  });

  it("does not interfere with fast tool dispatch", async () => {
    const slowDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps,
    ): Promise<ToolExecutionOutcome> => {
      await new Promise((r) => setTimeout(r, 10));
      if (name === "resolve_anchor") return RESOLVED_RADIOHEAD;
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "unknown" };
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "Test", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, { converse, dispatchToolCall: slowDispatch });

    assert.equal(result.status, "completed");
  });

  it("terminates dispatch that exceeds per-operation timeout", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "T", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const slowResolve = async (
      name: string, input: unknown, _deps?: ToolDeps,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "resolve_anchor") {
        await new Promise((r) => setTimeout(r, 300));
        return RESOLVED_RADIOHEAD;
      }
      const inp = input as { summary: string; recommendation_ids: string[] };
      return makeFinalizeOutcome(inp.recommendation_ids);
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: slowResolve,
      operationTimeoutMs: 50,
      totalRunTimeoutMs: 10_000,
    });

    assert.equal(result.status, "completed");
    const timeouts = result.trace.filter((e) => e.status === "timeout" && e.type === "tool_dispatch");
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].toolName, "resolve_anchor");
  });

  it("terminates with total_timeout when run deadline expires", async () => {
    const converse = async (): Promise<ConverseOutput> => {
      await new Promise((r) => setTimeout(r, 300));
      return makeOutput([toolUse("c1", "resolve_anchor", { query: "T", type: "urn:entity:artist" })]);
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([]),
      totalRunTimeoutMs: 50,
    });

    assert.equal(result.status, "total_timeout");
    assert.ok(result.trace.some((e) => e.terminationReason === "total_timeout"));
  });

  it("does not create unhandled promise rejections on dispatch timeout", async () => {
    let unhandled = false;
    const handler = () => { unhandled = true; };
    process.on("unhandledRejection", handler);

    try {
      const converse = scriptedConverse([
        makeOutput([toolUse("c1", "resolve_anchor", { query: "T", type: "urn:entity:artist" })]),
        makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
      ]);

      const rejectingDispatch = async (
        name: string, input: unknown, _deps?: ToolDeps,
      ): Promise<ToolExecutionOutcome> => {
        if (name === "resolve_anchor") {
          await new Promise((r) => setTimeout(r, 300));
          throw new Error("Late rejection after timeout");
        }
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      };

      await runAgent(DEFAULT_INPUT, {
        converse,
        dispatchToolCall: rejectingDispatch,
        operationTimeoutMs: 50,
        totalRunTimeoutMs: 10_000,
      });

      await new Promise((r) => setTimeout(r, 500));
      assert.equal(unhandled, false, "No unhandled promise rejections");
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });
});

describe("runAgent — Qloo budget", () => {
  it("enforces Qloo budget independently of tool-call limit", async () => {
    // discover_places with 5 anchors → estimated 6 Qloo calls each.
    // Budget is 25. 4×6 = 24, 5th needs 6 but only 1 remaining → blocked.
    const responses: ConverseOutput[] = [];
    const outcomes: ToolExecutionOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push(makeOutput([
        toolUse(`d${i}`, "discover_places", {
          anchor_ids: ["R-1", "R-2", "R-3", "R-4", "R-5"],
          anchor_names: ["A", "B", "C", "D", "E"],
          city: "Berlin",
        }),
      ]));
      outcomes.push(DISCOVER_RESULT);
    }

    const input: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "A" }, { entityId: "R-2", name: "B" },
        { entityId: "R-3", name: "C" }, { entityId: "R-4", name: "D" },
        { entityId: "R-5", name: "E" },
      ],
    };

    const result = await runAgent(input, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch(outcomes),
    });

    assert.equal(result.status, "qloo_budget_exhausted");
    assert.equal(result.toolCallCount, 5);
    assert.equal(result.qlooOutboundRequests, 24);
    const blocked = result.trace.filter(
      (e) => e.status === "budget_blocked" && e.terminationReason === "qloo_budget_exhausted",
    );
    assert.equal(blocked.length, 1);
  });

  it("Qloo budget and tool-call limit are independent — tool limit reached first when each call uses 1 Qloo request", async () => {
    // 6 turns × 2 resolve_anchor = 12 tool calls (limit), using 12 Qloo requests (under 25)
    const responses: ConverseOutput[] = [];
    const outcomes: ToolExecutionOutcome[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push(makeOutput([
        toolUse(`a${i}`, "resolve_anchor", { query: "T1", type: "urn:entity:artist" }),
        toolUse(`b${i}`, "resolve_anchor", { query: "T2", type: "urn:entity:artist" }),
      ]));
      outcomes.push(RESOLVED_RADIOHEAD, RESOLVED_RADIOHEAD);
    }
    responses.push(makeOutput([toolUse("x", "finalize", { summary: "D", recommendation_ids: [] })]));
    outcomes.push(FINALIZE_EMPTY);

    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch(outcomes),
    });

    assert.equal(result.status, "call_limit_reached");
    assert.equal(result.qlooOutboundRequests, 12);
    assert.ok(result.qlooOutboundRequests < QLOO_REQUEST_BUDGET);
  });
});

describe("runAgent — Qloo cache tracking", () => {
  it("does not count cached results as outbound requests", async () => {
    const fixture: SearchResponse = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "fixtures", "search-radiohead.json"), "utf-8"),
    );
    let searchCallCount = 0;
    const mockSearchEntity = async (
      query: string, _take?: number,
    ): Promise<QlooResult<SearchResponse>> => {
      searchCallCount++;
      return {
        data: fixture,
        meta: { path: "/search", params: { query }, cached: searchCallCount > 1 },
      };
    };

    const toolDeps: ToolDeps = {
      searchEntity: mockSearchEntity,
      searchTags: async () => { throw new Error("not needed"); },
    };

    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" }),
        toolUse("c2", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" }),
      ]),
      makeOutput([
        toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] }),
      ]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: realDispatchToolCall,
      toolDeps,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.qlooOutboundRequests, 1);
    assert.equal(result.qlooCacheHits, 1);
    assert.equal(searchCallCount, 2);
  });
});

describe("runAgent — error handling", () => {
  it("returns safe tool result on dispatch failure, allowing model recovery", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Recovered.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([
        { ok: false, toolName: "resolve_anchor", error: "Temporary API error" },
        RESOLVED_RADIOHEAD,
        FINALIZE_EMPTY,
      ]),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.toolCallCount, 3);
    const errors = result.trace.filter((e) => e.status === "execution_error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].detail!.includes("Temporary"));
  });

  it("returns controlled termination on Bedrock failure without leaking credentials", async () => {
    const converse = async (): Promise<ConverseOutput> => {
      throw new Error("AccessDeniedException: secret_access_key=AKIA123 is invalid");
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([]),
    });

    assert.equal(result.status, "model_error");
    const errorEvent = result.trace.find((e) => e.status === "execution_error");
    assert.ok(errorEvent);
    assert.ok(!errorEvent!.detail!.includes("AKIA123"));
    assert.ok(!errorEvent!.detail!.includes("secret"));
    assert.equal(errorEvent!.detail, "Operation failed due to a configuration error.");
  });

  it("does not count model text response without finalization as completion", async () => {
    const converse = scriptedConverse([
      makeOutput([text("I think Berlin is great!")], "end_turn"),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([]),
    });

    assert.equal(result.status, "malformed_response");
    assert.equal(result.finalization, undefined);
    assert.ok(result.trace.some((e) => e.detail === "Model ended without finalize"));
  });
});

describe("runAgent — trusted state: finalize validation", () => {
  it("filters out unknown and invented recommendation IDs", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["V-1", "FAKE-ID", "V-2", "INVENTED"] }),
      ]),
    ]);

    const result = await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }] },
      { converse, dispatchToolCall: passthroughDispatch({ discover_places: [DISCOVER_RESULT] }) },
    );

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["V-1", "V-2"]);
    assert.equal(result.finalization!.recommendationCount, 2);

    const filtered = result.trace.filter((e) => e.status === "filtered_ids");
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].detail!.includes("FAKE-ID"));
    assert.ok(filtered[0].detail!.includes("INVENTED"));
  });

  it("returns invalid_finalization when all IDs are unknown", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "finalize", { summary: "Done.", recommendation_ids: ["FAKE-1", "FAKE-2"] }),
      ]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: passthroughDispatch({}),
    });

    assert.equal(result.status, "invalid_finalization");
    assert.equal(result.finalization, undefined);
  });

  it("accepts finalize with empty recommendation_ids without filtering", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "finalize", { summary: "Nothing found.", recommendation_ids: [] }),
      ]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: passthroughDispatch({}),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, []);
    assert.equal(result.finalization!.recommendationCount, 0);
  });

  it("rejects review-only entity IDs in finalize", async () => {
    // DISCOVER_RESULT has V-1 and V-2 in accepted. REVIEW-1 is not.
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["V-1", "REVIEW-1"] }),
      ]),
    ]);

    const result = await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }] },
      { converse, dispatchToolCall: passthroughDispatch({ discover_places: [DISCOVER_RESULT] }) },
    );

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["V-1"]);
    const filtered = result.trace.filter((e) => e.status === "filtered_ids");
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].detail!.includes("REVIEW-1"));
  });
});

describe("runAgent — trusted state: city and anchors", () => {
  it("blocks discover_places with a different city", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Tokyo" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] }),
      ]),
    ]);

    const result = await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }] },
      { converse, dispatchToolCall: passthroughDispatch({}) },
    );

    assert.equal(result.status, "completed");
    const cityBlock = result.trace.find((e) => e.status === "city_mismatch");
    assert.ok(cityBlock);
    assert.ok(cityBlock!.detail!.includes("Tokyo"));
    assert.ok(cityBlock!.detail!.includes("Berlin"));
  });

  it("blocks discover_places with untrusted anchor IDs", async () => {
    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["UNRESOLVED-ID"], anchor_names: ["?"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] }),
      ]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: passthroughDispatch({}),
    });

    assert.equal(result.status, "completed");
    const anchorBlock = result.trace.find((e) => e.status === "untrusted_anchor");
    assert.ok(anchorBlock);
    assert.ok(anchorBlock!.detail!.includes("UNRESOLVED-ID"));
  });

  it("does not promote ambiguous resolution to confirmed anchor", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "The Office", type: "urn:entity:tv_show" })]),
      makeOutput([
        toolUse("c2", "discover_places", { anchor_ids: ["OFF-UK"], anchor_names: ["The Office (UK)"], city: "Berlin" }),
      ]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(
      { city: "Berlin", anchors: [{ query: "The Office", type: "urn:entity:tv_show" }] },
      { converse, dispatchToolCall: passthroughDispatch({ resolve_anchor: [AMBIGUOUS_OFFICE] }) },
    );

    assert.equal(result.status, "completed");
    const blocked = result.trace.find((e) => e.status === "untrusted_anchor");
    assert.ok(blocked);
    assert.ok(blocked!.detail!.includes("OFF-UK"));
  });

  it("overrides model-provided anchor names with trusted names", async () => {
    let capturedInput: unknown;
    const trackingDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "discover_places") { capturedInput = input; return DISCOVER_RESULT; }
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "?" };
    };

    const converse = scriptedConverse([
      makeOutput([
        toolUse("c1", "discover_places", { anchor_ids: ["R-1"], anchor_names: ["WRONG"], city: "Berlin" }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["V-1"] }),
      ]),
    ]);

    await runAgent(
      { city: "Berlin", anchors: [], confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }] },
      { converse, dispatchToolCall: trackingDispatch },
    );

    const dp = capturedInput as Record<string, unknown>;
    assert.deepEqual(dp.anchor_names, ["Radiohead"]);
  });
});

describe("runAgent — malformed responses", () => {
  it("terminates on empty content", async () => {
    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse([makeOutput([], "end_turn")]),
      dispatchToolCall: scriptedDispatch([]),
    });
    assert.equal(result.status, "malformed_response");
    assert.ok(result.trace.some((e) => e.detail === "Empty content"));
  });

  it("terminates on content_filtered stop reason", async () => {
    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse([makeOutput([text("Filtered")], "content_filtered")]),
      dispatchToolCall: scriptedDispatch([]),
    });
    assert.equal(result.status, "content_filtered");
  });

  it("terminates on max_tokens without tool use", async () => {
    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse([makeOutput([text("Truncated...")], "max_tokens")]),
      dispatchToolCall: scriptedDispatch([]),
    });
    assert.equal(result.status, "malformed_response");
    assert.ok(result.trace.some((e) => e.detail === "Truncated at max_tokens"));
  });

  it("terminates after max turns without finalize", async () => {
    const responses: ConverseOutput[] = [];
    const outcomes: ToolExecutionOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      responses.push(makeOutput([toolUse(`c${i}`, "resolve_anchor", { query: "T", type: "urn:entity:artist" })]));
      outcomes.push(RESOLVED_RADIOHEAD);
    }
    const result = await runAgent(DEFAULT_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch(outcomes),
    });
    assert.equal(result.status, "malformed_response");
    assert.ok(result.trace.some((e) => e.detail?.includes("Max turns")));
  });
});

describe("runAgent — trace completeness", () => {
  it("records sequential event IDs and timestamps for every operation", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([RESOLVED_RADIOHEAD, FINALIZE_EMPTY]),
    });

    for (let i = 0; i < result.trace.length; i++) {
      assert.equal(result.trace[i].id, i);
      assert.ok(result.trace[i].timestamp.length > 0);
      assert.ok(result.trace[i].durationMs >= 0);
      assert.equal(result.trace[i].fallbackUsed, false);
    }
    assert.ok(result.trace.length >= 4);
  });

  it("includes sanitized tool input in trace events", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "Radiohead", type: "urn:entity:artist", api_key: "should-be-redacted" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([RESOLVED_RADIOHEAD, FINALIZE_EMPTY]),
    });

    const resolveEvent = result.trace.find((e) => e.toolName === "resolve_anchor");
    assert.ok(resolveEvent);
    assert.equal(resolveEvent!.toolInput!.query, "Radiohead");
    assert.equal(resolveEvent!.toolInput!.api_key, "[REDACTED]");
  });
});

describe("runAgent — abort signal propagation", () => {
  it("passes AbortSignal to Bedrock converse", async () => {
    let receivedSignal: AbortSignal | undefined;
    const converse = async (input: ConverseInput): Promise<ConverseOutput> => {
      receivedSignal = input.signal;
      return makeOutput([toolUse("c1", "finalize", { summary: "D.", recommendation_ids: [] })]);
    };

    await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: passthroughDispatch({}),
    });

    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal!.aborted, false);
  });

  it("passes AbortSignal to tool dispatch", async () => {
    let receivedSignal: AbortSignal | undefined;
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "T", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "D.", recommendation_ids: [] })]),
    ]);

    const trackingDispatch = async (
      name: string, _input: unknown, _deps?: ToolDeps, signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "resolve_anchor") { receivedSignal = signal; return RESOLVED_RADIOHEAD; }
      return FINALIZE_EMPTY;
    };

    await runAgent(DEFAULT_INPUT, { converse, dispatchToolCall: trackingDispatch });

    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal!.aborted, false);
  });

  it("aborts dispatch signal on per-operation timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "resolve_anchor", { query: "T", type: "urn:entity:artist" })]),
      makeOutput([toolUse("c2", "finalize", { summary: "D.", recommendation_ids: [] })]),
    ]);

    const slowDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "resolve_anchor") {
        capturedSignal = signal;
        return new Promise((resolve) => {
          const done = () => resolve(RESOLVED_RADIOHEAD);
          signal?.addEventListener("abort", () => done(), { once: true });
          setTimeout(done, 500);
        });
      }
      const inp = input as { summary: string; recommendation_ids: string[] };
      return makeFinalizeOutcome(inp.recommendation_ids);
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: slowDispatch,
      operationTimeoutMs: 50,
      totalRunTimeoutMs: 10_000,
    });

    assert.equal(result.status, "completed");
    assert.ok(capturedSignal);
    assert.equal(capturedSignal!.aborted, true);
  });

  it("aborts converse signal on total-run timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    const converse = async (input: ConverseInput): Promise<ConverseOutput> => {
      capturedSignal = input.signal;
      await new Promise((r) => setTimeout(r, 300));
      return makeOutput([toolUse("c1", "finalize", { summary: "D.", recommendation_ids: [] })]);
    };

    const result = await runAgent(DEFAULT_INPUT, {
      converse,
      dispatchToolCall: scriptedDispatch([]),
      totalRunTimeoutMs: 50,
    });

    assert.equal(result.status, "total_timeout");
    assert.ok(capturedSignal);
    assert.equal(capturedSignal!.aborted, true);
  });
});

// ── Fallback chain tests ──────────────────────────────────────

const DISCOVER_EMPTY: ToolExecutionOutcome = {
  ok: true,
  toolName: "discover_places",
  result: {
    city: "Berlin",
    accepted: [],
    reviewCount: 2, rejectedCount: 3,
    rejectedReasons: { hotel_accommodation: 2, transit_airport: 1 },
    failureCount: 0,
    budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 5 },
  } satisfies DiscoverPlacesResult,
};

const DISCOVER_REVIEW_ONLY: ToolExecutionOutcome = {
  ok: true,
  toolName: "discover_places",
  result: {
    city: "Berlin",
    accepted: [],
    reviewCount: 4, rejectedCount: 1,
    rejectedReasons: { category_conflict: 1 },
    failureCount: 0,
    budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 5 },
  } satisfies DiscoverPlacesResult,
};

const FIND_TAGS_MUSIC: ToolExecutionOutcome = {
  ok: true,
  toolName: "find_tags",
  result: {
    tags: [
      { id: "urn:tag:good_for:qloo:live_music", name: "Live Music", type: "urn:tag:good_for:qloo" },
      { id: "urn:tag:category:place:live_music_venue", name: "Live Music Venue", type: "urn:tag:category:place" },
      { id: "urn:tag:category:place:music_venue", name: "Music Venue", type: "urn:tag:category:place" },
    ],
  } satisfies FindTagsResult,
};

const FIND_TAGS_EMPTY: ToolExecutionOutcome = {
  ok: true,
  toolName: "find_tags",
  result: { tags: [] } satisfies FindTagsResult,
};

const FIND_TAGS_NO_PLACE_CATEGORY: ToolExecutionOutcome = {
  ok: true,
  toolName: "find_tags",
  result: {
    tags: [
      { id: "urn:tag:good_for:qloo:coffee", name: "Coffee", type: "urn:tag:good_for:qloo" },
      { id: "urn:tag:amenity:qloo:coffee", name: "Coffee", type: "urn:tag:amenity:qloo" },
    ],
  } satisfies FindTagsResult,
};

function makeDiscoverWithAccepted(entityId: string, entityName: string): ToolExecutionOutcome {
  return {
    ok: true,
    toolName: "discover_places",
    result: {
      city: "Berlin",
      accepted: [{
        entityId, name: entityName,
        recommendation: {
          entityId, name: entityName, label: "exploratory",
          connectionProvenance: [], categoryEvidence: undefined,
          explanation: "Exploratory.",
        },
        category: null, address: "1 Main St", neighborhood: null, website: null,
      }],
      reviewCount: 0, rejectedCount: 0, rejectedReasons: {},
      failureCount: 0,
      budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 1 },
    } satisfies DiscoverPlacesResult,
  };
}

function fallbackDispatch(
  outcomes: Record<string, ToolExecutionOutcome[]>,
): (name: string, input: unknown, deps?: ToolDeps, signal?: AbortSignal) => Promise<ToolExecutionOutcome> {
  const counters: Record<string, number> = {};
  return async (name: string, input: unknown) => {
    counters[name] = counters[name] ?? 0;
    const queue = outcomes[name];
    if (name === "finalize") {
      const inp = input as { summary: string; recommendation_ids: string[] };
      return {
        ok: true, toolName: "finalize",
        result: { status: "complete", summary: inp.summary, recommendationCount: inp.recommendation_ids.length, recommendationIds: inp.recommendation_ids } satisfies FinalizeResult,
      };
    }
    if (queue && counters[name] < queue.length) {
      return queue[counters[name]++];
    }
    return { ok: false, toolName: name, error: `No mock for ${name} call #${counters[name]}` };
  };
}

const FALLBACK_INPUT: AgentRunInput = {
  city: "Berlin",
  anchors: [],
  confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }],
};

describe("runAgent — fallback: coffee exception (Stage 1 skip → Stage 2)", () => {
  it("skips known-empty coffee tag and uses tagless fallback with client-side classification", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:coffee",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Found via fallback.", recommendation_ids: ["FB-1"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-1", "Coffee House")],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["FB-1"]);

    const skipped = result.trace.filter((e) => e.status === "fallback_skipped" && e.fallbackStage === "alt_tag");
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0].fallbackReason!.includes("Known empty tag"));

    const dropTag = result.trace.filter((e) => e.fallbackStage === "drop_tag" && e.status === "fallback_success");
    assert.equal(dropTag.length, 1);
    assert.equal(dropTag[0].tagDropped, true);
    assert.equal(dropTag[0].fallbackUsed, true);
  });
});

describe("runAgent — fallback: Stage 1 alternative tag", () => {
  it("tries a grounded alternative tag from find_tags when category query fails", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-2"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-2", "Music Hall")],
        find_tags: [FIND_TAGS_MUSIC],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["FB-2"]);

    const altTag = result.trace.filter((e) => e.fallbackStage === "alt_tag" && e.status === "fallback_success");
    assert.equal(altTag.length, 1);
    assert.equal(altTag[0].alternativeTagId, "urn:tag:category:place:live_music_venue");
    assert.equal(altTag[0].originalTagId, "urn:tag:category:place:concert_hall");
    assert.equal(altTag[0].fallbackUsed, true);
  });

  it("uses exact tag ID returned by Qloo, never synthesizes one", async () => {
    let capturedInputs: unknown[] = [];
    const trackingDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, _signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      capturedInputs.push({ name, input });
      if (name === "find_tags") return FIND_TAGS_MUSIC;
      if (name === "discover_places") {
        const dp = input as { category_tag_id?: string };
        if (dp.category_tag_id === "urn:tag:category:place:concert_hall") return (DISCOVER_EMPTY as any).result ? DISCOVER_EMPTY : DISCOVER_EMPTY;
        return makeDiscoverWithAccepted("FB-3", "Venue");
      }
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "unexpected" };
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-3"] })]),
    ]);

    await runAgent(FALLBACK_INPUT, { converse, dispatchToolCall: trackingDispatch });

    const discoverCalls = capturedInputs.filter((c: any) => c.name === "discover_places");
    assert.ok(discoverCalls.length >= 2);
    const fallbackCall = discoverCalls[1] as any;
    assert.equal(fallbackCall.input.category_tag_id, "urn:tag:category:place:live_music_venue");
  });

  it("skips irrelevant tag families (good_for, amenity) and uses only category:place tags", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:some_category",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY],
        find_tags: [FIND_TAGS_NO_PLACE_CATEGORY],
      }),
    });

    const altTagSkipped = result.trace.filter(
      (e) => e.fallbackStage === "alt_tag" && e.status === "fallback_skipped",
    );
    assert.equal(altTagSkipped.length, 1);
    assert.ok(altTagSkipped[0].fallbackReason!.includes("No grounded alternative"));
  });
});

describe("runAgent — fallback: Stage 2 drop tag", () => {
  it("advances to Stage 2 when alternative tag also yields no results", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-4"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-4", "A Place")],
        find_tags: [FIND_TAGS_MUSIC],
      }),
    });

    assert.equal(result.status, "completed");

    const altTagNoResults = result.trace.filter(
      (e) => e.fallbackStage === "alt_tag" && e.status === "fallback_no_results",
    );
    assert.equal(altTagNoResults.length, 1);

    const dropTag = result.trace.filter(
      (e) => e.fallbackStage === "drop_tag" && e.status === "fallback_success",
    );
    assert.equal(dropTag.length, 1);
    assert.equal(dropTag[0].tagDropped, true);
  });
});

describe("runAgent — fallback: Stage 3 broaden anchors", () => {
  it("broadens to additional confirmed anchors when Stages 1-2 fail", async () => {
    const multiAnchorInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-5"] })]),
    ]);

    const result = await runAgent(multiAnchorInput, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-5", "Broadened Venue")],
        find_tags: [FIND_TAGS_MUSIC],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["FB-5"]);

    const broaden = result.trace.filter(
      (e) => e.fallbackStage === "broaden" && e.status === "fallback_success",
    );
    assert.equal(broaden.length, 1);
    assert.ok(broaden[0].anchorIdsUsed!.includes("R-1"));
    assert.ok(broaden[0].anchorIdsUsed!.includes("PK-1"));
    assert.equal(broaden[0].fallbackUsed, true);
  });

  it("uses only trusted confirmed anchors and correct city", async () => {
    let capturedBroadenInput: unknown;
    const multiAnchorInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const trackingDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, _signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "discover_places") {
        const dp = input as { anchor_ids: string[]; city: string };
        if (dp.anchor_ids.length > 1) capturedBroadenInput = input;
        if (dp.anchor_ids.length === 1) return DISCOVER_EMPTY as ToolExecutionOutcome;
        return makeDiscoverWithAccepted("FB-6", "Place");
      }
      if (name === "find_tags") return FIND_TAGS_EMPTY;
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "?" };
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-6"] })]),
    ]);

    await runAgent(multiAnchorInput, { converse, dispatchToolCall: trackingDispatch });

    const dp = capturedBroadenInput as any;
    assert.ok(dp);
    assert.equal(dp.city, "Berlin");
    assert.deepEqual(dp.anchor_ids.sort(), ["PK-1", "R-1"]);
    assert.deepEqual(dp.anchor_names.sort(), ["Prateek Kuhad", "Radiohead"]);
  });

  it("skips broadening when no additional trusted anchors exist", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Nothing.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY],
        find_tags: [FIND_TAGS_EMPTY],
      }),
    });

    const broadenSkipped = result.trace.filter(
      (e) => e.fallbackStage === "broaden" && e.status === "fallback_skipped",
    );
    assert.equal(broadenSkipped.length, 1);
    assert.ok(broadenSkipped[0].fallbackReason!.includes("No additional trusted anchors"));

    const exhausted = result.trace.filter((e) => e.status === "fallback_exhausted");
    assert.equal(exhausted.length, 1);
  });
});

describe("runAgent — fallback: accepted results stop chain", () => {
  it("does not trigger fallback when initial discover returns accepted results", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["V-1", "V-2"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({ discover_places: [DISCOVER_RESULT] }),
    });

    assert.equal(result.status, "completed");
    const fbEvents = result.trace.filter((e) => e.type === "fallback");
    assert.equal(fbEvents.length, 0);
  });

  it("review-only or rejected results do not count as successful recovery", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_REVIEW_ONLY, DISCOVER_REVIEW_ONLY, DISCOVER_REVIEW_ONLY, DISCOVER_REVIEW_ONLY],
        find_tags: [FIND_TAGS_EMPTY],
      }),
    });

    const triggered = result.trace.filter((e) => e.status === "fallback_triggered");
    assert.equal(triggered.length, 1);

    const exhausted = result.trace.filter((e) => e.status === "fallback_exhausted");
    assert.equal(exhausted.length, 1);
  });
});

describe("runAgent — fallback: duplicate and loop prevention", () => {
  it("blocks re-discovery of exhausted objectives", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY],
        find_tags: [FIND_TAGS_EMPTY],
      }),
    });

    const blocked = result.trace.filter((e) => e.status === "duplicate_blocked");
    assert.equal(blocked.length, 1);
    assert.ok(blocked[0].detail!.includes("already exhausted"));
  });

  it("does not repeat an identical exhausted query — fallback uses distinct parameters each stage", async () => {
    let discoverInputs: unknown[] = [];
    const trackingDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, _signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "discover_places") {
        discoverInputs.push(input);
        return DISCOVER_EMPTY as ToolExecutionOutcome;
      }
      if (name === "find_tags") return FIND_TAGS_MUSIC;
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "?" };
    };

    const multiInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    await runAgent(multiInput, { converse, dispatchToolCall: trackingDispatch });

    const paramSigs = discoverInputs.map((d: any) =>
      JSON.stringify({ ids: [...d.anchor_ids].sort(), tag: d.category_tag_id ?? null }),
    );
    const uniqueParams = new Set(paramSigs);
    assert.equal(uniqueParams.size, paramSigs.length, `Expected all discover calls to have unique params, got: ${paramSigs.join(", ")}`);
  });
});

describe("runAgent — fallback: budgets and limits still apply", () => {
  it("fallback tool calls count toward 12-call limit", async () => {
    // 9 resolves + 1 discover (w/ tag) → 10 tool calls
    // Fallback find_tags → 11, fallback discover → 12 (limit reached)
    const responses: ConverseOutput[] = [];
    for (let i = 0; i < 9; i++) {
      responses.push(makeOutput([toolUse(`r${i}`, "resolve_anchor", { query: "T", type: "urn:entity:artist" })]));
    }
    responses.push(makeOutput([toolUse("d1", "discover_places", {
      anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
      category_tag_id: "urn:tag:category:place:bar",
    })]));
    responses.push(makeOutput([toolUse("fin", "finalize", { summary: "D.", recommendation_ids: [] })]));

    const outcomes: ToolExecutionOutcome[] = [];
    for (let i = 0; i < 9; i++) outcomes.push(RESOLVED_RADIOHEAD);
    outcomes.push(DISCOVER_EMPTY);       // initial discover → 0 accepted
    outcomes.push(FIND_TAGS_MUSIC);      // fallback find_tags
    outcomes.push(DISCOVER_EMPTY);       // fallback alt_tag discover → 0 accepted
    // Budget for drop_tag and broaden should be blocked

    const result = await runAgent(FALLBACK_INPUT, {
      converse: scriptedConverse(responses),
      dispatchToolCall: scriptedDispatch(outcomes),
    });

    assert.equal(result.toolCallCount, TOOL_CALL_LIMIT);

    const budgetBlocked = result.trace.filter(
      (e) => e.type === "fallback" && e.status === "budget_blocked",
    );
    assert.ok(budgetBlocked.length > 0);
  });

  it("fallback Qloo calls count toward the 25-request budget", async () => {
    // Each discover_places with 1 anchor → 2 Qloo calls (1 single + 1 blended)
    // find_tags → 1 Qloo call
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-7"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-7", "Place")],
        find_tags: [FIND_TAGS_MUSIC],
      }),
    });

    assert.equal(result.status, "completed");
    // Initial (2) + find_tags (1) + alt_tag discover (2) + drop_tag discover (2) = 7
    assert.ok(result.qlooOutboundRequests >= 4);
  });

  it("cancellation and timeouts still apply during fallback", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const slowDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, _signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "discover_places") {
        await new Promise((r) => setTimeout(r, 30));
        return DISCOVER_EMPTY as ToolExecutionOutcome;
      }
      if (name === "find_tags") {
        await new Promise((r) => setTimeout(r, 30));
        return FIND_TAGS_EMPTY;
      }
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "?" };
    };

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: slowDispatch,
      totalRunTimeoutMs: 40,
    });

    assert.equal(result.status, "total_timeout");
  });
});

describe("runAgent — fallback: trace accuracy", () => {
  it("records fallback stages, outcomes, and cache metadata accurately", async () => {
    const multiInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:concert_hall",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-8"] })]),
    ]);

    const result = await runAgent(multiInput, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-8", "Final")],
        find_tags: [FIND_TAGS_MUSIC],
      }),
    });

    const triggered = result.trace.filter((e) => e.status === "fallback_triggered");
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].type, "fallback");
    assert.equal(triggered[0].originalTagId, "urn:tag:category:place:concert_hall");

    const altTag = result.trace.filter((e) => e.fallbackStage === "alt_tag");
    assert.ok(altTag.length > 0);
    assert.equal(altTag[0].originalTagId, "urn:tag:category:place:concert_hall");

    const dropTag = result.trace.filter((e) => e.fallbackStage === "drop_tag");
    assert.ok(dropTag.length > 0);
    assert.equal(dropTag[0].tagDropped, true);

    const broaden = result.trace.filter((e) => e.fallbackStage === "broaden");
    assert.ok(broaden.length > 0);
    assert.ok(broaden[0].anchorIdsUsed!.length > 1);

    for (const e of result.trace) {
      assert.equal(typeof e.id, "number");
      assert.ok(e.timestamp.length > 0);
    }

    const ids = result.trace.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], "Event IDs must be sequential");
    }

    const fbEvents = result.trace.filter((e) => e.fallbackUsed === true);
    assert.ok(fbEvents.length > 0, "fallbackUsed must be true for at least some events");
  });

  it("model error and budget exhaustion during fallback produce controlled outcomes", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const failingDispatch = async (
      name: string, input: unknown, _deps?: ToolDeps, _signal?: AbortSignal,
    ): Promise<ToolExecutionOutcome> => {
      if (name === "discover_places") return DISCOVER_EMPTY as ToolExecutionOutcome;
      if (name === "find_tags") return { ok: false, toolName: name, error: "API failure" };
      if (name === "finalize") {
        const inp = input as { summary: string; recommendation_ids: string[] };
        return makeFinalizeOutcome(inp.recommendation_ids);
      }
      return { ok: false, toolName: name, error: "?" };
    };

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: failingDispatch,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.finalization!.recommendationCount, 0);

    const exhausted = result.trace.filter((e) => e.status === "fallback_exhausted");
    assert.equal(exhausted.length, 1);
  });
});

describe("runAgent — fallback: no-tag discovery (direct to Stage 3)", () => {
  it("goes directly to Stage 3 broaden when no category tag was used", async () => {
    const multiInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
      })]),
      makeOutput([toolUse("c2", "finalize", { summary: "Done.", recommendation_ids: ["FB-9"] })]),
    ]);

    const result = await runAgent(multiInput, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [DISCOVER_EMPTY, makeDiscoverWithAccepted("FB-9", "Broadened")],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["FB-9"]);

    const altTag = result.trace.filter((e) => e.fallbackStage === "alt_tag");
    assert.equal(altTag.length, 0);
    const dropTag = result.trace.filter((e) => e.fallbackStage === "drop_tag");
    assert.equal(dropTag.length, 0);

    const broaden = result.trace.filter((e) => e.fallbackStage === "broaden" && e.status === "fallback_success");
    assert.equal(broaden.length, 1);
    assert.ok(broaden[0].anchorIdsUsed!.includes("PK-1"));
  });
});

describe("runAgent — fallback: objective identity includes category tag", () => {
  it("exhausting live music does not block a subsequent bookstore query with same anchors and city", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:live_music_venue",
      })]),
      makeOutput([toolUse("c2", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bookstore",
      })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: ["BS-1"] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [
          DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY,
          makeDiscoverWithAccepted("BS-1", "Berlin Books"),
        ],
        find_tags: [FIND_TAGS_EMPTY, FIND_TAGS_EMPTY],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["BS-1"]);

    const blocked = result.trace.filter((e) => e.status === "duplicate_blocked");
    assert.equal(blocked.length, 0, "Bookstore query must not be duplicate-blocked");

    const exhausted = result.trace.filter((e) => e.status === "fallback_exhausted");
    assert.equal(exhausted.length, 1, "Only live_music objective should be exhausted");
  });

  it("exhausting a tagged objective does not block a legitimate tagless objective", async () => {
    const multiInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Prateek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
      })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: ["TL-1"] })]),
    ]);

    const result = await runAgent(multiInput, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [
          DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY,
          makeDiscoverWithAccepted("TL-1", "Tagless Place"),
        ],
        find_tags: [FIND_TAGS_EMPTY],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalization!.recommendationIds, ["TL-1"]);

    const blocked = result.trace.filter((e) => e.status === "duplicate_blocked");
    assert.equal(blocked.length, 0, "Tagless query must not be duplicate-blocked");
  });

  it("reordering anchors does not bypass duplicate prevention for an exhausted identical objective", async () => {
    const multiInput: AgentRunInput = {
      city: "Berlin", anchors: [],
      confirmedAnchors: [
        { entityId: "R-1", name: "Radiohead" },
        { entityId: "PK-1", name: "Praterek Kuhad" },
      ],
    };

    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1", "PK-1"], anchor_names: ["Radiohead", "Prateek Kuhad"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "discover_places", {
        anchor_ids: ["PK-1", "R-1"], anchor_names: ["Prateek Kuhad", "Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c3", "finalize", { summary: "Done.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(multiInput, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [
          DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY,
        ],
        find_tags: [FIND_TAGS_EMPTY],
      }),
    });

    const blocked = result.trace.filter((e) => e.status === "duplicate_blocked");
    assert.equal(blocked.length, 1, "Reordered anchors must still be duplicate-blocked");
    assert.ok(blocked[0].detail!.includes("already exhausted"));
  });

  it("same anchors+city with different tags produce independent exhaustion", async () => {
    const converse = scriptedConverse([
      makeOutput([toolUse("c1", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c2", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:cafe",
      })]),
      makeOutput([toolUse("c3", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:bar",
      })]),
      makeOutput([toolUse("c4", "discover_places", {
        anchor_ids: ["R-1"], anchor_names: ["Radiohead"], city: "Berlin",
        category_tag_id: "urn:tag:category:place:cafe",
      })]),
      makeOutput([toolUse("c5", "finalize", { summary: "Nothing.", recommendation_ids: [] })]),
    ]);

    const result = await runAgent(FALLBACK_INPUT, {
      converse,
      dispatchToolCall: fallbackDispatch({
        discover_places: [
          DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY,
          DISCOVER_EMPTY, DISCOVER_EMPTY, DISCOVER_EMPTY,
        ],
        find_tags: [FIND_TAGS_EMPTY, FIND_TAGS_EMPTY],
      }),
    });

    const exhausted = result.trace.filter((e) => e.status === "fallback_exhausted");
    assert.equal(exhausted.length, 2, "Both bar and cafe objectives should be independently exhausted");

    const blocked = result.trace.filter((e) => e.status === "duplicate_blocked");
    assert.equal(blocked.length, 2, "Both retries should be duplicate-blocked");
  });
});

describe("runAgent — model context compaction and pre-confirmed anchor deduplication", () => {
  it("compacts discover_places toolResult for the model while preserving full tags and details in structured output", async () => {
    const manyTags = Array.from({ length: 60 }, (_, idx) => ({
      id: idx === 0 ? "urn:tag:category:place:live_music_venue" : `urn:tag:keyword:place:kw_${idx}`,
      name: idx === 0 ? "Live Music Venue" : `Keyword ${idx}`,
      type: idx === 0 ? "urn:tag:category:place" : "urn:tag:keyword:place",
    }));

    const heavyDiscoverOutcome: ToolExecutionOutcome = {
      ok: true,
      toolName: "discover_places",
      result: {
        city: "Berlin",
        accepted: [
          {
            entityId: "V-HEAVY",
            name: "SO36",
            recommendation: {
              entityId: "V-HEAVY",
              name: "SO36",
              label: "connection",
              connectionProvenance: [
                { anchorId: "R-1", anchorName: "Radiohead", rank: 0, queryId: "anchor:R-1" },
              ],
              categoryEvidence: undefined,
              explanation: "Qloo's taste graph surfaced this place when asked about Radiohead.",
            },
            category: "Live Music Venue",
            address: "Oranienstraße 190",
            neighborhood: "Kreuzberg",
            website: "https://so36.com",
            phone: "+49 30 61401306",
            priceLevel: 2,
            location: { lat: 52.5005, lon: 13.4222 },
            mappable: true,
            tags: manyTags,
            sourceQueryTypes: ["single-anchor"],
          },
        ],
        reviewCount: 0,
        rejectedCount: 1,
        rejectedReasons: { hotel_accommodation: 1 },
        failureCount: 0,
        budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 2 },
      } satisfies DiscoverPlacesResult,
    };

    const capturedConverseInputs: ConverseInput[] = [];
    const responses = [
      makeOutput([
        toolUse("c1", "discover_places", {
          anchor_ids: ["R-1"],
          anchor_names: ["Radiohead"],
          city: "Berlin",
        }),
      ]),
      makeOutput([
        toolUse("c2", "finalize", {
          summary: "Top Berlin venue.",
          recommendation_ids: ["V-HEAVY"],
        }),
      ]),
    ];

    let turnIdx = 0;
    const result = await runAgent(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }],
      },
      {
        converse: async (inp) => {
          capturedConverseInputs.push({
            ...inp,
            messages: inp.messages.map((m) => ({ ...m, content: [...m.content] })),
          });
          return responses[turnIdx++];
        },
        dispatchToolCall: passthroughDispatch({
          discover_places: [heavyDiscoverOutcome],
        }),
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(capturedConverseInputs.length, 2);

    // 1. Pre-confirmed anchor "Radiohead" must not be redundantly listed under "Anchors to resolve:"
    assert.equal(
      capturedConverseInputs[0].system?.includes("Anchors to resolve:"),
      false,
    );
    assert.ok(
      capturedConverseInputs[0].system?.includes("Pre-confirmed anchors"),
    );
    assert.deepEqual(capturedConverseInputs[0].tools?.toolChoice, { any: {} });

    // 2. Turn 2 toolResult sent to the model must be compacted (no 60-element raw tags array)
    const turn2UserMsg = capturedConverseInputs[1].messages[2];
    const toolResultBlock = turn2UserMsg.content[0];
    assert.ok("toolResult" in toolResultBlock && toolResultBlock.toolResult);
    const modelJson = (toolResultBlock.toolResult.content?.[0] as { json: Record<string, unknown> }).json;
    const modelAccepted = modelJson.accepted as Record<string, unknown>[];
    assert.equal(modelAccepted.length, 1);
    assert.deepEqual(modelAccepted[0], {
      entityId: "V-HEAVY",
      name: "SO36",
      category: "Live Music Venue",
      neighborhood: "Kreuzberg",
      label: "connection",
    });
    assert.equal("tags" in modelAccepted[0], false);

    // 3. Full structured output still retains all 60 tags, website, coordinates, and provenance
    assert.ok(result.output);
    assert.equal(result.output.recommendations.length, 1);
    const finalRec = result.output.recommendations[0];
    assert.equal(finalRec.entityId, "V-HEAVY");
    assert.equal(finalRec.details.website, "https://so36.com");
    assert.equal(finalRec.details.mappable, true);
    assert.equal(finalRec.tags.length, 60);
    assert.deepEqual(finalRec.categories, ["Live Music Venue"]);

    const directCompacted = compactDiscoverResultForModel(
      heavyDiscoverOutcome.result as DiscoverPlacesResult,
    );
    assert.equal(directCompacted.accepted.length, 1);
    assert.equal("tags" in directCompacted.accepted[0], false);
  });
});
