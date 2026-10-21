import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PERSONA_PRESETS,
  DEFAULT_PRESET_ID,
  DEFAULT_CITY,
  TESTED_CITIES,
  MAX_TRUSTED_ANCHORS,
  getPresetById,
  createInitialFlowState,
  selectPreset,
  selectCity,
  addAnchor,
  updateAnchor,
  removeAnchor,
  startAnchorLookup,
  applyAnchorLookupResult,
  applyAnchorLookupFailure,
  confirmAnchorCandidate,
  unconfirmAnchor,
  canGenerateKit,
  buildKitRequestPayload,
  deriveFlowPhase,
  startKitGeneration,
  applyKitGenerationResponse,
  applyKitGenerationError,
  parseSafeKitResponse,
  sanitizeUiError,
  createKitSubmissionController,
} from "../lib/input";
import type { FlowState } from "../lib/input";
import {
  handleAnchorSearch,
  handleKitRequest,
  KitRequestSchema,
  verifyConfirmedAnchors,
  clearRateLimits,
  clearResponseCache,
} from "../lib/api";
import { SearchResponseSchema } from "../lib/qloo/schemas";
import type { SearchResponse } from "../lib/qloo/schemas";
import { MUMBAI_NEWCOMER } from "../lib/discover/demo-profile";
import { POST as discoverRoutePost } from "../app/api/discover/route";

function loadSearchFixture(name: string): SearchResponse {
  const path = resolve(import.meta.dirname, "fixtures", name);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return SearchResponseSchema.parse(raw);
}

const FIXTURE_BY_QUERY: Record<string, SearchResponse> = {
  "arijit singh": loadSearchFixture("search-arijit-singh.json"),
  "the office": loadSearchFixture("search-the-office.json"),
  radiohead: loadSearchFixture("search-radiohead.json"),
  zara: loadSearchFixture("search-zara.json"),
};

async function fakeSearchEntity(query: string) {
  const key = query.toLowerCase().trim();
  const data = FIXTURE_BY_QUERY[key] ?? { results: [] };
  return {
    data,
    meta: { path: "/search", params: { query, take: "10" }, cached: false },
  };
}

beforeEach(() => {
  clearRateLimits();
  clearResponseCache();
});

// ── 1. All three presets load the intended queries and types ──

describe("1. Persona presets — intended queries, types, and default", () => {
  it("defines Mumbai newcomer as the default preset with exact anchors", () => {
    assert.equal(DEFAULT_PRESET_ID, "mumbai-newcomer");
    const mumbai = getPresetById("mumbai-newcomer");
    assert.equal(mumbai.isDefault, true);
    assert.equal(mumbai.name, "Mumbai newcomer");
    assert.ok(mumbai.description.length > 10);
    assert.deepEqual(mumbai.anchors, [
      { query: "Arijit Singh", type: "urn:entity:artist" },
      { query: "The Office", type: "urn:entity:tv_show" },
      { query: "Radiohead", type: "urn:entity:artist" },
      { query: "Zara", type: "urn:entity:brand" },
    ]);
  });

  it("defines Art & indie preset with Radiohead, Björk, and A24", () => {
    const artIndie = getPresetById("art-indie");
    assert.equal(artIndie.isDefault, false);
    assert.equal(artIndie.name, "Art & indie");
    assert.ok(artIndie.description.length > 10);
    assert.deepEqual(artIndie.anchors, [
      { query: "Radiohead", type: "urn:entity:artist" },
      { query: "Björk", type: "urn:entity:artist" },
      { query: "A24", type: "urn:entity:brand" },
    ]);
  });

  it("defines Food & fashion preset with The Bear, Anthony Bourdain, Vogue, and Zara", () => {
    const foodFashion = getPresetById("food-fashion");
    assert.equal(foodFashion.isDefault, false);
    assert.equal(foodFashion.name, "Food & fashion");
    assert.ok(foodFashion.description.length > 10);
    assert.deepEqual(foodFashion.anchors, [
      { query: "The Bear", type: "urn:entity:tv_show" },
      { query: "Anthony Bourdain", type: "urn:entity:person" },
      { query: "Vogue", type: "urn:entity:brand" },
      { query: "Zara", type: "urn:entity:brand" },
    ]);
  });

  it("loads each preset into FlowState with exact queries and types while preserving city", () => {
    let state = createInitialFlowState("mumbai-newcomer", "Toronto");
    assert.equal(state.city, "Toronto");
    assert.equal(deriveFlowPhase(state), "initial_profile");
    assert.deepEqual(
      state.anchors.map((a) => ({ query: a.query, type: a.type })),
      [
        { query: "Arijit Singh", type: "urn:entity:artist" },
        { query: "The Office", type: "urn:entity:tv_show" },
        { query: "Radiohead", type: "urn:entity:artist" },
        { query: "Zara", type: "urn:entity:brand" },
      ],
    );

    const toArt = selectPreset(state, "art-indie");
    assert.equal(toArt.ok, true);
    state = toArt.state;
    assert.equal(state.city, "Toronto", "city must never change silently when switching presets");
    assert.deepEqual(
      state.anchors.map((a) => ({ query: a.query, type: a.type })),
      [
        { query: "Radiohead", type: "urn:entity:artist" },
        { query: "Björk", type: "urn:entity:artist" },
        { query: "A24", type: "urn:entity:brand" },
      ],
    );

    const toFood = selectPreset(state, "food-fashion");
    assert.equal(toFood.ok, true);
    state = toFood.state;
    assert.equal(state.city, "Toronto");
    assert.deepEqual(
      state.anchors.map((a) => ({ query: a.query, type: a.type })),
      [
        { query: "The Bear", type: "urn:entity:tv_show" },
        { query: "Anthony Bourdain", type: "urn:entity:person" },
        { query: "Vogue", type: "urn:entity:brand" },
        { query: "Zara", type: "urn:entity:brand" },
      ],
    );
  });
});

