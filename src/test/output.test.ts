import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DiscoverPlacesResultEntry } from "../lib/bedrock";
import type { Recommendation, ConnectionProvenance } from "../lib/recommend";
import type { CategoryEvidence } from "../lib/validate";
import {
  buildStructuredOutput,
  buildRecommendation,
  validateOutput,
  OutputValidationError,
  generateVerifiedExplanation,
  buildExplanationBasis,
  generateDeterministicExplanation,
  verifyExplanation,
  isValidCoordinate,
  StructuredOutputSchema,
  StructuredRecommendationSchema,
} from "../lib/output";
import type {
  StructuredRecommendation,
  StructuredOutput,
  ExplanationBasis,
} from "../lib/output";

// ── Fixtures ──────────────────────────────────────────────────

const CONNECTION_PROVENANCE: ConnectionProvenance = {
  anchorId: "R-1",
  anchorName: "Radiohead",
  rank: 3,
  queryId: "anchor:R-1",
};

const CATEGORY_EVIDENCE: CategoryEvidence = {
  requestedCategory: "bar",
  score: 2,
  position: 0,
  conflict: false,
};

function makeRec(overrides?: Partial<Recommendation>): Recommendation {
  return {
    entityId: "V-1",
    name: "Cool Venue",
    label: "connection",
    connectionProvenance: [CONNECTION_PROVENANCE],
    categoryEvidence: undefined,
    explanation:
      "Qloo's taste graph surfaced this place when asked about Radiohead.",
    ...overrides,
  };
}

function makeEntry(
  overrides?: Partial<DiscoverPlacesResultEntry>,
): DiscoverPlacesResultEntry {
  return {
    entityId: "V-1",
    name: "Cool Venue",
    recommendation: makeRec(),
    category: "Bar",
    address: "123 Street",
    neighborhood: "Mitte",
    website: null,
    phone: "+49 30 12345678",
    priceLevel: 2,
    location: { lat: 52.52, lon: 13.405 },
    mappable: true,
    tags: [
      {
        id: "urn:tag:category:place:bar",
        name: "Bar",
        type: "urn:tag:category:place",
      },
      {
        id: "urn:tag:good_for:qloo:live_music",
        name: "Live Music",
        type: "urn:tag:good_for:qloo",
      },
    ],
    sourceQueryTypes: ["single-anchor", "blended"],
    ...overrides,
  };
}

function makeExploratoryEntry(): DiscoverPlacesResultEntry {
  return makeEntry({
    entityId: "V-2",
    name: "Nice Cafe",
    recommendation: makeRec({
      entityId: "V-2",
      name: "Nice Cafe",
      label: "exploratory",
      connectionProvenance: [],
      explanation:
        "An exploratory suggestion, not a verified direct cultural association.",
    }),
    category: "Cafe",
    address: "456 Ave",
    neighborhood: "Kreuzberg",
    website: "https://nice.cafe",
    phone: null,
    priceLevel: null,
    location: null,
    mappable: false,
    tags: [
      {
        id: "urn:tag:category:place:cafe",
        name: "Cafe",
        type: "urn:tag:category:place",
      },
    ],
    sourceQueryTypes: ["blended"],
  });
}

function makeUsefulPlaceEntry(): DiscoverPlacesResultEntry {
  return makeEntry({
    entityId: "V-3",
    name: "Record Shop",
    recommendation: makeRec({
      entityId: "V-3",
      name: "Record Shop",
      label: "useful-place",
      connectionProvenance: [],
      categoryEvidence: CATEGORY_EVIDENCE,
      explanation: "A bar with practical venue details.",
    }),
    category: "Bar",
    address: "789 Blvd",
    phone: "+49 30 99999999",
    priceLevel: 1,
    location: { lat: 52.5, lon: 13.4 },
    mappable: true,
    sourceQueryTypes: ["single-anchor"],
  });
}

function buildRecords(
  ...entries: DiscoverPlacesResultEntry[]
): Map<string, DiscoverPlacesResultEntry> {
  const map = new Map<string, DiscoverPlacesResultEntry>();
  for (const e of entries) map.set(e.entityId, e);
  return map;
}

// ── 1. Valid accepted recommendation → valid structured output ──

