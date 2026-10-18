import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InsightsResponse } from "../lib/qloo/schemas";
import type { QlooResult, InsightsParams } from "../lib/qloo/client";
import type {
  CulturalAnchor,
  InsightsFetcher,
  DiscoveryResult,
} from "../lib/discover";
import { discover, DEFAULT_MAX_ANCHOR_QUERIES } from "../lib/discover";

interface FixtureData {
  anchors: CulturalAnchor[];
  city: string;
  responses: Record<string, InsightsResponse>;
}

function loadFixture(): FixtureData {
  const path = resolve(
    import.meta.dirname,
    "fixtures",
    "discovery-queries.json",
  );
  return JSON.parse(readFileSync(path, "utf-8")) as FixtureData;
}

function createFetcher(
  responses: Record<string, InsightsResponse>,
  failQueries?: Set<string>,
): InsightsFetcher {
  return (params: InsightsParams): Promise<QlooResult<InsightsResponse>> => {
    const key =
      params.anchors.length === 1
        ? `anchor:${params.anchors[0]}`
        : "blended";

    if (failQueries?.has(key)) {
      return Promise.reject(new Error(`Simulated failure for ${key}`));
    }

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

async function runStandardDiscovery(): Promise<DiscoveryResult> {
  const fixture = loadFixture();
  return discover({
    anchors: fixture.anchors,
    city: fixture.city,
    fetchInsights: createFetcher(fixture.responses),
  });
}

// --- Provenance tracking ---

describe("discover — provenance tracking", () => {
  it("tracks single-anchor provenance with anchorId and anchorName", async () => {
    const result = await runStandardDiscovery();

    const vinylDreams = result.accepted.find((c) => c.entityId === "ENT-C");
    assert.ok(vinylDreams, "ENT-C should be accepted");
    assert.equal(vinylDreams.sources.length, 1);

    const src = vinylDreams.sources[0];
    assert.equal(src.queryType, "single-anchor");
    assert.equal(src.anchorId, "ANCHOR-2");
    assert.equal(src.anchorName, "Test Artist Beta");
    assert.equal(src.rank, 1);
    assert.equal(src.city, "Berlin");
  });

  it("tracks blended provenance without anchor association", async () => {
    const result = await runStandardDiscovery();

    const nachtklub = result.accepted.find((c) => c.entityId === "ENT-D");
    assert.ok(nachtklub, "ENT-D should be accepted");
    assert.equal(nachtklub.sources.length, 1);

    const src = nachtklub.sources[0];
    assert.equal(src.queryType, "blended");
    assert.equal(src.queryId, "blended");
    assert.equal(src.anchorId, undefined);
    assert.equal(src.anchorName, undefined);
    assert.equal(src.rank, 2);
  });

  it("merges entity from multiple queries preserving all sources", async () => {
    const result = await runStandardDiscovery();

    const curryCorner = result.accepted.find((c) => c.entityId === "ENT-B");
    assert.ok(curryCorner, "ENT-B should be accepted");
    assert.equal(curryCorner.sources.length, 3);

    const queryIds = curryCorner.sources.map((s) => s.queryId).sort();
    assert.deepEqual(queryIds, [
      "anchor:ANCHOR-1",
      "anchor:ANCHOR-2",
      "blended",
    ]);

    const anchor1Src = curryCorner.sources.find(
      (s) => s.queryId === "anchor:ANCHOR-1",
    )!;
    assert.equal(anchor1Src.anchorId, "ANCHOR-1");
    assert.equal(anchor1Src.anchorName, "Test Artist Alpha");
    assert.equal(anchor1Src.rank, 1);

    const anchor2Src = curryCorner.sources.find(
      (s) => s.queryId === "anchor:ANCHOR-2",
    )!;
    assert.equal(anchor2Src.anchorId, "ANCHOR-2");
    assert.equal(anchor2Src.rank, 0);

    const blendedSrc = curryCorner.sources.find(
      (s) => s.queryId === "blended",
    )!;
    assert.equal(blendedSrc.queryType, "blended");
    assert.equal(blendedSrc.anchorId, undefined);
    assert.equal(blendedSrc.rank, 1);
  });

  it("blended-only result cannot claim individual-anchor connection", async () => {
    const result = await runStandardDiscovery();

    const nachtklub = result.accepted.find((c) => c.entityId === "ENT-D");
    assert.ok(nachtklub);

    for (const src of nachtklub.sources) {
      assert.equal(
        src.anchorId,
        undefined,
        "blended-only result must not have anchorId",
      );
      assert.equal(
        src.anchorName,
        undefined,
        "blended-only result must not have anchorName",
      );
    }
  });
});

// --- Validation integration ---

describe("discover — validation integration", () => {
  it("excludes rejected entities from accepted shortlist", async () => {
    const result = await runStandardDiscovery();

    const acceptedIds = result.accepted.map((c) => c.entityId);
    assert.ok(!acceptedIds.includes("ENT-E"), "hotel should not be accepted");
    assert.ok(!acceptedIds.includes("ENT-F"), "airport should not be accepted");
  });

  it("retains rejected entities with full debugging info", async () => {
    const result = await runStandardDiscovery();

    const hotel = result.rejected.find((c) => c.entityId === "ENT-E");
    assert.ok(hotel, "hotel should be in rejected list");
    assert.equal(hotel.validation.verdict, "rejected");
    assert.equal(hotel.validation.reason, "hotel_accommodation");
    assert.equal(hotel.sources.length, 1);
    assert.equal(hotel.sources[0].queryId, "anchor:ANCHOR-1");

    const airport = result.rejected.find((c) => c.entityId === "ENT-F");
    assert.ok(airport, "airport should be in rejected list");
    assert.equal(airport.validation.verdict, "rejected");
    assert.equal(airport.validation.reason, "transit_airport");
  });

  it("separates review from accepted when category filter is applied", async () => {
    const fixture = loadFixture();
    const result = await discover({
      anchors: fixture.anchors,
      city: fixture.city,
      fetchInsights: createFetcher(fixture.responses),
      categoryTagId: "urn:tag:category:place:cafe",
    });

    const cafeMitte = result.accepted.find((c) => c.entityId === "ENT-A");
    assert.ok(cafeMitte, "ENT-A (cafe) should be accepted with cafe filter");
    assert.equal(cafeMitte.validation.verdict, "accepted");
    assert.equal(cafeMitte.validation.categoryEvidence?.score, 2);

    const curryCorner = result.review.find((c) => c.entityId === "ENT-B");
    assert.ok(
      curryCorner,
      "ENT-B (restaurant) should be in review with cafe filter",
    );
    assert.equal(curryCorner.validation.verdict, "review");
    assert.equal(curryCorner.validation.reason, "weak_category_evidence");

    assert.ok(
      !result.accepted.find((c) => c.entityId === "ENT-B"),
      "review entity must not appear in accepted",
    );
    assert.ok(
      !result.review.find((c) => c.entityId === "ENT-A"),
      "accepted entity must not appear in review",
    );
  });
});

// --- Partial failure ---

describe("discover — partial failure", () => {
  it("preserves successful results when one anchor query fails", async () => {
    const fixture = loadFixture();
    const result = await discover({
      anchors: fixture.anchors,
      city: fixture.city,
      fetchInsights: createFetcher(
        fixture.responses,
        new Set(["anchor:ANCHOR-2"]),
      ),
    });

    const cafeMitte = result.accepted.find((c) => c.entityId === "ENT-A");
    assert.ok(cafeMitte, "ENT-A from anchor-1 should survive");

    const curryCorner = result.accepted.find((c) => c.entityId === "ENT-B");
    assert.ok(curryCorner, "ENT-B from anchor-1 + blended should survive");

    assert.ok(
      !result.accepted.find((c) => c.entityId === "ENT-C"),
      "ENT-C from failed anchor-2 should be absent",
    );
  });

  it("records failure with query details", async () => {
    const fixture = loadFixture();
    const result = await discover({
      anchors: fixture.anchors,
      city: fixture.city,
      fetchInsights: createFetcher(
        fixture.responses,
        new Set(["anchor:ANCHOR-2"]),
      ),
    });

    assert.equal(result.failures.length, 1);
    const f = result.failures[0];
    assert.equal(f.queryId, "anchor:ANCHOR-2");
    assert.equal(f.queryType, "single-anchor");
    assert.equal(f.anchorId, "ANCHOR-2");
    assert.equal(f.anchorName, "Test Artist Beta");
    assert.ok(f.error.includes("Simulated failure"));
  });

  it("records blended failure without losing single-anchor results", async () => {
    const fixture = loadFixture();
    const result = await discover({
      anchors: fixture.anchors,
      city: fixture.city,
      fetchInsights: createFetcher(
        fixture.responses,
        new Set(["blended"]),
      ),
    });

    assert.ok(
      result.accepted.find((c) => c.entityId === "ENT-A"),
      "anchor-1 results should survive blended failure",
    );
    assert.ok(
      result.accepted.find((c) => c.entityId === "ENT-C"),
      "anchor-2 results should survive blended failure",
    );

    const blendedFailure = result.failures.find(
      (f) => f.queryId === "blended",
    );
    assert.ok(blendedFailure, "blended failure should be recorded");
    assert.equal(blendedFailure.queryType, "blended");
  });
});

// --- Budget enforcement ---

describe("discover — budget enforcement", () => {
  it("limits anchor queries to maxAnchorQueries", async () => {
    const fixture = loadFixture();
    const manyAnchors: CulturalAnchor[] = Array.from({ length: 8 }, (_, i) => ({
      entityId: i < 2 ? fixture.anchors[i].entityId : `EXTRA-${i}`,
      name: i < 2 ? fixture.anchors[i].name : `Extra Anchor ${i}`,
    }));

    let callCount = 0;
    const countingFetcher: InsightsFetcher = (params) => {
      callCount++;
      return createFetcher(fixture.responses)(params);
    };

    const result = await discover({
      anchors: manyAnchors,
      city: fixture.city,
      fetchInsights: countingFetcher,
      maxAnchorQueries: 3,
    });

    assert.ok(callCount <= 4, `expected <= 4 calls, got ${callCount}`);
    assert.equal(result.budget.queriesBudget, 4);
  });

  it("tracks query budget correctly with default limits", async () => {
    const result = await runStandardDiscovery();
    assert.equal(result.budget.queriesBudget, 3);
    assert.equal(result.budget.queriesUsed, 3);
    assert.equal(result.budget.totalResults, 6);
  });

  it("returns empty result for zero anchors", async () => {
    const result = await discover({
      anchors: [],
      city: "Berlin",
      fetchInsights: () => {
        throw new Error("should not be called");
      },
    });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.failures.length, 0);
    assert.equal(result.budget.queriesUsed, 0);
    assert.equal(result.budget.queriesBudget, 0);
  });

  it("default maxAnchorQueries is 5", () => {
    assert.equal(DEFAULT_MAX_ANCHOR_QUERIES, 5);
  });
});
