import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  handleAnchorSearch,
  AnchorSearchRequestSchema,
  AnchorCandidateSchema,
  clearRateLimits,
  ANCHOR_SEARCH_RATE_LIMIT,
  MAX_ANCHOR_CANDIDATES,
  sanitizeAnchorLookupError,
} from "../lib/api";
import type { AnchorSearchDeps } from "../lib/api";
import { SearchResponseSchema } from "../lib/qloo/schemas";
import type { SearchResponse } from "../lib/qloo/schemas";
import { POST as anchorSearchRoutePost } from "../app/api/anchors/search/route";

function loadFixture(name: string): SearchResponse {
  const path = resolve(import.meta.dirname, "fixtures", name);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return SearchResponseSchema.parse(raw);
}

function makeFixtureSearch(fixtureName: string): NonNullable<AnchorSearchDeps["searchEntity"]> {
  const parsed = loadFixture(fixtureName);
  return async (query: string) => ({
    data: parsed,
    meta: { path: "/search", params: { query, take: "10" }, cached: false },
  });
}

beforeEach(() => {
  clearRateLimits();
});

describe("AnchorSearchRequestSchema — validation", () => {
  it("accepts valid query and supported entity type", () => {
    const parsed = AnchorSearchRequestSchema.safeParse({
      query: "  Radiohead  ",
      type: "urn:entity:artist",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.query, "Radiohead");
      assert.equal(parsed.data.type, "urn:entity:artist");
    }
  });

  it("rejects empty or whitespace-only query", () => {
    const parsed = AnchorSearchRequestSchema.safeParse({
      query: "   ",
      type: "urn:entity:artist",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects query exceeding 200 characters", () => {
    const parsed = AnchorSearchRequestSchema.safeParse({
      query: "a".repeat(201),
      type: "urn:entity:artist",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects unsupported entity type URN", () => {
    const parsed = AnchorSearchRequestSchema.safeParse({
      query: "Radiohead",
      type: "urn:entity:place",
    });
    assert.equal(parsed.success, false);
  });
});

describe("handleAnchorSearch — fixture-backed Qloo resolution", () => {
  it("returns Arijit Singh artist candidate (excluding person and album)", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Arijit Singh", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: makeFixtureSearch("search-arijit-singh.json") },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "matches");
    assert.equal(response.resolutionStatus, "resolved");
    assert.equal(response.query, "Arijit Singh");
    assert.equal(response.requestedType, "urn:entity:artist");
    assert.equal(response.candidates.length, 1);
    assert.deepEqual(response.candidates[0], {
      entityId: "924C8504-4BD8-4615-AB2D-1C16880A8A62",
      name: "Arijit Singh",
      types: ["urn:entity:artist"],
      disambiguation: "Arijit Singh",
    });
  });

  it("returns both tv_show candidates for The Office with disambiguation", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "The Office", type: "urn:entity:tv_show" },
      "test-client",
      { searchEntity: makeFixtureSearch("search-the-office.json") },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "matches");
    assert.equal(response.resolutionStatus, "ambiguous");
    assert.equal(response.candidates.length, 2);
    assert.deepEqual(response.candidates[0], {
      entityId: "E5AE1F26-04CB-4CDD-BBA4-87FB6541F848",
      name: "The Office",
      types: ["urn:entity:tv_show"],
      disambiguation: "2005,2013",
    });
    assert.deepEqual(response.candidates[1], {
      entityId: "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
      name: "The Office",
      types: ["urn:entity:tv_show"],
      disambiguation: "2001,2003",
    });
  });

  it("deduplicates Radiohead entity_id and merges supported types", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: makeFixtureSearch("search-radiohead.json") },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "matches");
    assert.equal(response.resolutionStatus, "resolved");
    assert.equal(response.candidates.length, 1);
    assert.equal(
      response.candidates[0].entityId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    );
    assert.equal(response.candidates[0].name, "Radiohead");
    assert.deepEqual(response.candidates[0].types, [
      "urn:entity:artist",
      "urn:entity:person",
    ]);
  });

  it("resolves Zara as brand and excludes place entities", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Zara", type: "urn:entity:brand" },
      "test-client",
      { searchEntity: makeFixtureSearch("search-zara.json") },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "matches");
    assert.equal(response.resolutionStatus, "resolved");
    assert.equal(response.candidates.length, 1);
    assert.deepEqual(response.candidates[0], {
      entityId: "74A44B01-5C99-4754-9585-F487D21C543D",
      name: "Zara",
      types: ["urn:entity:brand"],
    });
  });

  it("returns no_matches (200) when no candidate matches the requested type", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Arijit Singh", type: "urn:entity:tv_show" },
      "test-client",
      { searchEntity: makeFixtureSearch("search-arijit-singh.json") },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.status, "no_matches");
    assert.equal(response.resolutionStatus, "not_found");
    assert.deepEqual(response.candidates, []);
  });
});

