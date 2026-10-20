import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleKitRequest,
  KitRequestSchema,
  buildCacheKey,
  clearResponseCache,
  clearRateLimits,
  checkRateLimit,
  verifyConfirmedAnchors,
} from "../lib/api";
import type { KitHandlerDeps, VerifiedAnchor } from "../lib/api";
import type { AgentRunResult } from "../lib/agent";
import type { StructuredOutput, StructuredRecommendation } from "../lib/output";
import type { DiscoveryCandidate } from "../lib/discover";
import type { InsightEntity } from "../lib/qloo/schemas";
import type { ValidationResult } from "../lib/validate";

// ── Fixtures ─────────────────────────────────────────────────

const VALID_REQUEST = {
  city: "Berlin",
  anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
};

const VALID_REQUEST_TWO = {
  city: "Berlin",
  anchors: [
    { query: "Radiohead", type: "urn:entity:artist" },
    { query: "Asha Bhosle", type: "urn:entity:artist" },
  ],
};

const TOKYO_REQUEST = {
  city: "Tokyo",
  anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
};

function makeRecommendation(): StructuredRecommendation {
  return {
    entityId: "V-1",
    name: "Cool Bar",
    label: "connection",
    categories: ["Bar"],
    provenance: {
      queryMode: "single-anchor",
      anchorIds: ["R-1"],
      connectionProvenance: [
        { anchorId: "R-1", anchorName: "Radiohead", rank: 3, queryId: "anchor:R-1" },
      ],
      categoryEvidence: null,
    },
    details: {
      address: "123 Street",
      neighborhood: "Mitte",
      website: null,
      phone: null,
      priceLevel: null,
      location: { lat: 52.52, lon: 13.4 },
      mappable: true,
    },
    tags: [{ id: "urn:tag:category:place:bar", name: "Bar", type: "urn:tag:category:place" }],
    explanation: {
      text: "Qloo's taste graph surfaced this place when asked about Radiohead.",
      basis: {
        label: "connection",
        hasSingleAnchorSource: true,
        hasBlendedSource: false,
        hasCategoryEvidence: false,
        hasVenueEvidence: true,
        anchorNames: ["Radiohead"],
        category: "Bar",
      },
      verified: true,
      fallback: false,
    },
  };
}

function makeOutput(overrides?: Partial<StructuredOutput>): StructuredOutput {
  return {
    status: "success",
    summary: "Found 1 recommendation in Berlin.",
    recommendations: [makeRecommendation()],
    totalRecommendations: 1,
    invalidIds: [],
    ...overrides,
  };
}

function makeAgentResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
  return {
    runId: "test-run-1",
    status: "completed",
    finalization: {
      summary: "Here are great places with 95% confidence!",
      recommendationIds: ["V-1"],
      recommendationCount: 1,
    },
    output: makeOutput(),
    trace: [],
    toolCallCount: 3,
    qlooOutboundRequests: 2,
    qlooCacheHits: 0,
    totalDurationMs: 1500,
    ...overrides,
  };
}

function makeSuccessAgent(): KitHandlerDeps["runAgent"] {
  return async () => makeAgentResult();
}

function makeFailingAgent(): KitHandlerDeps["runAgent"] {
  return async () => {
    throw new Error("Bedrock connection failed");
  };
}

function makeTimeoutAgent(): KitHandlerDeps["runAgent"] {
  return () => new Promise(() => {}); // never resolves
}

function makeSearchEntity(): NonNullable<KitHandlerDeps["searchEntity"]> {
  return async (query: string) => ({
    data: {
      results: [
        {
          name: query,
          entity_id: `E-${query.replace(/\s+/g, "-")}`,
          types: ["urn:entity:artist"],
        },
      ],
    },
    meta: { path: "/search", params: { query }, cached: false },
  });
}

function makeFallbackCandidate(): DiscoveryCandidate {
  const entity: InsightEntity = {
    entity_id: "V-fb",
    name: "Fallback Venue",
    tags: [
      { id: "urn:tag:category:place:bar", name: "Bar", type: "urn:tag:category:place" },
    ],
    properties: { address: "Fallback St 1" },
    location: { lat: 52.5, lon: 13.4 },
  };
  const validation: ValidationResult = {
    entityId: "V-fb",
    name: "Fallback Venue",
    verdict: "accepted",
    mappable: true,
  };
  return {
    entityId: "V-fb",
    name: "Fallback Venue",
    entity,
    validation,
    sources: [
      {
        queryId: "anchor:E-Radiohead",
        queryType: "single-anchor",
        anchorId: "E-Radiohead",
        anchorName: "Radiohead",
        city: "Berlin",
        rank: 2,
      },
    ],
  };
}