// ── 2. Selecting Custom starts a usable blank anchor flow ────

describe("2. Custom preset — blank anchor flow", () => {
  it("starts with an empty anchor list and allows adding, looking up, and confirming custom anchors", async () => {
    const initial = createInitialFlowState("mumbai-newcomer", "Berlin");
    const customTransition = selectPreset(initial, "custom");
    assert.equal(customTransition.ok, true);

    let state = customTransition.state;
    assert.equal(state.selectedPresetId, "custom");
    assert.equal(state.city, "Berlin");
    assert.equal(state.anchors.length, 0);
    assert.equal(deriveFlowPhase(state), "editing_anchors");
    assert.equal(canGenerateKit(state), false);

    // Add a custom anchor
    const added = addAnchor(state, "Radiohead", "urn:entity:artist");
    assert.equal(added.ok, true);
    state = added.state;
    assert.equal(state.anchors.length, 1);
    assert.equal(state.anchors[0].query, "Radiohead");
    assert.equal(state.anchors[0].type, "urn:entity:artist");
    assert.equal(state.anchors[0].status, "unsearched");
    assert.equal(state.anchors[0].confirmedEntity, null);

    // Look up candidate
    const anchorId = state.anchors[0].id;
    state = startAnchorLookup(state, anchorId);
    assert.equal(deriveFlowPhase(state), "searching_matches");

    const { response } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: fakeSearchEntity },
    );
    state = applyAnchorLookupResult(state, anchorId, response);
    assert.equal(deriveFlowPhase(state), "waiting_for_confirmation");
    assert.equal(canGenerateKit(state), false);

    // Confirm candidate
    const confirmed = confirmAnchorCandidate(
      state,
      anchorId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    );
    assert.equal(confirmed.ok, true);
    state = confirmed.state;
    assert.equal(deriveFlowPhase(state), "ready_to_generate");
    assert.equal(canGenerateKit(state), true);
  });
});

// ── 3. Preset anchors must still be searched for and explicitly confirmed ──

describe("3. Preset anchors require lookup and explicit confirmation", () => {
  it("preset definitions never contain hardcoded entityIds and start unconfirmed", () => {
    for (const preset of PERSONA_PRESETS) {
      for (const anchor of preset.anchors) {
        assert.deepEqual(Object.keys(anchor).sort(), ["query", "type"]);
      }
    }

    const state = createInitialFlowState("mumbai-newcomer", "Berlin");
    assert.equal(canGenerateKit(state), false);
    assert.equal(buildKitRequestPayload(state), null);
    for (const anchor of state.anchors) {
      assert.equal(anchor.status, "unsearched");
      assert.equal(anchor.confirmedEntity, null);
    }
  });

  it("searching preset anchors never auto-confirms even when only 1 candidate matches", async () => {
    let state = createInitialFlowState("mumbai-newcomer", "Berlin");

    for (const anchor of state.anchors) {
      const { response } = await handleAnchorSearch(
        { query: anchor.query, type: anchor.type },
        "test-client",
        { searchEntity: fakeSearchEntity },
      );
      state = applyAnchorLookupResult(state, anchor.id, response);
    }

    // Even though Arijit Singh, Radiohead, and Zara each have exactly 1 candidate,
    // NONE of them may be automatically confirmed!
    for (const anchor of state.anchors) {
      assert.equal(anchor.status, "candidates");
      assert.equal(anchor.confirmedEntity, null);
      assert.ok(anchor.candidates.length >= 1);
    }
    assert.equal(deriveFlowPhase(state), "waiting_for_confirmation");
    assert.equal(canGenerateKit(state), false);
    assert.equal(buildKitRequestPayload(state), null);
  });
});

