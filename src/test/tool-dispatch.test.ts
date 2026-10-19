import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InsightsResponse, TagsResponse, SearchResponse } from "../lib/qloo/schemas";
import type { QlooResult, InsightsParams } from "../lib/qloo/client";
import type { InsightsFetcher } from "../lib/discover";
import { dispatchToolCall, TOOL_NAMES } from "../lib/bedrock";
import type {
  ToolDeps,
  ResolveAnchorResult,
  DiscoverPlacesResult,
  FindTagsResult,
  FinalizeResult,
} from "../lib/bedrock";

// --- Mock fixtures ---

function loadSearchFixture(name: string): SearchResponse {
  const path = resolve(
    import.meta.dirname,
    "fixtures",
    `search-${name}.json`,
  );
  return JSON.parse(readFileSync(path, "utf-8")) as SearchResponse;
}

interface DiscoveryFixtureData {
  anchors: { entityId: string; name: string }[];
  city: string;
  responses: Record<string, InsightsResponse>;
}

function loadDiscoveryFixture(): DiscoveryFixtureData {
  const path = resolve(
    import.meta.dirname,
    "fixtures",
    "discovery-queries.json",
  );
  return JSON.parse(readFileSync(path, "utf-8")) as DiscoveryFixtureData;
}

function createMockInsightsFetcher(
  responses: Record<string, InsightsResponse>,
): InsightsFetcher {
  return (params: InsightsParams): Promise<QlooResult<InsightsResponse>> => {
    const key =
      params.anchors.length === 1
        ? `anchor:${params.anchors[0]}`
        : "blended";
    const response = responses[key];
    if (!response) {
      return Promise.reject(new Error(`No fixture for query key: ${key}`));
    }
    return Promise.resolve({
      data: response,
      meta: { path: "/v2/insights", params: {}, cached: false },
    });
  };
}

function makeDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    searchEntity: overrides?.searchEntity ?? (() => {
      throw new Error("searchEntity not mocked");
    }),
    searchTags: overrides?.searchTags ?? (() => {
      throw new Error("searchTags not mocked");
    }),
    fetchInsights: overrides?.fetchInsights,
  };
}

function mockSearchEntity(fixture: SearchResponse) {
  return async (_query: string, _take?: number): Promise<QlooResult<SearchResponse>> => ({
    data: fixture,
    meta: { path: "/search", params: {}, cached: false },
  });
}

function mockSearchTags(tags: TagsResponse) {
  return async (_query: string, _take?: number): Promise<QlooResult<TagsResponse>> => ({
    data: tags,
    meta: { path: "/v2/tags", params: {}, cached: false },
  });
}

// --- resolve_anchor ---

describe("dispatchToolCall — resolve_anchor", () => {
  it("resolves a single-match entity (Radiohead as artist)", async () => {
    const fixture = loadSearchFixture("radiohead");
    const deps = makeDeps({ searchEntity: mockSearchEntity(fixture) });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Radiohead", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as ResolveAnchorResult;
    assert.equal(result.status, "resolved");
    assert.ok(result.entity);
    assert.equal(result.entity!.entityId, "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C");
    assert.equal(result.entity!.name, "Radiohead");
    assert.equal(result.requestedType, "urn:entity:artist");
  });

  it("returns ambiguous for The Office with candidate details", async () => {
    const fixture = loadSearchFixture("the-office");
    const deps = makeDeps({ searchEntity: mockSearchEntity(fixture) });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "The Office", type: "urn:entity:tv_show" },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as ResolveAnchorResult;
    assert.equal(result.status, "ambiguous");
    assert.ok(result.candidates);
    assert.ok(result.candidates!.length >= 2);
    for (const c of result.candidates!) {
      assert.ok(c.entityId, "each candidate must have an entityId");
      assert.ok(c.name, "each candidate must have a name");
    }
    assert.equal(result.entity, undefined);
  });

  it("returns not_found when no entity matches the type", async () => {
    const fixture = loadSearchFixture("radiohead");
    const deps = makeDeps({ searchEntity: mockSearchEntity(fixture) });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Radiohead", type: "urn:entity:tv_show" },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as ResolveAnchorResult;
    assert.equal(result.status, "not_found");
    assert.equal(result.requestedType, "urn:entity:tv_show");
  });

  it("rejects missing query argument", async () => {
    const deps = makeDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("query"));
  });

  it("rejects empty query string", async () => {
    const deps = makeDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
  });

  it("rejects missing type argument", async () => {
    const deps = makeDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Radiohead" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("type"));
  });

  it("rejects null arguments", async () => {
    const deps = makeDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      null,
      deps,
    );
    assert.equal(outcome.ok, false);
  });

  it("sanitizes error messages that might contain credentials", async () => {
    const deps = makeDeps({
      searchEntity: async () => {
        throw new Error("QLOO_API_KEY is invalid: sk-secret-123");
      },
    });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Test", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(!outcome.error.includes("sk-secret"));
    assert.ok(!outcome.error.includes("API_KEY"));
    assert.equal(outcome.error, "Tool execution failed due to a configuration error.");
  });
});