function makeDiscover(): KitHandlerDeps["discover"] {
  return async (input) => ({
    city: input.city,
    accepted: [makeFallbackCandidate()],
    review: [],
    rejected: [],
    failures: [],
    budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 1 },
  });
}

function makeFailingDiscover(): KitHandlerDeps["discover"] {
  return async () => {
    throw new Error("Qloo API /v2/insights returned 503");
  };
}

function fallbackDeps(): KitHandlerDeps {
  return {
    runAgent: makeFailingAgent(),
    searchEntity: makeSearchEntity(),
    discover: makeDiscover(),
  };
}

// ── Cleanup ──────────────────────────────────────────────────

beforeEach(() => {
  clearResponseCache();
  clearRateLimits();
});

// ── 1. Valid request → structured response ───────────────────

describe("handleKitRequest — valid request", () => {
  it("returns structured output from the agent", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: makeSuccessAgent() },
    );
    assert.equal(httpStatus, 200);
    assert.equal(response.status, "success");
    assert.ok(response.output);
    assert.equal(response.output.recommendations.length, 1);
    assert.equal(response.output.recommendations[0].entityId, "V-1");
    assert.equal(response.meta.mode, "agent");
    assert.equal(response.meta.cached, false);
    assert.equal(response.meta.city, "Berlin");
    assert.equal(response.meta.anchorCount, 1);
    assert.ok(response.meta.runId.length > 0);
  });
});

// ── 2. Invalid request rejected before upstream work ─────────

describe("handleKitRequest — invalid request", () => {
  it("rejects missing city", async () => {
    const { response, httpStatus } = await handleKitRequest(
      { anchors: [{ query: "Radiohead", type: "urn:entity:artist" }] },
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "invalid_request");
  });

  it("rejects empty anchors array", async () => {
    const { response, httpStatus } = await handleKitRequest(
      { city: "Berlin", anchors: [] },
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.error?.code, "invalid_request");
  });

  it("rejects non-object body", async () => {
    const { response, httpStatus } = await handleKitRequest(
      "not an object",
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.error?.code, "invalid_request");
  });

  it("does not call the agent for invalid input", async () => {
    let agentCalled = false;
    const { httpStatus } = await handleKitRequest(
      { city: "", anchors: [] },
      "test-client",
      {
        runAgent: async () => {
          agentCalled = true;
          return makeAgentResult();
        },
      },
    );
    assert.equal(httpStatus, 400);
    assert.equal(agentCalled, false);
  });
});

// ── 3. Unconfirmed entities cannot bypass confirmation ───────

describe("handleKitRequest — entity confirmation boundary", () => {
  it("confirmedAnchors with more than 5 entries is rejected", async () => {
    const tooMany = {
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
      confirmedAnchors: Array.from({ length: 6 }, (_, i) => ({
        entityId: `E-${i}`,
        name: `Entity ${i}`,
        query: `Query ${i}`,
        type: "urn:entity:artist",
      })),
    };
    const { httpStatus, response } = await handleKitRequest(
      tooMany,
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.error?.code, "invalid_request");
  });

  it("confirmedAnchors with empty entityId is rejected", async () => {
    const { httpStatus, response } = await handleKitRequest(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{ entityId: "", name: "Bad", query: "Bad", type: "urn:entity:artist" }],
      },
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.error?.code, "invalid_request");
  });

  it("confirmedAnchors missing query field is rejected", async () => {
    const { httpStatus, response } = await handleKitRequest(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{ entityId: "E-1", name: "Radiohead" }],
      },
      "test-client",
    );
    assert.equal(httpStatus, 400);
    assert.equal(response.error?.code, "invalid_request");
  });
});

// ── 4. Raw finalization.summary never in public response ─────

