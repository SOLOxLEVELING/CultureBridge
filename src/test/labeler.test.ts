import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DiscoveryCandidate, QuerySource } from "../lib/discover/discovery";
import type { InsightEntity } from "../lib/qloo/schemas";
import type {
  ValidationResult,
  CategoryEvidence,
  ValidationVerdict,
} from "../lib/validate/validator";
import {
  assignLabel,
  labelDiscoveryResults,
} from "../lib/recommend";

// --- Test helpers ---

function singleAnchorSource(
  rank: number,
  anchorId = "ANCHOR-1",
  anchorName = "Test Artist Alpha",
): QuerySource {
  return {
    queryId: `anchor:${anchorId}`,
    queryType: "single-anchor",
    anchorId,
    anchorName,
    city: "Berlin",
    rank,
  };
}

function blendedSource(rank: number): QuerySource {
  return {
    queryId: "blended",
    queryType: "blended",
    city: "Berlin",
    rank,
  };
}

function makeCandidate(opts: {
  entityId?: string;
  name?: string;
  sources?: QuerySource[];
  verdict?: ValidationVerdict;
  reason?: string;
  categoryEvidence?: CategoryEvidence;
  properties?: Record<string, unknown>;
}): DiscoveryCandidate {
  const entityId = opts.entityId ?? "TEST-ENT";
  const name = opts.name ?? "Test Place";
  const verdict = opts.verdict ?? "accepted";

  const entity = {
    name,
    entity_id: entityId,
    properties: opts.properties ?? { is_closed: false },
    location: { lat: 52.5, lon: 13.4 },
    tags: [],
  } as unknown as InsightEntity;

  const validation: ValidationResult = {
    entityId,
    name,
    verdict,
    mappable: true,
    ...(opts.reason ? { reason: opts.reason as never } : {}),
    ...(opts.categoryEvidence ? { categoryEvidence: opts.categoryEvidence } : {}),
  };

  return {
    entityId,
    name,
    entity,
    validation,
    sources: opts.sources ?? [],
  };
}

const CAFE_CATEGORY_EVIDENCE: CategoryEvidence = {
  requestedCategory: "cafe",
  score: 2,
  position: 0,
  conflict: false,
};

// --- Connection label ---

describe("assignLabel — Connection", () => {
  it("accepted single-anchor result ranked 0–9 → connection", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(3)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance.length, 1);
    assert.equal(rec.connectionProvenance[0].anchorId, "ANCHOR-1");
    assert.equal(rec.connectionProvenance[0].anchorName, "Test Artist Alpha");
    assert.equal(rec.connectionProvenance[0].rank, 3);
    assert.ok(
      rec.explanation.includes("Test Artist Alpha"),
      "explanation must name the anchor",
    );
  });

  it("rank 0 (top result) → connection", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(0)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance[0].rank, 0);
  });

  it("rank 9 (boundary) → connection", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(9)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
  });

  it("preserves original Qloo rank, not re-ranked position", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(7)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.connectionProvenance[0].rank, 7);
  });
});

// --- Exploratory label ---

describe("assignLabel — Exploratory", () => {
  it("accepted single-anchor result ranked 10+ → exploratory", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(10)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
    assert.equal(rec.connectionProvenance.length, 0);
    assert.ok(
      rec.explanation.includes("exploratory suggestion"),
      "explanation must describe exploratory nature",
    );
  });

  it("accepted single-anchor result ranked 15 → exploratory", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(15)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
  });

  it("accepted blended-only result → exploratory", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(2)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
    assert.equal(rec.connectionProvenance.length, 0);
  });

  it("accepted with no sources → exploratory", () => {
    const candidate = makeCandidate({ sources: [] });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
  });
});

// --- Useful place label ---

describe("assignLabel — Useful place", () => {
  it("accepted category-query result with venue evidence → useful-place", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(1)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: {
        is_closed: false,
        website: "https://example.com",
        address: "123 Berlin St",
      },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "useful-place");
    assert.equal(rec.connectionProvenance.length, 0);
    assert.deepEqual(rec.categoryEvidence, CAFE_CATEGORY_EVIDENCE);
    assert.ok(
      rec.explanation.includes("cafe"),
      "explanation must reference the category",
    );
  });

  it("category evidence + phone only → useful-place", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(0)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: { is_closed: false, phone: "+49 30 1234567" },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "useful-place");
  });

  it("category evidence + address only → useful-place", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(0)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: { is_closed: false, address: "Friedrichstr. 1" },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "useful-place");
  });

  it("category evidence without venue evidence → exploratory", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(0)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: { is_closed: false },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
  });

  it("venue evidence without category evidence → exploratory", () => {
    const candidate = makeCandidate({
      sources: [blendedSource(0)],
      properties: {
        is_closed: false,
        website: "https://example.com",
        address: "123 Berlin St",
      },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
  });
});

// --- Rejected and review exclusion ---