// --- discover_places ---

describe("dispatchToolCall — discover_places", () => {
  function discoveryDeps(): ToolDeps {
    const fixture = loadDiscoveryFixture();
    return makeDeps({
      fetchInsights: createMockInsightsFetcher(fixture.responses),
    });
  }

  it("discovers places with a single anchor (single-anchor provenance)", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1"],
        anchor_names: ["Test Artist Alpha"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as DiscoverPlacesResult;
    assert.equal(result.city, "Berlin");
    assert.ok(result.accepted.length > 0);

    const cafeMitte = result.accepted.find((e) => e.entityId === "ENT-A");
    assert.ok(cafeMitte, "ENT-A should be accepted");
    assert.ok(cafeMitte.recommendation, "accepted entry must have a recommendation");
    assert.equal(cafeMitte.recommendation!.label, "connection");
    assert.ok(
      cafeMitte.recommendation!.connectionProvenance.length > 0,
      "connection must have provenance",
    );
    assert.equal(
      cafeMitte.recommendation!.connectionProvenance[0].anchorId,
      "ANCHOR-1",
    );
  });

  it("discovers places with multiple anchors (blended + single-anchor)", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1", "ANCHOR-2"],
        anchor_names: ["Test Artist Alpha", "Test Artist Beta"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as DiscoverPlacesResult;

    const curryCorner = result.accepted.find((e) => e.entityId === "ENT-B");
    assert.ok(curryCorner, "ENT-B should be accepted");
    assert.ok(curryCorner.recommendation);
    assert.equal(curryCorner.recommendation!.label, "connection");
    assert.equal(curryCorner.recommendation!.connectionProvenance.length, 2);

    const nachtklub = result.accepted.find((e) => e.entityId === "ENT-D");
    assert.ok(nachtklub, "ENT-D (blended-only) should be accepted");
    assert.ok(nachtklub.recommendation);
    assert.equal(nachtklub.recommendation!.label, "exploratory");
    assert.equal(nachtklub.recommendation!.connectionProvenance.length, 0);
  });

  it("keeps rejected entities out of accepted list", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1", "ANCHOR-2"],
        anchor_names: ["Test Artist Alpha", "Test Artist Beta"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as DiscoverPlacesResult;

    const acceptedIds = result.accepted.map((e) => e.entityId);
    assert.ok(!acceptedIds.includes("ENT-E"), "hotel must be rejected");
    assert.ok(!acceptedIds.includes("ENT-F"), "airport must be rejected");
    assert.ok(result.rejectedCount > 0);
    assert.ok(result.rejectedReasons["hotel_accommodation"] > 0);
  });

  it("reports review and rejected counts separately", async () => {
    const fixture = loadDiscoveryFixture();
    const deps = makeDeps({
      fetchInsights: createMockInsightsFetcher(fixture.responses),
    });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1", "ANCHOR-2"],
        anchor_names: ["Test Artist Alpha", "Test Artist Beta"],
        city: "Berlin",
        category_tag_id: "urn:tag:category:place:cafe",
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as DiscoverPlacesResult;

    assert.ok(result.reviewCount >= 0);
    assert.ok(result.rejectedCount >= 0);
    assert.equal(typeof result.budget.queriesUsed, "number");
    assert.equal(typeof result.budget.totalResults, "number");
  });

  it("includes venue details in accepted entries", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1"],
        anchor_names: ["Test Artist Alpha"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as DiscoverPlacesResult;
    const entry = result.accepted[0];
    assert.ok(entry);
    assert.ok("category" in entry);
    assert.ok("address" in entry);
    assert.ok("neighborhood" in entry);
    assert.ok("website" in entry);
  });

  it("rejects empty anchor_ids", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      { anchor_ids: [], anchor_names: [], city: "Berlin" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("anchor_ids"));
  });

  it("rejects more than 5 anchor_ids", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["a", "b", "c", "d", "e", "f"],
        anchor_names: ["A", "B", "C", "D", "E", "F"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("5"));
  });

  it("rejects mismatched anchor_ids and anchor_names lengths", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1", "ANCHOR-2"],
        anchor_names: ["Test Artist Alpha"],
        city: "Berlin",
      },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("same length"));
  });

  it("rejects missing city", async () => {
    const deps = discoveryDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.DISCOVER_PLACES,
      {
        anchor_ids: ["ANCHOR-1"],
        anchor_names: ["Test Artist Alpha"],
      },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("city"));
  });
});

// --- find_tags ---