describe("handleKitRequest — model summary excluded", () => {
  it("finalization.summary does not appear in the public response", async () => {
    const modelSummary = "Here are great places with 95% confidence!";
    const agent = async () =>
      makeAgentResult({
        finalization: {
          summary: modelSummary,
          recommendationIds: ["V-1"],
          recommendationCount: 1,
        },
      });

    const { response } = await handleKitRequest(VALID_REQUEST, "test-client", {
      runAgent: agent,
    });

    const json = JSON.stringify(response);
    assert.ok(!json.includes(modelSummary));
    assert.ok(!json.includes("95% confidence"));
    assert.ok(response.output!.summary.startsWith("Found "));
  });
});

// ── 5. Output validation failure ≠ genuine empty ────────────

describe("handleKitRequest — output validation failure", () => {
  it("returns output_validation_failed when agent finalizes with recs but output is empty", async () => {
    const agent = async () =>
      makeAgentResult({
        finalization: {
          summary: "Found places",
          recommendationIds: ["V-1"],
          recommendationCount: 1,
        },
        output: makeOutput({
          status: "empty",
          summary: "No verified recommendations for Berlin.",
          recommendations: [],
          totalRecommendations: 0,
        }),
      });

    const { httpStatus, response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: agent },
    );

    assert.equal(httpStatus, 500);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "output_validation_failed");
    assert.equal(response.output, null);
  });

  it("genuine empty result is not flagged as validation failure", async () => {
    const agent = async () =>
      makeAgentResult({
        finalization: {
          summary: "No places found",
          recommendationIds: [],
          recommendationCount: 0,
        },
        output: makeOutput({
          status: "empty",
          summary: "No verified recommendations for Berlin.",
          recommendations: [],
          totalRecommendations: 0,
          invalidIds: [],
        }),
      });

    const { httpStatus, response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: agent },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "empty");
    assert.ok(response.output);
    assert.equal(response.output.recommendations.length, 0);
  });
});

// ── 6. Only validated successful outputs are cached ──────────

describe("handleKitRequest — cache: validated outputs only", () => {
  it("caches a successful response", async () => {
    await handleKitRequest(VALID_REQUEST, "c1", {
      runAgent: makeSuccessAgent(),
    });

    let secondAgentCalled = false;
    const { response } = await handleKitRequest(VALID_REQUEST, "c1", {
      runAgent: async () => {
        secondAgentCalled = true;
        return makeAgentResult();
      },
    });

    assert.equal(secondAgentCalled, false);
    assert.equal(response.meta.cached, true);
    assert.equal(response.status, "success");
  });

  it("does not cache error responses", async () => {
    const { httpStatus } = await handleKitRequest(
      { city: "" },
      "c1",
    );
    assert.equal(httpStatus, 400);

    const { httpStatus: h2 } = await handleKitRequest(
      { city: "" },
      "c1",
    );
    assert.equal(h2, 400);
  });
});

// ── 7. Cache keys differ for different inputs ────────────────

describe("buildCacheKey — input sensitivity", () => {
  it("different cities produce different keys", () => {
    const k1 = buildCacheKey({
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    });
    const k2 = buildCacheKey({
      city: "Tokyo",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    });
    assert.notEqual(k1, k2);
  });

  it("different anchors produce different keys", () => {
    const k1 = buildCacheKey({
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    });
    const k2 = buildCacheKey({
      city: "Berlin",
      anchors: [{ query: "Björk", type: "urn:entity:artist" }],
    });
    assert.notEqual(k1, k2);
  });

  it("different confirmed anchors produce different keys", () => {
    const k1 = buildCacheKey({
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
      confirmedAnchors: [{
        entityId: "R-1", name: "Radiohead",
        query: "Radiohead", type: "urn:entity:artist",
      }],
    });
    const k2 = buildCacheKey({
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    });
    assert.notEqual(k1, k2);
  });

  it("anchor order does not affect cache key", () => {
    const k1 = buildCacheKey({
      city: "Berlin",
      anchors: [
        { query: "Radiohead", type: "urn:entity:artist" },
        { query: "Björk", type: "urn:entity:artist" },
      ],
    });
    const k2 = buildCacheKey({
      city: "Berlin",
      anchors: [
        { query: "Björk", type: "urn:entity:artist" },
        { query: "Radiohead", type: "urn:entity:artist" },
      ],
    });
    assert.equal(k1, k2);
  });
});

// ── 8. Cache hit does not trigger upstream work ──────────────