// ── 4. User can select a specific candidate without silently choosing first ──

describe("4. Explicit candidate selection — non-first candidate", () => {
  it("allows selecting the second candidate (2001 UK Office) instead of the first (2005 US Office)", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "The Office", "urn:entity:tv_show").state;
    const anchorId = state.anchors[0].id;

    const { response } = await handleAnchorSearch(
      { query: "The Office", type: "urn:entity:tv_show" },
      "test-client",
      { searchEntity: fakeSearchEntity },
    );
    state = applyAnchorLookupResult(state, anchorId, response);

    assert.equal(state.anchors[0].candidates.length, 2);
    assert.equal(
      state.anchors[0].candidates[0].entityId,
      "E5AE1F26-04CB-4CDD-BBA4-87FB6541F848",
    );
    assert.equal(
      state.anchors[0].candidates[1].entityId,
      "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
    );
    assert.equal(state.anchors[0].confirmedEntity, null);

    // Explicitly choose the second candidate
    const confirmed = confirmAnchorCandidate(
      state,
      anchorId,
      "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
    );
    assert.equal(confirmed.ok, true);
    state = confirmed.state;

    assert.equal(state.anchors[0].status, "confirmed");
    assert.equal(
      state.anchors[0].confirmedEntity?.entityId,
      "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
    );
    assert.equal(state.anchors[0].confirmedEntity?.disambiguation, "2001,2003");
  });
});

// ── 5. No match, ambiguous candidates, and lookup failures handled safely ──

describe("5. Safe handling of no_matches, ambiguous candidates, and lookup_error", () => {
  it("handles zero-match lookup as a recoverable state (edit or remove)", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Nonexistent Band XYZ", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;

    const { response } = await handleAnchorSearch(
      { query: "Nonexistent Band XYZ", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: fakeSearchEntity },
    );
    assert.equal(response.status, "no_matches");

    state = applyAnchorLookupResult(state, anchorId, response);
    assert.equal(state.anchors[0].status, "no_matches");
    assert.equal(deriveFlowPhase(state), "lookup_failure");
    assert.equal(canGenerateKit(state), false);

    // Recovery option A: edit the anchor to a valid query
    const edited = updateAnchor(state, anchorId, "Radiohead", "urn:entity:artist");
    assert.equal(edited.ok, true);
    state = edited.state;
    assert.equal(state.anchors[0].status, "unsearched");
    assert.equal(state.anchors[0].query, "Radiohead");
  });

  it("handles lookup failure safely and allows removal or retry", () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    state = addAnchor(state, "Broken Lookup", "urn:entity:artist").state;

    const firstId = state.anchors[0].id;
    const secondId = state.anchors[1].id;

    // Confirm first anchor
    state = applyAnchorLookupResult(state, firstId, {
      status: "matches",
      resolutionStatus: "resolved",
      query: "Radiohead",
      requestedType: "urn:entity:artist",
      candidates: [
        {
          entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
          name: "Radiohead",
          types: ["urn:entity:artist"],
        },
      ],
    });
    state = confirmAnchorCandidate(
      state,
      firstId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;

    // Second anchor fails lookup
    state = applyAnchorLookupFailure(
      state,
      secondId,
      new Error("Network error with api_key=secret-123"),
    );
    assert.equal(state.anchors[1].status, "lookup_error");
    assert.ok(!state.anchors[1].errorMessage?.includes("secret-123"));
    assert.equal(deriveFlowPhase(state), "lookup_failure");
    assert.equal(canGenerateKit(state), false);

    // Remove the failed anchor -> remaining confirmed anchor makes the kit ready to generate
    const removed = removeAnchor(state, secondId);
    assert.equal(removed.ok, true);
    state = removed.state;
    assert.equal(deriveFlowPhase(state), "ready_to_generate");
    assert.equal(canGenerateKit(state), true);
  });
});