describe("buildRecommendation — basic valid output", () => {
  it("produces a valid structured recommendation from a connection entry", () => {
    const entry = makeEntry();
    const rec = buildRecommendation(entry);
    assert.ok(rec);
    assert.equal(rec.entityId, "V-1");
    assert.equal(rec.name, "Cool Venue");
    assert.equal(rec.label, "connection");
    assert.ok(rec.categories.includes("Bar"));
    assert.equal(rec.provenance.queryMode, "mixed");
    assert.equal(rec.provenance.connectionProvenance.length, 1);
    assert.equal(rec.provenance.connectionProvenance[0].anchorId, "R-1");
    assert.equal(rec.details.mappable, true);
    assert.ok(rec.explanation.text.length > 0);
    assert.equal(rec.explanation.verified, true);

    const parsed = StructuredRecommendationSchema.safeParse(rec);
    assert.ok(parsed.success, "Must pass Zod validation");
  });
});

// ── 2. Entity details and provenance from correct source ──

describe("buildRecommendation — provenance and details fidelity", () => {
  it("copies entity details from the source entry, not fabricated", () => {
    const entry = makeEntry();
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.address, "123 Street");
    assert.equal(rec.details.neighborhood, "Mitte");
    assert.equal(rec.details.website, null);
    assert.equal(rec.details.phone, "+49 30 12345678");
    assert.equal(rec.details.priceLevel, 2);
    assert.deepEqual(rec.details.location, { lat: 52.52, lon: 13.405 });
  });

  it("preserves connection provenance anchor IDs and ranks", () => {
    const entry = makeEntry();
    const rec = buildRecommendation(entry)!;
    assert.deepEqual(rec.provenance.anchorIds, ["R-1"]);
    assert.equal(rec.provenance.connectionProvenance[0].rank, 3);
    assert.equal(rec.provenance.connectionProvenance[0].queryId, "anchor:R-1");
  });
});

// ── 3. Unknown optional fields remain explicitly null ──

describe("buildRecommendation — unknown fields are null", () => {
  it("represents missing optional fields as null, not omitted", () => {
    const entry = makeExploratoryEntry();
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.phone, null);
    assert.equal(rec.details.priceLevel, null);
    assert.equal(rec.details.location, null);
    assert.equal(rec.provenance.categoryEvidence, null);
  });

  it("unknown fields on entries without optional props become null", () => {
    const entry: DiscoverPlacesResultEntry = {
      entityId: "V-X",
      name: "Minimal",
      recommendation: makeRec({
        entityId: "V-X",
        name: "Minimal",
        label: "exploratory",
        connectionProvenance: [],
        explanation: "Exploratory.",
      }),
      category: null,
      address: null,
      neighborhood: null,
      website: null,
    };
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.phone, null);
    assert.equal(rec.details.priceLevel, null);
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
    assert.deepEqual(rec.tags, []);
    assert.deepEqual(rec.categories, []);
  });
});

// ── 4. Missing coordinates do not invalidate but prevent map pins ──

describe("buildRecommendation — coordinate and mappability", () => {
  it("missing coordinates: accepted but not mappable", () => {
    const entry = makeEntry({ location: null, mappable: false });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
    assert.equal(rec.entityId, "V-1");
  });

  it("valid coordinates: mappable", () => {
    const entry = makeEntry();
    const rec = buildRecommendation(entry)!;
    assert.deepEqual(rec.details.location, { lat: 52.52, lon: 13.405 });
    assert.equal(rec.details.mappable, true);
  });
});

// ── 5. Malformed coordinates ──

describe("buildRecommendation — malformed coordinates", () => {
  it("NaN coordinates are rejected, entry remains accepted but unmappable", () => {
    const entry = makeEntry({ location: { lat: NaN, lon: 13.4 } });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
  });

  it("Infinity coordinates are rejected", () => {
    const entry = makeEntry({
      location: { lat: Infinity, lon: -Infinity },
    });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
  });

  it("out-of-range latitude is rejected", () => {
    const entry = makeEntry({ location: { lat: 91, lon: 13.4 } });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
  });

  it("out-of-range longitude is rejected", () => {
    const entry = makeEntry({ location: { lat: 52.5, lon: 181 } });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.details.location, null);
    assert.equal(rec.details.mappable, false);
  });

  it("isValidCoordinate rejects partial pairs (NaN + valid)", () => {
    assert.equal(isValidCoordinate(NaN, 13.4), false);
    assert.equal(isValidCoordinate(52.5, NaN), false);
    assert.equal(isValidCoordinate(52.5, 13.4), true);
    assert.equal(isValidCoordinate(-90, -180), true);
    assert.equal(isValidCoordinate(90, 180), true);
    assert.equal(isValidCoordinate(90.1, 0), false);
  });
});