describe("handleKitRequest — cache hit skips upstream", () => {
  it("second identical request uses cache, agent not called", async () => {
    await handleKitRequest(VALID_REQUEST, "c1", {
      runAgent: makeSuccessAgent(),
    });

    let called = false;
    const { response } = await handleKitRequest(VALID_REQUEST, "c1", {
      runAgent: async () => {
        called = true;
        return makeAgentResult();
      },
    });

    assert.equal(called, false);
    assert.equal(response.meta.cached, true);
  });
});

// ── 9. Rate limiting before expensive work ───────────────────

describe("handleKitRequest — rate limiting", () => {
  it("rejects excess requests with 429 before calling agent", async () => {
    let agentCallCount = 0;
    const deps: KitHandlerDeps = {
      runAgent: async () => {
        agentCallCount++;
        return makeAgentResult();
      },
    };

    for (let i = 0; i < 10; i++) {
      clearResponseCache();
      const r = await handleKitRequest(
        { city: `City${i}`, anchors: [{ query: "Radiohead", type: "urn:entity:artist" }] },
        "rate-test",
        deps,
      );
      assert.equal(r.httpStatus, 200);
    }

    const { httpStatus, response } = await handleKitRequest(
      VALID_REQUEST,
      "rate-test",
      deps,
    );

    assert.equal(httpStatus, 429);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "rate_limited");
    assert.equal(agentCallCount, 10);
  });

  it("different clients have independent rate limits", async () => {
    const deps: KitHandlerDeps = { runAgent: makeSuccessAgent() };

    for (let i = 0; i < 10; i++) {
      clearResponseCache();
      await handleKitRequest(
        { city: `City${i}`, anchors: [{ query: "Radiohead", type: "urn:entity:artist" }] },
        "client-A",
        deps,
      );
    }

    const { httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "client-B",
      deps,
    );
    assert.equal(httpStatus, 200);
  });
});

// ── 10. Bedrock failure → deterministic fallback ─────────────

describe("handleKitRequest — graceful degradation", () => {
  it("falls back to deterministic discovery when agent throws", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      fallbackDeps(),
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.meta.mode, "deterministic");
    assert.ok(response.output);
    assert.ok(response.output.recommendations.length > 0);
    assert.equal(response.output.recommendations[0].name, "Fallback Venue");
    assert.ok(response.output.recommendations[0].explanation.verified);
  });

  it("falls back when agent times out", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        ...fallbackDeps(),
        runAgent: makeTimeoutAgent(),
        agentTimeoutMs: 50,
      },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.meta.mode, "deterministic");
    assert.ok(response.output);
  });

  it("deterministic fallback uses deterministic template explanations", async () => {
    const { response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      fallbackDeps(),
    );

    const rec = response.output!.recommendations[0];
    assert.equal(rec.explanation.verified, true);
    assert.ok(!rec.explanation.text.includes("%"));
    assert.ok(!rec.explanation.text.includes("confidence"));
  });
});

// ── 11. Both agent and deterministic fail → controlled error ─

describe("handleKitRequest — total failure", () => {
  it("returns 502 when both agent and discovery fail", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        runAgent: makeFailingAgent(),
        searchEntity: makeSearchEntity(),
        discover: makeFailingDiscover(),
      },
    );

    assert.equal(httpStatus, 502);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "upstream_failure");
    assert.equal(response.output, null);
    assert.equal(response.meta.mode, "deterministic");
  });

  it("error message is sanitized (no raw Qloo status)", async () => {
    const { response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        runAgent: makeFailingAgent(),
        searchEntity: makeSearchEntity(),
        discover: async () => {
          throw new Error("Qloo API key=sk-secret-12345 is invalid");
        },
      },
    );

    assert.equal(response.status, "error");
    const json = JSON.stringify(response);
    assert.ok(!json.includes("sk-secret-12345"));
    assert.ok(!json.includes("key="));
  });
});

// ── 12. Valid empty results remain valid ─────────────────────

describe("handleKitRequest — valid empty result", () => {
  it("returns empty status when agent discovers nothing", async () => {
    const agent = async () =>
      makeAgentResult({
        finalization: {
          summary: "Nothing found",
          recommendationIds: [],
          recommendationCount: 0,
        },
        output: makeOutput({
          status: "empty",
          summary: "No verified recommendations for Berlin.",
          recommendations: [],
          totalRecommendations: 0,
          invalidIds: [],
        }),
      });

    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: agent },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "empty");
    assert.ok(response.output);
    assert.equal(response.output.recommendations.length, 0);
    assert.equal(response.output.status, "empty");
  });
});