// ── 6. Confirmed-anchor payloads preserve exact query/type/entityId associations ──

describe("6. Confirmed-anchor payload association and server verification", () => {
  it("preserves exact query, type, entityId, and canonical name for /api/kit verification", async () => {
    let state = createInitialFlowState("mumbai-newcomer", "Berlin");

    for (const anchor of state.anchors) {
      const { response } = await handleAnchorSearch(
        { query: anchor.query, type: anchor.type },
        "test-client",
        { searchEntity: fakeSearchEntity },
      );
      state = applyAnchorLookupResult(state, anchor.id, response);
    }

    // Confirm each anchor (selecting second candidate for The Office)
    state = confirmAnchorCandidate(
      state,
      state.anchors[0].id,
      "924C8504-4BD8-4615-AB2D-1C16880A8A62",
    ).state;
    state = confirmAnchorCandidate(
      state,
      state.anchors[1].id,
      "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
    ).state;
    state = confirmAnchorCandidate(
      state,
      state.anchors[2].id,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;
    state = confirmAnchorCandidate(
      state,
      state.anchors[3].id,
      "74A44B01-5C99-4754-9585-F487D21C543D",
    ).state;

    const payload = buildKitRequestPayload(state);
    assert.ok(payload);

    const schemaCheck = KitRequestSchema.safeParse(payload);
    assert.equal(schemaCheck.success, true);

    assert.deepEqual(payload.confirmedAnchors, [
      {
        entityId: "924C8504-4BD8-4615-AB2D-1C16880A8A62",
        name: "Arijit Singh",
        query: "Arijit Singh",
        type: "urn:entity:artist",
      },
      {
        entityId: "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
        name: "The Office",
        query: "The Office",
        type: "urn:entity:tv_show",
      },
      {
        entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
        name: "Radiohead",
        query: "Radiohead",
        type: "urn:entity:artist",
      },
      {
        entityId: "74A44B01-5C99-4754-9585-F487D21C543D",
        name: "Zara",
        query: "Zara",
        type: "urn:entity:brand",
      },
    ]);

    // Verify server-side verification accepts all 4 confirmed anchors
    const verification = await verifyConfirmedAnchors(
      payload.confirmedAnchors!,
      payload.anchors,
      fakeSearchEntity,
    );
    assert.equal(verification.verified.length, 4);
    assert.equal(verification.rejected.length, 0);
  });
});

// ── 7. Unconfirmed or removed candidates cannot be submitted as confirmations ──

describe("7. Unconfirmed, edited, or removed anchors cannot be submitted", () => {
  it("blocks submission when any anchor has unconfirmed candidates", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    state = addAnchor(state, "Zara", "urn:entity:brand").state;

    for (const anchor of state.anchors) {
      const { response } = await handleAnchorSearch(
        { query: anchor.query, type: anchor.type },
        "test-client",
        { searchEntity: fakeSearchEntity },
      );
      state = applyAnchorLookupResult(state, anchor.id, response);
    }

    // Confirm only Radiohead; leave Zara in "candidates" (unconfirmed)
    state = confirmAnchorCandidate(
      state,
      state.anchors[0].id,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;

    assert.equal(canGenerateKit(state), false);
    assert.equal(buildKitRequestPayload(state), null);
  });

  it("removes confirmation when an anchor is removed, unconfirmed, or edited", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    state = addAnchor(state, "Zara", "urn:entity:brand").state;

    for (const anchor of state.anchors) {
      const { response } = await handleAnchorSearch(
        { query: anchor.query, type: anchor.type },
        "test-client",
        { searchEntity: fakeSearchEntity },
      );
      state = applyAnchorLookupResult(state, anchor.id, response);
    }

    state = confirmAnchorCandidate(
      state,
      state.anchors[0].id,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;
    state = confirmAnchorCandidate(
      state,
      state.anchors[1].id,
      "74A44B01-5C99-4754-9585-F487D21C543D",
    ).state;
    assert.equal(canGenerateKit(state), true);

    // Editing Zara to a different query clears its confirmation immediately
    const edited = updateAnchor(
      state,
      state.anchors[1].id,
      "Arijit Singh",
      "urn:entity:artist",
    );
    assert.equal(edited.ok, true);
    state = edited.state;
    assert.equal(state.anchors[1].status, "unsearched");
    assert.equal(state.anchors[1].confirmedEntity, null);
    assert.equal(canGenerateKit(state), false);

    // Stale lookup result for the old query ("Zara") must be ignored
    const afterStaleLookup = applyAnchorLookupResult(state, state.anchors[1].id, {
      status: "matches",
      resolutionStatus: "resolved",
      query: "Zara",
      requestedType: "urn:entity:brand",
      candidates: [
        {
          entityId: "74A44B01-5C99-4754-9585-F487D21C543D",
          name: "Zara",
          types: ["urn:entity:brand"],
        },
      ],
    });
    assert.equal(afterStaleLookup.anchors[1].status, "unsearched");
    assert.equal(afterStaleLookup.anchors[1].candidates.length, 0);

    // Removing the unconfirmed second anchor leaves only the confirmed Radiohead anchor
    state = removeAnchor(state, state.anchors[1].id).state;
    const payload = buildKitRequestPayload(state);
    assert.ok(payload);
    assert.equal(payload.anchors.length, 1);
    assert.equal(payload.confirmedAnchors?.length, 1);
    assert.equal(payload.confirmedAnchors?.[0].name, "Radiohead");

    // Unconfirming Radiohead blocks submission again
    state = unconfirmAnchor(state, state.anchors[0].id).state;
    assert.equal(state.anchors[0].confirmedEntity, null);
    assert.equal(canGenerateKit(state), false);
    assert.equal(buildKitRequestPayload(state), null);
  });

  it("rejects confirming an entityId that was not returned in the anchor's candidates", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;

    const { response } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: fakeSearchEntity },
    );
    state = applyAnchorLookupResult(state, anchorId, response);

    const bogusConfirm = confirmAnchorCandidate(state, anchorId, "INVENTED-ID-999");
    assert.equal(bogusConfirm.ok, false);
    assert.equal(bogusConfirm.state.anchors[0].confirmedEntity, null);
  });

  it("enforces MAX_TRUSTED_ANCHORS (5) and prevents duplicate anchors", () => {
    let state = createInitialFlowState("custom", "Berlin");
    const queries = ["A1", "A2", "A3", "A4", "A5"];
    for (const q of queries) {
      const res = addAnchor(state, q, "urn:entity:artist");
      assert.equal(res.ok, true);
      state = res.state;
    }
    assert.equal(state.anchors.length, MAX_TRUSTED_ANCHORS);

    // 6th anchor rejected
    const sixth = addAnchor(state, "A6", "urn:entity:artist");
    assert.equal(sixth.ok, false);
    assert.equal(sixth.state.anchors.length, 5);

    // Duplicate query+type rejected
    state = removeAnchor(state, state.anchors[4].id).state;
    const dup = addAnchor(state, "  a1  ", "urn:entity:artist");
    assert.equal(dup.ok, false);
  });
});