describe("handleAnchorSearch — sanitization, capping, and rate limiting", () => {
  it("strips extra upstream fields and caps candidates to MAX_ANCHOR_CANDIDATES", async () => {
    const rawUpstreamResults = Array.from({ length: 8 }, (_, idx) => ({
      name: `Candidate ${idx + 1}`,
      entity_id: `E-${idx + 1}`,
      types: ["urn:entity:artist", "urn:entity:place", "urn:entity:album"],
      disambiguation: `Info ${idx + 1}`,
      popularity: 0.99,
      properties: { secret_field: "do-not-expose" },
      tags: [{ id: "urn:tag:music", name: "Music", type: "tag" }],
    }));

    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Candidate", type: "urn:entity:artist" },
      "test-client",
      {
        searchEntity: async (query) => ({
          data: { results: rawUpstreamResults },
          meta: { path: "/search", params: { query }, cached: false },
        }),
      },
    );

    assert.equal(httpStatus, 200);
    assert.equal(response.candidates.length, MAX_ANCHOR_CANDIDATES);

    for (const candidate of response.candidates) {
      const checked = AnchorCandidateSchema.safeParse(candidate);
      assert.equal(checked.success, true);
      assert.deepEqual(
        Object.keys(candidate).sort(),
        ["disambiguation", "entityId", "name", "types"],
      );
      // Unsupported types (place, album) are stripped
      assert.deepEqual(candidate.types, ["urn:entity:artist"]);
    }

    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes("secret_field"), false);
    assert.equal(serialized.includes("popularity"), false);
  });

  it("rejects invalid request before calling Qloo search", async () => {
    let called = false;
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "", type: "urn:entity:artist" },
      "test-client",
      {
        searchEntity: async () => {
          called = true;
          throw new Error("should not be called");
        },
      },
    );

    assert.equal(httpStatus, 400);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "invalid_request");
    assert.equal(called, false);
  });

  it("enforces rate limit and returns 429 before calling Qloo search", async () => {
    let calls = 0;
    const deps: AnchorSearchDeps = {
      rateLimit: 3,
      searchEntity: makeFixtureSearch("search-radiohead.json"),
    };

    for (let i = 0; i < 3; i++) {
      const res = await handleAnchorSearch(
        { query: "Radiohead", type: "urn:entity:artist" },
        "rate-limited-client",
        {
          ...deps,
          searchEntity: async (q) => {
            calls++;
            return makeFixtureSearch("search-radiohead.json")(q);
          },
        },
      );
      assert.equal(res.httpStatus, 200);
    }

    const blocked = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "rate-limited-client",
      {
        ...deps,
        searchEntity: async (q) => {
          calls++;
          return makeFixtureSearch("search-radiohead.json")(q);
        },
      },
    );

    assert.equal(blocked.httpStatus, 429);
    assert.equal(blocked.response.status, "error");
    assert.equal(blocked.response.error?.code, "rate_limited");
    assert.equal(calls, 3);
    assert.equal(ANCHOR_SEARCH_RATE_LIMIT, 30);
  });

  it("sanitizes upstream Qloo errors and never leaks API keys", async () => {
    const { httpStatus, response } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "test-client",
      {
        searchEntity: async () => {
          throw new Error(
            "Qloo API /search failed with api_key=sk-secret-99999 and QLOO_API_KEY",
          );
        },
      },
    );

    assert.equal(httpStatus, 502);
    assert.equal(response.status, "error");
    assert.equal(response.error?.code, "lookup_failed");
    const json = JSON.stringify(response);
    assert.equal(json.includes("sk-secret-99999"), false);
    assert.equal(json.includes("QLOO_API_KEY"), false);
    assert.equal(
      sanitizeAnchorLookupError(new Error("token=xyz123")),
      "Entity lookup service configuration error.",
    );
  });

  it("route handler returns 400 on malformed JSON body", async () => {
    const req = new Request("http://localhost:3000/api/anchors/search", {
      method: "POST",
      body: "{not-valid-json",
      headers: { "Content-Type": "application/json" },
    });

    const res = await anchorSearchRoutePost(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { status: string; error?: { code: string } };
    assert.equal(body.status, "error");
    assert.equal(body.error?.code, "invalid_request");
  });
});