// ── 13. Timeouts don't produce misleading success ────────────

describe("handleKitRequest — timeout behavior", () => {
  it("agent timeout with no fallback returns error, not fake success", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        runAgent: makeTimeoutAgent(),
        agentTimeoutMs: 50,
        searchEntity: makeSearchEntity(),
        discover: makeFailingDiscover(),
      },
    );

    assert.equal(httpStatus, 502);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "upstream_failure");
  });

  it("agent terminated with call_limit_reached falls back to deterministic", async () => {
    const agent = async () =>
      makeAgentResult({
        status: "call_limit_reached",
        output: undefined,
        finalization: undefined,
      });

    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { ...fallbackDeps(), runAgent: agent },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.meta.mode, "deterministic");
    assert.ok(response.output);
  });
});

// ── 14. No secrets or internal trace in public response ──────

describe("handleKitRequest — no secret leakage", () => {
  it("response JSON contains no credentials or trace data", async () => {
    const { response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: makeSuccessAgent() },
    );

    const json = JSON.stringify(response);
    assert.ok(!/api.?key/i.test(json), "no api_key");
    assert.ok(!/\bsecret\b/i.test(json), "no secret");
    assert.ok(!/authorization/i.test(json), "no authorization");
    assert.ok(!/credential/i.test(json), "no credential");
    assert.ok(!/password/i.test(json), "no password");
    assert.ok(!json.includes("trace"), "no trace data");
    assert.ok(!json.includes("toolCallCount"), "no internal counters");
    assert.ok(!json.includes("qlooOutboundRequests"), "no qloo counters");
  });

  it("finalization object is not exposed in the response", async () => {
    const { response } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      { runAgent: makeSuccessAgent() },
    );

    const json = JSON.stringify(response);
    assert.ok(!json.includes("finalization"));
  });
});

// ── 15. Existing /api/discover behavior preserved ────────────

describe("KitRequestSchema — input validation", () => {
  it("accepts a valid minimal request", () => {
    const result = KitRequestSchema.safeParse(VALID_REQUEST);
    assert.ok(result.success);
  });

  it("accepts a request with confirmedAnchors (query+type required)", () => {
    const result = KitRequestSchema.safeParse({
      ...VALID_REQUEST,
      confirmedAnchors: [{
        entityId: "R-1", name: "Radiohead",
        query: "Radiohead", type: "urn:entity:artist",
      }],
    });
    assert.ok(result.success);
  });

  it("rejects confirmedAnchors without query field", () => {
    const result = KitRequestSchema.safeParse({
      ...VALID_REQUEST,
      confirmedAnchors: [{ entityId: "R-1", name: "Radiohead" }],
    });
    assert.ok(!result.success);
  });

  it("rejects city over 100 characters", () => {
    const result = KitRequestSchema.safeParse({
      city: "x".repeat(101),
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    });
    assert.ok(!result.success);
  });

  it("rejects more than 10 anchors", () => {
    const result = KitRequestSchema.safeParse({
      city: "Berlin",
      anchors: Array.from({ length: 11 }, (_, i) => ({
        query: `Anchor ${i}`,
        type: "urn:entity:artist",
      })),
    });
    assert.ok(!result.success);
  });
});

// ── 16. All P3 tests still pass (verified by npm test) ───────

// ── Additional: checkRateLimit unit behavior ─────────────────

describe("checkRateLimit — sliding window", () => {
  it("allows up to 10 requests", () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(checkRateLimit("unit-test"), false);
    }
    assert.equal(checkRateLimit("unit-test"), true);
  });

  it("separate clients have independent limits", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("client-X");
    }
    assert.equal(checkRateLimit("client-X"), true);
    assert.equal(checkRateLimit("client-Y"), false);
  });
});

// ══════════════════════════════════════════════════════════════
// NEW: Confirmed anchor server-side verification
// ══════════════════════════════════════════════════════════════