// ── 8. Final request includes selected city and confirmed anchors ──

describe("8. End-to-end request compatibility with /api/kit", () => {
  it("includes selected city (Berlin or Toronto) and passes handleKitRequest end-to-end", async () => {
    assert.deepEqual(TESTED_CITIES, ["Berlin", "Toronto"]);
    assert.equal(DEFAULT_CITY, "Berlin");

    let state = createInitialFlowState("custom", "Berlin");
    state = selectCity(state, "Toronto").state;
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;

    const { response: searchRes } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "test-client",
      { searchEntity: fakeSearchEntity },
    );
    state = applyAnchorLookupResult(state, anchorId, searchRes);
    state = confirmAnchorCandidate(
      state,
      anchorId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;

    const payload = buildKitRequestPayload(state);
    assert.ok(payload);
    assert.equal(payload.city, "Toronto");
    assert.deepEqual(payload.anchors, [
      { query: "Radiohead", type: "urn:entity:artist" },
    ]);
    assert.deepEqual(payload.confirmedAnchors, [
      {
        entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
        name: "Radiohead",
        query: "Radiohead",
        type: "urn:entity:artist",
      },
    ]);

    let receivedAgentInput: unknown;
    const { httpStatus, response: kitRes } = await handleKitRequest(
      payload,
      "test-client",
      {
        searchEntity: fakeSearchEntity,
        runAgent: async (input) => {
          receivedAgentInput = input;
          return {
            runId: "run-123",
            status: "completed",
            finalization: {
              summary: "Done",
              recommendationIds: [],
              recommendationCount: 0,
            },
            output: {
              status: "empty",
              summary: "No verified recommendations for Toronto.",
              recommendations: [],
              totalRecommendations: 0,
              invalidIds: [],
            },
            trace: [],
            toolCallCount: 1,
            qlooOutboundRequests: 1,
            qlooCacheHits: 0,
            totalDurationMs: 50,
          };
        },
      },
    );

    assert.equal(httpStatus, 200);
    assert.equal(kitRes.meta.city, "Toronto");
    assert.deepEqual(receivedAgentInput, {
      city: "Toronto",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
      confirmedAnchors: [
        {
          entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
          name: "Radiohead",
        },
      ],
    });
  });
});