describe("assignLabel — rejected and review exclusion", () => {
  it("rejected result returns null", () => {
    const candidate = makeCandidate({
      verdict: "rejected",
      reason: "closed",
      sources: [singleAnchorSource(0)],
    });
    const rec = assignLabel(candidate);
    assert.equal(rec, null);
  });

  it("review result returns null, even with strong provenance", () => {
    const candidate = makeCandidate({
      verdict: "review",
      reason: "weak_category_evidence",
      sources: [singleAnchorSource(0)],
    });
    const rec = assignLabel(candidate);
    assert.equal(rec, null);
  });

  it("rejected result with Connection-qualifying source returns null", () => {
    const candidate = makeCandidate({
      verdict: "rejected",
      reason: "hotel_accommodation",
      sources: [singleAnchorSource(2)],
    });
    const rec = assignLabel(candidate);
    assert.equal(rec, null);
  });

  it("labelDiscoveryResults skips non-accepted candidates", () => {
    const accepted = makeCandidate({
      entityId: "A",
      sources: [singleAnchorSource(1)],
    });
    const review = makeCandidate({
      entityId: "B",
      verdict: "review",
      reason: "weak_category_evidence",
      sources: [singleAnchorSource(1)],
    });
    const results = labelDiscoveryResults([accepted, review]);
    assert.equal(results.length, 1);
    assert.equal(results[0].entityId, "A");
  });
});

// --- Multi-source provenance ---

describe("assignLabel — multi-source provenance", () => {
  it("single-anchor + blended retains Connection provenance", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(5), blendedSource(2)],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance.length, 1);
    assert.equal(rec.connectionProvenance[0].anchorId, "ANCHOR-1");
    assert.equal(rec.connectionProvenance[0].rank, 5);
  });

  it("multiple single-anchor sources produce deterministic provenance", () => {
    const candidate = makeCandidate({
      sources: [
        singleAnchorSource(2, "ANCHOR-1", "Test Artist Alpha"),
        singleAnchorSource(4, "ANCHOR-2", "Test Artist Beta"),
        blendedSource(1),
      ],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance.length, 2);

    const ids = rec.connectionProvenance.map((p) => p.anchorId);
    assert.ok(ids.includes("ANCHOR-1"));
    assert.ok(ids.includes("ANCHOR-2"));

    assert.ok(
      rec.explanation.includes("Test Artist Alpha"),
      "explanation must mention first anchor",
    );
    assert.ok(
      rec.explanation.includes("Test Artist Beta"),
      "explanation must mention second anchor",
    );
  });

  it("blended source does not erase valid single-anchor Connection", () => {
    const candidate = makeCandidate({
      sources: [
        blendedSource(0),
        singleAnchorSource(3),
        blendedSource(5),
      ],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance.length, 1);
    assert.equal(rec.connectionProvenance[0].rank, 3);
  });

  it("one qualifying + one non-qualifying anchor → Connection with qualifying only", () => {
    const candidate = makeCandidate({
      sources: [
        singleAnchorSource(5, "ANCHOR-1", "Test Artist Alpha"),
        singleAnchorSource(12, "ANCHOR-2", "Test Artist Beta"),
      ],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.equal(rec.connectionProvenance.length, 1);
    assert.equal(rec.connectionProvenance[0].anchorId, "ANCHOR-1");
    assert.equal(rec.connectionProvenance[0].rank, 5);
  });
});

// --- Missing or inconsistent provenance ---

describe("assignLabel — missing or inconsistent provenance", () => {
  it("single-anchor source missing anchorId cannot produce Connection", () => {
    const brokenSource: QuerySource = {
      queryId: "anchor:ANCHOR-X",
      queryType: "single-anchor",
      anchorId: undefined,
      anchorName: undefined,
      city: "Berlin",
      rank: 0,
    };
    const candidate = makeCandidate({ sources: [brokenSource] });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
    assert.equal(rec.connectionProvenance.length, 0);
  });

  it("single-anchor source missing anchorName cannot produce Connection", () => {
    const brokenSource: QuerySource = {
      queryId: "anchor:ANCHOR-X",
      queryType: "single-anchor",
      anchorId: "ANCHOR-X",
      anchorName: undefined,
      city: "Berlin",
      rank: 0,
    };
    const candidate = makeCandidate({ sources: [brokenSource] });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
  });

  it("all single-anchor sources rank 10+ with blended → exploratory", () => {
    const candidate = makeCandidate({
      sources: [
        singleAnchorSource(10),
        singleAnchorSource(15, "ANCHOR-2", "Test Artist Beta"),
        blendedSource(3),
      ],
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "exploratory");
    assert.equal(rec.connectionProvenance.length, 0);
  });

  it("Connection takes precedence over Useful place", () => {
    const candidate = makeCandidate({
      sources: [singleAnchorSource(3)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: {
        is_closed: false,
        website: "https://example.com",
        address: "123 Berlin St",
      },
    });
    const rec = assignLabel(candidate)!;
    assert.equal(rec.label, "connection");
    assert.deepEqual(rec.categoryEvidence, CAFE_CATEGORY_EVIDENCE);
  });
});

// --- Batch labeling ---

describe("labelDiscoveryResults — batch", () => {
  it("labels a mixed set of accepted candidates", () => {
    const connection = makeCandidate({
      entityId: "C1",
      sources: [singleAnchorSource(2)],
    });
    const useful = makeCandidate({
      entityId: "U1",
      sources: [blendedSource(0)],
      categoryEvidence: CAFE_CATEGORY_EVIDENCE,
      properties: { is_closed: false, address: "Mitte 1" },
    });
    const exploratory = makeCandidate({
      entityId: "E1",
      sources: [blendedSource(5)],
    });

    const results = labelDiscoveryResults([connection, useful, exploratory]);
    assert.equal(results.length, 3);
    assert.equal(results[0].label, "connection");
    assert.equal(results[1].label, "useful-place");
    assert.equal(results[2].label, "exploratory");
  });

  it("returns empty array for empty input", () => {
    const results = labelDiscoveryResults([]);
    assert.equal(results.length, 0);
  });
});