// ── 6. Invented/rejected/review IDs never enter output ──

describe("buildStructuredOutput — ID filtering", () => {
  it("invented IDs are excluded and listed in invalidIds", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput(
      "Berlin",
      ["V-1"],
      ["FAKE-1", "FAKE-2"],
      records,
    );
    assert.equal(out.status, "partial");
    assert.equal(out.recommendations.length, 1);
    assert.deepEqual(out.invalidIds, ["FAKE-1", "FAKE-2"]);
    assert.equal(out.recommendations[0].entityId, "V-1");
  });

  it("all-invalid IDs produce empty output", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput(
      "Berlin",
      [],
      ["FAKE-1"],
      records,
    );
    assert.equal(out.status, "empty");
    assert.equal(out.recommendations.length, 0);
    assert.deepEqual(out.invalidIds, ["FAKE-1"]);
  });

  it("entries with null recommendation are excluded", () => {
    const noRecEntry = makeEntry({ recommendation: null });
    const records = buildRecords(noRecEntry);
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    assert.equal(out.recommendations.length, 0);
    assert.equal(out.status, "empty");
  });
});

// ── 7. Labels preserved from deterministic code ──

describe("buildRecommendation — label integrity", () => {
  it("connection label is preserved exactly", () => {
    const rec = buildRecommendation(makeEntry())!;
    assert.equal(rec.label, "connection");
  });

  it("exploratory label is preserved exactly", () => {
    const rec = buildRecommendation(makeExploratoryEntry())!;
    assert.equal(rec.label, "exploratory");
  });

  it("useful-place label is preserved exactly", () => {
    const rec = buildRecommendation(makeUsefulPlaceEntry())!;
    assert.equal(rec.label, "useful-place");
  });
});

// ── 8. Single-anchor provenance → connection only under labeler rules ──

describe("buildRecommendation — connection provenance rules", () => {
  it("connection has non-empty connectionProvenance with anchor details", () => {
    const rec = buildRecommendation(makeEntry())!;
    assert.equal(rec.provenance.connectionProvenance.length, 1);
    assert.equal(rec.provenance.connectionProvenance[0].anchorName, "Radiohead");
    assert.equal(rec.provenance.queryMode, "mixed");
  });

  it("exploratory has empty connectionProvenance", () => {
    const rec = buildRecommendation(makeExploratoryEntry())!;
    assert.equal(rec.provenance.connectionProvenance.length, 0);
    assert.deepEqual(rec.provenance.anchorIds, []);
  });
});

// ── 9. Blended-only result cannot make anchor-specific claim ──

describe("explanation — blended-only constraints", () => {
  it("blended-only basis has no anchor names", () => {
    const entry = makeExploratoryEntry();
    const rec = entry.recommendation!;
    const basis = buildExplanationBasis(rec, entry);
    assert.equal(basis.hasSingleAnchorSource, false);
    assert.equal(basis.hasBlendedSource, true);
    assert.deepEqual(basis.anchorNames, []);
  });

  it("blended-only explanation does not mention specific anchors", () => {
    const entry = makeExploratoryEntry();
    const rec = entry.recommendation!;
    const expl = generateVerifiedExplanation(rec, entry);
    assert.ok(!expl.text.includes("Radiohead"));
    assert.equal(expl.verified, true);
  });
});

// ── 10. Broad-query results cannot receive fabricated anchor attribution ──

describe("explanation — no fabricated anchor attribution", () => {
  it("exploratory provenance has queryMode blended, no anchor IDs", () => {
    const rec = buildRecommendation(makeExploratoryEntry())!;
    assert.equal(rec.provenance.queryMode, "blended");
    assert.deepEqual(rec.provenance.anchorIds, []);
    assert.equal(rec.provenance.connectionProvenance.length, 0);
  });
});