// ── 9. Loading, empty, partial, success, and error responses handled correctly ──

describe("9. Generation states — loading, success, partial, empty, error", () => {
  function makeReadyState(): FlowState {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;
    state = applyAnchorLookupResult(state, anchorId, {
      status: "matches",
      resolutionStatus: "resolved",
      query: "Radiohead",
      requestedType: "urn:entity:artist",
      candidates: [
        {
          entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
          name: "Radiohead",
          types: ["urn:entity:artist"],
        },
      ],
    });
    return confirmAnchorCandidate(
      state,
      anchorId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;
  }

  function makeValidKitPayload(status: "success" | "partial" | "empty") {
    const recs =
      status === "empty"
        ? []
        : [
            {
              entityId: "V-1",
              name: "Heimathafen Neukölln",
              label: "connection" as const,
              categories: ["Live Music Venue"],
              provenance: {
                queryMode: "single-anchor" as const,
                anchorIds: ["70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C"],
                connectionProvenance: [
                  {
                    anchorId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
                    anchorName: "Radiohead",
                    rank: 1,
                    queryId: "anchor:70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
                  },
                ],
                categoryEvidence: null,
              },
              details: {
                address: "Karl-Marx-Straße 141",
                neighborhood: "Neukölln",
                website: "https://heimathafen-neukoelln.de",
                phone: null,
                priceLevel: 2,
                location: { lat: 52.47, lon: 13.44 },
                mappable: true,
              },
              tags: [],
              explanation: {
                text: "Qloo's taste graph surfaced this place when asked about Radiohead.",
                basis: {
                  label: "connection" as const,
                  hasSingleAnchorSource: true,
                  hasBlendedSource: false,
                  hasCategoryEvidence: false,
                  hasVenueEvidence: true,
                  anchorNames: ["Radiohead"],
                  category: "Live Music Venue",
                },
                verified: true,
                fallback: false,
              },
            },
          ];

    return {
      status,
      output: {
        status,
        summary:
          status === "empty"
            ? "No verified recommendations for Berlin."
            : "Found 1 recommendation in Berlin.",
        recommendations: recs,
        totalRecommendations: recs.length,
        invalidIds: status === "partial" ? ["BAD-1"] : [],
      },
      meta: {
        runId: "r-1",
        city: "Berlin",
        anchorCount: 1,
        mode: "agent",
        cached: false,
        durationMs: 250,
      },
    };
  }

  it("handles loading -> success transition", () => {
    const ready = makeReadyState();
    const loading = startKitGeneration(ready);
    assert.equal(loading.ok, true);
    assert.equal(deriveFlowPhase(loading.state), "generating");

    const done = applyKitGenerationResponse(
      loading.state,
      makeValidKitPayload("success"),
      200,
    );
    assert.equal(deriveFlowPhase(done), "success");
    assert.equal(done.generation.status, "success");
    assert.equal(done.generation.result?.recommendations.length, 1);
    assert.equal(
      done.generation.result?.recommendations[0].name,
      "Heimathafen Neukölln",
    );
    assert.equal(done.generation.result?.recommendations[0].label, "connection");
    assert.equal(
      done.generation.result?.recommendations[0].explanationText,
      "Qloo's taste graph surfaced this place when asked about Radiohead.",
    );
  });

  it("handles partial response correctly", () => {
    const ready = makeReadyState();
    const loading = startKitGeneration(ready).state;
    const partial = applyKitGenerationResponse(
      loading,
      makeValidKitPayload("partial"),
      200,
    );
    assert.equal(deriveFlowPhase(partial), "success");
    assert.equal(partial.generation.status, "partial");
    assert.equal(partial.generation.result?.status, "partial");
    assert.equal(partial.generation.result?.recommendations.length, 1);
  });

  it("handles empty response correctly", () => {
    const ready = makeReadyState();
    const loading = startKitGeneration(ready).state;
    const empty = applyKitGenerationResponse(
      loading,
      makeValidKitPayload("empty"),
      200,
    );
    assert.equal(deriveFlowPhase(empty), "empty_recommendations");
    assert.equal(empty.generation.status, "empty");
    assert.equal(empty.generation.result?.recommendations.length, 0);
  });

  it("handles error response while preserving profile, city, and confirmed anchors for retry", () => {
    const ready = makeReadyState();
    const loading = startKitGeneration(ready).state;
    const failed = applyKitGenerationResponse(
      loading,
      {
        status: "error",
        output: null,
        error: { code: "deadline_exceeded", message: "Request deadline expired." },
      },
      504,
    );

    assert.equal(deriveFlowPhase(failed), "generation_error");
    assert.equal(failed.generation.status, "error");
    assert.equal(failed.city, "Berlin");
    assert.equal(failed.selectedPresetId, "custom");
    assert.equal(failed.anchors.length, 1);
    assert.equal(failed.anchors[0].status, "confirmed");
    assert.equal(
      failed.anchors[0].confirmedEntity?.entityId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    );
    // Can immediately retry without re-confirming
    assert.equal(canGenerateKit(failed), true);

    // Network/thrown error transition also preserves state and sanitizes error
    const netFailed = applyKitGenerationError(
      loading,
      new Error("Request aborted due to timeout"),
    );
    assert.equal(deriveFlowPhase(netFailed), "generation_error");
    assert.equal(netFailed.generation.status, "error");
    assert.equal(canGenerateKit(netFailed), true);
  });
});

// ── 10. Duplicate submissions prevented while request is active ──

describe("10. Duplicate submission prevention", () => {
  it("prevents concurrent submissions via startKitGeneration and createKitSubmissionController", async () => {
    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;
    state = applyAnchorLookupResult(state, anchorId, {
      status: "matches",
      resolutionStatus: "resolved",
      query: "Radiohead",
      requestedType: "urn:entity:artist",
      candidates: [
        {
          entityId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
          name: "Radiohead",
          types: ["urn:entity:artist"],
        },
      ],
    });
    state = confirmAnchorCandidate(
      state,
      anchorId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;

    let callCount = 0;
    let resolveRequest!: (val: { body: unknown; httpStatus: number }) => void;

    const controller = createKitSubmissionController(() => {
      callCount++;
      return new Promise((res) => {
        resolveRequest = res;
      });
    });

    const getState = () => state;
    const setState = (updater: (prev: FlowState) => FlowState) => {
      state = updater(state);
    };

    const p1 = controller.submit(getState, setState);
    assert.equal(controller.isSubmitting(), true);
    assert.equal(state.generation.status, "loading");

    // Attempt second and third submission while first is active
    const p2 = controller.submit(getState, setState);
    const secondStart = startKitGeneration(state);
    assert.equal(secondStart.ok, false);
    assert.equal(await p2, false);
    assert.equal(callCount, 1, "only one request must be sent while active");

    resolveRequest({
      httpStatus: 200,
      body: {
        status: "empty",
        output: {
          status: "empty",
          summary: "No verified recommendations for Berlin.",
          recommendations: [],
          totalRecommendations: 0,
          invalidIds: [],
        },
        meta: {
          runId: "r-1",
          city: "Berlin",
          anchorCount: 1,
          mode: "agent",
          cached: false,
          durationMs: 100,
        },
      },
    });

    assert.equal(await p1, true);
    assert.equal(controller.isSubmitting(), false);
    assert.equal(state.generation.status, "empty");
  });
});

// ── 11. Sensitive fields and raw internal errors not displayed ──

describe("11. Exclusion of sensitive fields, internal traces, and unverified text", () => {
  it("sanitizes credentials, tokens, and internal URLs from error messages", () => {
    assert.ok(!sanitizeUiError("Error: QLOO_API_KEY=abc123").includes("abc123"));
    assert.ok(!sanitizeUiError("Bearer eyJhbGciOi").includes("eyJhbGciOi"));
    assert.ok(
      !sanitizeUiError("GET https://hackathon.api.qloo.com/v2/insights 500").includes(
        "hackathon.api.qloo.com",
      ),
    );
  });

  it("strips internal trace, finalization, invalidIds, and unverified explanations from completion state", () => {
    const rawResponseWithInternalFields = {
      status: "success",
      trace: [{ id: 0, toolName: "discover_places", secret: "hidden" }],
      finalization: {
        summary: "98% confidence model summary!",
        recommendationIds: ["V-1"],
      },
      output: {
        status: "success",
        summary: "Found 1 recommendation in Berlin.",
        recommendations: [
          {
            entityId: "V-1",
            name: "Verified Cafe",
            label: "connection",
            categories: ["Cafe"],
            provenance: {
              queryMode: "single-anchor",
              anchorIds: ["R-1"],
              connectionProvenance: [
                { anchorId: "R-1", anchorName: "Radiohead", rank: 0, queryId: "anchor:R-1" },
              ],
              categoryEvidence: null,
            },
            details: {
              address: "Main St 1",
              neighborhood: "Mitte",
              website: "javascript:alert(1)",
              phone: null,
              priceLevel: null,
              location: { lat: 52.5, lon: 13.4 },
              mappable: true,
            },
            tags: [],
            explanation: {
              text: "Qloo's taste graph surfaced this place when asked about Radiohead.",
              basis: {
                label: "connection",
                hasSingleAnchorSource: true,
                hasBlendedSource: false,
                hasCategoryEvidence: false,
                hasVenueEvidence: true,
                anchorNames: ["Radiohead"],
                category: "Cafe",
              },
              verified: true,
              fallback: false,
            },
          },
          {
            entityId: "V-UNVERIFIED",
            name: "Unverified Place",
            label: "exploratory",
            categories: [],
            provenance: {
              queryMode: "blended",
              anchorIds: [],
              connectionProvenance: [],
              categoryEvidence: null,
            },
            details: {
              address: null,
              neighborhood: null,
              website: null,
              phone: null,
              priceLevel: null,
              location: null,
              mappable: false,
            },
            tags: [],
            explanation: {
              text: "Unverified model claim",
              basis: {
                label: "exploratory",
                hasSingleAnchorSource: false,
                hasBlendedSource: true,
                hasCategoryEvidence: false,
                hasVenueEvidence: false,
                anchorNames: [],
                category: null,
              },
              verified: false,
              fallback: false,
            },
          },
        ],
        totalRecommendations: 2,
        invalidIds: ["INVENTED-ID-1"],
      },
      meta: {
        runId: "run-1",
        city: "Berlin",
        anchorCount: 1,
        mode: "agent",
        cached: false,
        durationMs: 120,
        toolCallCount: 4,
        qlooOutboundRequests: 3,
      },
    };

    const parsed = parseSafeKitResponse(rawResponseWithInternalFields, 200);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("unreachable");

    const serialized = JSON.stringify(parsed.completion);
    assert.equal(serialized.includes("trace"), false);
    assert.equal(serialized.includes("finalization"), false);
    assert.equal(serialized.includes("98% confidence"), false);
    assert.equal(serialized.includes("INVENTED-ID-1"), false);
    assert.equal(serialized.includes("toolCallCount"), false);
    assert.equal(serialized.includes("qlooOutboundRequests"), false);
    assert.equal(serialized.includes("Unverified model claim"), false);
    assert.equal(parsed.completion.recommendations.length, 1);
    assert.equal(parsed.completion.recommendations[0].name, "Verified Cafe");
    assert.equal(parsed.completion.recommendations[0].website, null);
  });
});

// ── 12. Old /api/discover behavior is not broken ─────────────

describe("12. Backward compatibility — /api/discover and MUMBAI_NEWCOMER", () => {
  it("preserves MUMBAI_NEWCOMER demo profile and /api/discover POST export", () => {
    assert.equal(MUMBAI_NEWCOMER.city, "Berlin");
    assert.equal(MUMBAI_NEWCOMER.anchors.length, 5);
    assert.deepEqual(
      MUMBAI_NEWCOMER.anchors.map((a) => ({ query: a.query, type: a.type })),
      [
        { query: "Radiohead", type: "urn:entity:artist" },
        { query: "Asha Bhosle", type: "urn:entity:artist" },
        { query: "Prateek Kuhad", type: "urn:entity:artist" },
        { query: "Slumdog Millionaire", type: "urn:entity:movie" },
        { query: "The Office", type: "urn:entity:tv_show" },
      ],
    );
    assert.equal(typeof discoverRoutePost, "function");
  });
});
