import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { runAgent, TOOL_CALL_LIMIT, QLOO_REQUEST_BUDGET } from "../lib/agent";
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