// ── 11. Explainability shares not represented as match percentages ──

describe("explanation verification — no percentages or confidence", () => {
  it("rejects explanation with fabricated percentage", () => {
    const basis: ExplanationBasis = {
      label: "connection",
      hasSingleAnchorSource: true,
      hasBlendedSource: false,
      hasCategoryEvidence: false,
      hasVenueEvidence: false,
      anchorNames: ["Radiohead"],
      category: null,
    };
    const { valid, violations } = verifyExplanation(
      "This place has a 85% match with your taste profile.",
      basis,
    );
    assert.equal(valid, false);
    assert.ok(violations.some((v) => v.includes("percentage")));
  });

  it("rejects explanation with confidence claim", () => {
    const basis: ExplanationBasis = {
      label: "exploratory",
      hasSingleAnchorSource: false,
      hasBlendedSource: true,
      hasCategoryEvidence: false,
      hasVenueEvidence: false,
      anchorNames: [],
      category: null,
    };
    const { valid, violations } = verifyExplanation(
      "High confidence match score based on your interests.",
      basis,
    );
    assert.equal(valid, false);
    assert.ok(violations.some((v) => v.includes("confidence")));
  });
});

// ── 12. Unknown hours, price, rating, address never invented ──

describe("explanation — no invented claims", () => {
  it("rejects opening hours claim when no venue evidence exists", () => {
    const basis: ExplanationBasis = {
      label: "exploratory",
      hasSingleAnchorSource: false,
      hasBlendedSource: true,
      hasCategoryEvidence: false,
      hasVenueEvidence: false,
      anchorNames: [],
      category: null,
    };
    const { valid, violations } = verifyExplanation(
      "Open until midnight, this bar is great.",
      basis,
    );
    assert.equal(valid, false);
    assert.ok(violations.some((v) => v.includes("opening hours")));
  });

  it("deterministic explanation never mentions hours, price, or rating", () => {
    const basis: ExplanationBasis = {
      label: "useful-place",
      hasSingleAnchorSource: false,
      hasBlendedSource: false,
      hasCategoryEvidence: true,
      hasVenueEvidence: true,
      anchorNames: [],
      category: "Bar",
    };
    const text = generateDeterministicExplanation(basis);
    assert.ok(!text.includes("open"));
    assert.ok(!text.includes("price"));
    assert.ok(!text.includes("rating"));
    assert.ok(!text.includes("$"));
  });
});

// ── 13. Unsupported model-generated claims rejected or replaced ──

describe("generateVerifiedExplanation — model text rejection", () => {
  it("replaces invalid model text with labeler explanation", () => {
    const entry = makeEntry();
    const rec = entry.recommendation!;
    const expl = generateVerifiedExplanation(
      rec,
      entry,
      "This place is connected to your profile with 92% confidence!",
    );
    assert.equal(expl.fallback, false);
    assert.ok(!expl.text.includes("92%"));
    assert.ok(expl.text.includes("Radiohead"));
  });

  it("replaces invalid model text with deterministic fallback if labeler also fails", () => {
    const entry = makeExploratoryEntry();
    const badRec = makeRec({
      entityId: "V-2",
      name: "Nice Cafe",
      label: "exploratory",
      connectionProvenance: [],
      explanation: "Connected to your taste profile with high match score.",
    });
    const updated = { ...entry, recommendation: badRec };
    const expl = generateVerifiedExplanation(
      badRec,
      updated,
      "95% confidence match!",
    );
    assert.equal(expl.fallback, true);
    assert.equal(expl.verified, true);
    assert.ok(!expl.text.includes("95%"));
    assert.ok(!expl.text.includes("Connected to"));
  });
});

// ── 14. Valid grounded explanations remain usable ──