describe("dispatchToolCall — find_tags", () => {
  const MOCK_TAGS_RESPONSE: TagsResponse = {
    results: {
      tags: [
        { id: "urn:tag:category:place:cafe", name: "Cafe", type: "urn:tag:category:place" },
        { id: "urn:tag:category:place:coffee_shop", name: "Coffee shop", type: "urn:tag:category:place" },
      ],
    },
  };

  function tagDeps(): ToolDeps {
    return makeDeps({ searchTags: mockSearchTags(MOCK_TAGS_RESPONSE) });
  }

  it("returns tags from a valid search", async () => {
    const deps = tagDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FIND_TAGS,
      { query: "cafe" },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as FindTagsResult;
    assert.equal(result.tags.length, 2);
    assert.equal(result.tags[0].id, "urn:tag:category:place:cafe");
    assert.equal(result.tags[0].name, "Cafe");
    assert.equal(result.tags[1].id, "urn:tag:category:place:coffee_shop");
  });

  it("returns empty tags array when no results", async () => {
    const emptyTags: TagsResponse = { results: { tags: [] } };
    const deps = makeDeps({ searchTags: mockSearchTags(emptyTags) });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FIND_TAGS,
      { query: "xyznonexistent" },
      deps,
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as FindTagsResult;
    assert.equal(result.tags.length, 0);
  });

  it("rejects empty query", async () => {
    const deps = tagDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FIND_TAGS,
      { query: "" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("query"));
  });

  it("rejects missing query", async () => {
    const deps = tagDeps();
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FIND_TAGS,
      {},
      deps,
    );
    assert.equal(outcome.ok, false);
  });
});

// --- finalize ---

describe("dispatchToolCall — finalize", () => {
  it("accepts valid finalize input", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      {
        summary: "Found 5 venues in Berlin connected to Radiohead.",
        recommendation_ids: ["ENT-A", "ENT-B", "ENT-C"],
      },
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as FinalizeResult;
    assert.equal(result.status, "complete");
    assert.equal(result.summary, "Found 5 venues in Berlin connected to Radiohead.");
    assert.equal(result.recommendationCount, 3);
    assert.deepEqual(result.recommendationIds, ["ENT-A", "ENT-B", "ENT-C"]);
  });

  it("accepts empty recommendation_ids", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      {
        summary: "No venues found.",
        recommendation_ids: [],
      },
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as FinalizeResult;
    assert.equal(result.recommendationCount, 0);
    assert.deepEqual(result.recommendationIds, []);
  });

  it("rejects missing summary", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      { recommendation_ids: ["ENT-A"] },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("summary"));
  });

  it("rejects empty summary", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      { summary: "  ", recommendation_ids: [] },
    );
    assert.equal(outcome.ok, false);
  });

  it("rejects missing recommendation_ids", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      { summary: "Done." },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.includes("recommendation_ids"));
  });

  it("rejects non-string items in recommendation_ids", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      { summary: "Done.", recommendation_ids: [123, null] },
    );
    assert.equal(outcome.ok, false);
  });

  it("does not fabricate data — output only contains supplied input", async () => {
    const outcome = await dispatchToolCall(
      TOOL_NAMES.FINALIZE,
      {
        summary: "Test summary.",
        recommendation_ids: ["X"],
      },
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const result = outcome.result as FinalizeResult;
    assert.equal(result.summary, "Test summary.");
    assert.deepEqual(result.recommendationIds, ["X"]);
    assert.equal(Object.keys(result).length, 4);
  });
});

// --- Unknown tool ---

describe("dispatchToolCall — unknown tool", () => {
  it("returns an error for an unknown tool name", async () => {
    const outcome = await dispatchToolCall("nonexistent_tool", {});
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.toolName, "nonexistent_tool");
    assert.ok(outcome.error.includes("Unknown tool"));
  });
});

// --- Error handling ---

describe("dispatchToolCall — error handling", () => {
  it("does not leak credentials from Qloo errors", async () => {
    const deps = makeDeps({
      searchEntity: async () => {
        throw new Error("Request failed: secret_access_key=ABCDEF token=xyz");
      },
    });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Test", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(!outcome.error.includes("ABCDEF"));
    assert.ok(!outcome.error.includes("secret"));
  });

  it("handles non-Error thrown values", async () => {
    const deps = makeDeps({
      searchEntity: async () => {
        throw "string error";
      },
    });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Test", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "Tool execution failed.");
  });

  it("truncates excessively long error messages", async () => {
    const deps = makeDeps({
      searchEntity: async () => {
        throw new Error("x".repeat(1000));
      },
    });
    const outcome = await dispatchToolCall(
      TOOL_NAMES.RESOLVE_ANCHOR,
      { query: "Test", type: "urn:entity:artist" },
      deps,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.error.length <= 500);
  });
});