describe("verifyConfirmedAnchors — server-side verification", () => {
  it("rejects an invented entity ID not in Qloo search results", async () => {
    const search = makeSearchEntity();
    const result = await verifyConfirmedAnchors(
      [{
        entityId: "FAKE-999",
        name: "Fake Entity",
        query: "Radiohead",
        type: "urn:entity:artist",
      }],
      search,
    );
    assert.equal(result.verified.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].entityId, "FAKE-999");
    assert.equal(result.rejected[0].reason, "id_not_in_results");
  });

  it("accepts a valid entity ID found in Qloo search results", async () => {
    const search = makeSearchEntity();
    const result = await verifyConfirmedAnchors(
      [{
        entityId: "E-Radiohead",
        name: "Radiohead",
        query: "Radiohead",
        type: "urn:entity:artist",
      }],
      search,
    );
    assert.equal(result.verified.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.verified[0].entityId, "E-Radiohead");
    assert.equal(result.verified[0].name, "Radiohead");
  });

  it("uses Qloo's name, not the client-provided name", async () => {
    const search: NonNullable<KitHandlerDeps["searchEntity"]> = async (query: string) => ({
      data: {
        results: [
          {
            name: "Radiohead (Official)",
            entity_id: "E-Radiohead",
            types: ["urn:entity:artist"],
          },
        ],
      },
      meta: { path: "/search", params: { query }, cached: false },
    });
    const result = await verifyConfirmedAnchors(
      [{
        entityId: "E-Radiohead",
        name: "My Custom Name",
        query: "Radiohead",
        type: "urn:entity:artist",
      }],
      search!,
    );
    assert.equal(result.verified.length, 1);
    assert.equal(result.verified[0].name, "Radiohead (Official)");
    assert.notEqual(result.verified[0].name, "My Custom Name");
  });

  it("rejects entity ID when type does not match", async () => {
    const search: NonNullable<KitHandlerDeps["searchEntity"]> = async (query: string) => ({
      data: {
        results: [
          {
            name: "Radiohead",
            entity_id: "E-Radiohead",
            types: ["urn:entity:artist"],
          },
        ],
      },
      meta: { path: "/search", params: { query }, cached: false },
    });
    const result = await verifyConfirmedAnchors(
      [{
        entityId: "E-Radiohead",
        name: "Radiohead",
        query: "Radiohead",
        type: "urn:entity:tv_show",
      }],
      search!,
    );
    assert.equal(result.verified.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "type_not_found");
  });

  it("rejects when search fails", async () => {
    const search: NonNullable<KitHandlerDeps["searchEntity"]> = async () => {
      throw new Error("network error");
    };
    const result = await verifyConfirmedAnchors(
      [{
        entityId: "E-Radiohead",
        name: "Radiohead",
        query: "Radiohead",
        type: "urn:entity:artist",
      }],
      search!,
    );
    assert.equal(result.verified.length, 0);
    assert.equal(result.rejected[0].reason, "search_failed");
  });
});

describe("handleKitRequest — confirmed anchor verification in handler", () => {
  it("invented entity ID is dropped before agent receives it", async () => {
    let receivedInput: unknown;
    const agent: KitHandlerDeps["runAgent"] = async (input) => {
      receivedInput = input;
      return makeAgentResult();
    };

    await handleKitRequest(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{
          entityId: "FAKE-999",
          name: "Fake",
          query: "Radiohead",
          type: "urn:entity:artist",
        }],
      },
      "test-client",
      { runAgent: agent, searchEntity: makeSearchEntity() },
    );

    const input = receivedInput as { confirmedAnchors?: unknown[] };
    assert.ok(!input.confirmedAnchors || input.confirmedAnchors.length === 0);
  });

  it("verified anchor uses Qloo name in agent input", async () => {
    let receivedInput: unknown;
    const search: KitHandlerDeps["searchEntity"] = async (query: string) => ({
      data: {
        results: [
          {
            name: "Radiohead (Verified)",
            entity_id: "E-Radiohead",
            types: ["urn:entity:artist"],
          },
        ],
      },
      meta: { path: "/search", params: { query }, cached: false },
    });
    const agent: KitHandlerDeps["runAgent"] = async (input) => {
      receivedInput = input;
      return makeAgentResult();
    };

    await handleKitRequest(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{
          entityId: "E-Radiohead",
          name: "Client Name",
          query: "Radiohead",
          type: "urn:entity:artist",
        }],
      },
      "test-client",
      { runAgent: agent, searchEntity: search },
    );

    const input = receivedInput as { confirmedAnchors?: { entityId: string; name: string }[] };
    assert.ok(input.confirmedAnchors);
    assert.equal(input.confirmedAnchors.length, 1);
    assert.equal(input.confirmedAnchors[0].name, "Radiohead (Verified)");
  });

  it("both agent and deterministic fallback use verified anchors", async () => {
    let fallbackAnchors: string[] = [];
    const search: KitHandlerDeps["searchEntity"] = async (query: string) => ({
      data: {
        results: [
          {
            name: "Radiohead (Verified)",
            entity_id: "E-Radiohead",
            types: ["urn:entity:artist"],
          },
        ],
      },
      meta: { path: "/search", params: { query }, cached: false },
    });
    const discover: KitHandlerDeps["discover"] = async (input) => {
      fallbackAnchors = input.anchors.map((a) => a.name);
      return {
        city: input.city,
        accepted: [makeFallbackCandidate()],
        review: [],
        rejected: [],
        failures: [],
        budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 1 },
      };
    };

    await handleKitRequest(
      {
        city: "Berlin",
        anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
        confirmedAnchors: [{
          entityId: "E-Radiohead",
          name: "Client Name",
          query: "Radiohead",
          type: "urn:entity:artist",
        }],
      },
      "test-client",
      { runAgent: makeFailingAgent(), searchEntity: search, discover },
    );

    assert.ok(fallbackAnchors.includes("Radiohead (Verified)"));
    assert.ok(!fallbackAnchors.includes("Client Name"));
  });
});