describe("generateVerifiedExplanation — valid explanations pass", () => {
  it("labeler connection explanation passes verification", () => {
    const entry = makeEntry();
    const rec = entry.recommendation!;
    const expl = generateVerifiedExplanation(rec, entry);
    assert.equal(expl.verified, true);
    assert.equal(expl.fallback, false);
    assert.ok(expl.text.includes("Radiohead"));
  });

  it("labeler exploratory explanation passes verification", () => {
    const entry = makeExploratoryEntry();
    const rec = entry.recommendation!;
    const expl = generateVerifiedExplanation(rec, entry);
    assert.equal(expl.verified, true);
    assert.equal(expl.fallback, false);
  });

  it("valid grounded model text is accepted", () => {
    const entry = makeEntry();
    const rec = entry.recommendation!;
    const expl = generateVerifiedExplanation(
      rec,
      entry,
      "Qloo surfaced this bar based on your Radiohead selection.",
    );
    assert.equal(expl.verified, true);
    assert.equal(expl.fallback, false);
    assert.ok(expl.text.includes("Radiohead"));
  });
});

// ── 15. Invalid finalization, empty results, partial failures ──

describe("buildStructuredOutput — edge cases", () => {
  it("empty valid IDs produce empty status", () => {
    const out = buildStructuredOutput("Berlin", [], [], new Map());
    assert.equal(out.status, "empty");
    assert.equal(out.recommendations.length, 0);
    assert.equal(out.totalRecommendations, 0);
    assert.equal(out.summary, "No verified recommendations for Berlin.");
  });

  it("partial: some valid, some invalid IDs", () => {
    const records = buildRecords(makeEntry(), makeExploratoryEntry());
    const out = buildStructuredOutput(
      "Berlin",
      ["V-1"],
      ["GONE-1"],
      records,
    );
    assert.equal(out.status, "partial");
    assert.equal(out.recommendations.length, 1);
    assert.deepEqual(out.invalidIds, ["GONE-1"]);
  });

  it("success: all valid IDs", () => {
    const records = buildRecords(makeEntry(), makeExploratoryEntry());
    const out = buildStructuredOutput(
      "Berlin",
      ["V-1", "V-2"],
      [],
      records,
    );
    assert.equal(out.status, "success");
    assert.equal(out.recommendations.length, 2);
    assert.equal(out.totalRecommendations, 2);
    assert.deepEqual(out.invalidIds, []);
  });

  it("validates against full Zod schema", () => {
    const records = buildRecords(makeEntry(), makeExploratoryEntry());
    const out = buildStructuredOutput(
      "Berlin",
      ["V-1", "V-2"],
      [],
      records,
    );
    const parsed = StructuredOutputSchema.safeParse(out);
    assert.ok(parsed.success, "Full output must pass Zod validation");
  });
});

// ── 16. Output serialization does not leak secrets ──

describe("buildStructuredOutput — no secret leakage", () => {
  it("serialized output contains no api_key, secret, token, or auth fields", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    const json = JSON.stringify(out);
    assert.ok(!/api.?key/i.test(json), "Must not contain api_key");
    assert.ok(!/\bsecret\b/i.test(json), "Must not contain secret");
    assert.ok(!/authorization/i.test(json), "Must not contain authorization");
    assert.ok(!/credential/i.test(json), "Must not contain credential");
    assert.ok(!/password/i.test(json), "Must not contain password");
  });

  it("trace data and rejected candidates are not in output", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("trace"), "Must not contain trace data");
    assert.ok(!json.includes("rejected"), "Must not contain rejected data");
    assert.ok(!json.includes("review"), "Must not contain review data");
  });
});

// ── Additional: category extraction from tags ──

describe("buildRecommendation — category extraction", () => {
  it("extracts category names from urn:tag:category:place:* tags", () => {
    const entry = makeEntry({
      tags: [
        {
          id: "urn:tag:category:place:bar",
          name: "Bar",
          type: "urn:tag:category:place",
        },
        {
          id: "urn:tag:category:place:cocktail_bar",
          name: "Cocktail Bar",
          type: "urn:tag:category:place",
        },
        {
          id: "urn:tag:good_for:qloo:date_night",
          name: "Date Night",
          type: "urn:tag:good_for:qloo",
        },
      ],
    });
    const rec = buildRecommendation(entry)!;
    assert.deepEqual(rec.categories, ["Bar", "Cocktail Bar"]);
  });

  it("falls back to entry.category when no tags", () => {
    const entry = makeEntry({ tags: undefined, category: "Bar" });
    const rec = buildRecommendation(entry)!;
    assert.deepEqual(rec.categories, ["Bar"]);
  });

  it("returns empty categories when no tags and no category", () => {
    const entry = makeEntry({ tags: [], category: null });
    const rec = buildRecommendation(entry)!;
    assert.deepEqual(rec.categories, []);
  });
});

// ── Additional: multiple anchors in provenance ──

describe("buildRecommendation — multi-anchor provenance", () => {
  it("preserves all qualifying anchor connections", () => {
    const entry = makeEntry({
      recommendation: makeRec({
        connectionProvenance: [
          {
            anchorId: "R-1",
            anchorName: "Radiohead",
            rank: 2,
            queryId: "anchor:R-1",
          },
          {
            anchorId: "PK-1",
            anchorName: "Prateek Kuhad",
            rank: 5,
            queryId: "anchor:PK-1",
          },
        ],
        explanation:
          "Qloo's taste graph surfaced this place when asked about Radiohead and Prateek Kuhad.",
      }),
    });
    const rec = buildRecommendation(entry)!;
    assert.equal(rec.provenance.connectionProvenance.length, 2);
    assert.deepEqual(rec.provenance.anchorIds, ["R-1", "PK-1"]);
    assert.equal(rec.provenance.queryMode, "mixed");
  });
});

// ── Deterministic summary replaces model summary ─────────────

describe("buildStructuredOutput — deterministic summary", () => {
  it("success summary includes city and count", () => {
    const records = buildRecords(makeEntry(), makeExploratoryEntry());
    const out = buildStructuredOutput("Berlin", ["V-1", "V-2"], [], records);
    assert.equal(out.summary, "Found 2 recommendations in Berlin.");
  });

  it("singular form for one recommendation", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    assert.equal(out.summary, "Found 1 recommendation in Berlin.");
  });

  it("partial summary includes invalid count", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], ["FAKE-1", "FAKE-2"], records);
    assert.equal(out.summary, "Found 1 recommendation in Berlin. 2 could not be verified.");
  });

  it("empty summary includes city", () => {
    const out = buildStructuredOutput("Berlin", [], [], new Map());
    assert.equal(out.summary, "No verified recommendations for Berlin.");
  });

  it("model-provided summary text cannot reach the public output", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    assert.ok(out.summary.startsWith("Found ") || out.summary.startsWith("No "));
    assert.ok(!out.summary.includes("I recommend"));
    assert.ok(!out.summary.includes("%"));
    assert.ok(!out.summary.includes("confidence"));
    assert.ok(!out.summary.includes("highly rated"));
    assert.ok(!out.summary.includes("personally connected"));
  });
});

// ── Schema validation at production boundary ─────────────────

describe("validateOutput — schema enforcement", () => {
  it("valid output passes through unchanged", () => {
    const records = buildRecords(makeEntry());
    const out = buildStructuredOutput("Berlin", ["V-1"], [], records);
    const validated = validateOutput(out, "Berlin");
    assert.deepEqual(validated, out);
  });

  it("schema-invalid output throws OutputValidationError", () => {
    const invalid = {
      status: "banana",
      summary: 123,
      recommendations: "not an array",
      totalRecommendations: "five",
      invalidIds: null,
    };
    assert.throws(
      () => validateOutput(invalid, "Tokyo"),
      (err: unknown) => err instanceof OutputValidationError,
    );
  });

  it("thrown error does not leak raw source data or secrets", () => {
    const invalid = {
      status: "success",
      summary: "api_key=sk-12345 secret password",
      recommendations: [{ bad: "data", credential: "xyz" }],
      totalRecommendations: 1,
      invalidIds: [],
    };
    try {
      validateOutput(invalid, "Berlin");
      assert.fail("expected OutputValidationError");
    } catch (err) {
      assert.ok(err instanceof OutputValidationError);
      const msg = err.message;
      assert.ok(!msg.includes("api_key"));
      assert.ok(!msg.includes("sk-12345"));
      assert.ok(!msg.includes("credential"));
      assert.ok(!msg.includes("password"));
    }
  });

  it("full buildStructuredOutput result passes schema validation", () => {
    const records = buildRecords(makeEntry(), makeExploratoryEntry(), makeUsefulPlaceEntry());
    const out = buildStructuredOutput("Berlin", ["V-1", "V-2", "V-3"], [], records);
    const parsed = StructuredOutputSchema.safeParse(out);
    assert.ok(parsed.success, "Builder output must always pass Zod validation");
  });
});