// ══════════════════════════════════════════════════════════════
// NEW: Agent timeout cancellation
// ══════════════════════════════════════════════════════════════

describe("handleKitRequest — agent timeout cancellation", () => {
  it("aborts the agent signal when timeout fires", async () => {
    let receivedSignal: AbortSignal | undefined;
    const slowAgent: KitHandlerDeps["runAgent"] = async (_input, signal) => {
      receivedSignal = signal;
      return new Promise(() => {}); // never resolves
    };

    await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        ...fallbackDeps(),
        runAgent: slowAgent,
        agentTimeoutMs: 50,
      },
    );

    assert.ok(receivedSignal, "agent should receive a signal");
    assert.ok(receivedSignal!.aborted, "signal should be aborted after timeout");
  });

  it("fallback runs with its own independent signal after agent abort", async () => {
    let fallbackSignal: AbortSignal | undefined;
    const discover: KitHandlerDeps["discover"] = async (input) => {
      fallbackSignal = input.signal;
      return {
        city: input.city,
        accepted: [makeFallbackCandidate()],
        review: [],
        rejected: [],
        failures: [],
        budget: { queriesUsed: 1, queriesBudget: 1, totalResults: 1 },
      };
    };

    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        runAgent: makeTimeoutAgent(),
        agentTimeoutMs: 50,
        searchEntity: makeSearchEntity(),
        discover,
      },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.meta.mode, "deterministic");
    assert.ok(fallbackSignal, "fallback should receive its own signal");
    assert.ok(!fallbackSignal!.aborted, "fallback signal should NOT be aborted");
  });
});

// ══════════════════════════════════════════════════════════════
// NEW: Handler deadline enforcement
// ══════════════════════════════════════════════════════════════

describe("handleKitRequest — handler deadline", () => {
  it("returns deadline_exceeded when no time left for fallback", async () => {
    const { response, httpStatus } = await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        runAgent: makeFailingAgent(),
        searchEntity: makeSearchEntity(),
        discover: makeDiscover(),
        handlerDeadlineMs: 1, // extremely short deadline — already expired
        agentTimeoutMs: 1,
      },
    );

    assert.equal(httpStatus, 504);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "deadline_exceeded");
  });

  it("agent timeout is clamped to remaining deadline", async () => {
    let agentStarted = false;
    const agent: KitHandlerDeps["runAgent"] = async (_input, signal) => {
      agentStarted = true;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    };

    const start = Date.now();
    await handleKitRequest(
      VALID_REQUEST,
      "test-client",
      {
        ...fallbackDeps(),
        runAgent: agent,
        agentTimeoutMs: 60_000,
        handlerDeadlineMs: 200,
      },
    );
    const elapsed = Date.now() - start;

    assert.ok(agentStarted);
    assert.ok(elapsed < 5_000, `should finish quickly, took ${elapsed}ms`);
  });
});
