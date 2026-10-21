import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  UNCATEGORIZED_GROUP_KEY,
  UNCATEGORIZED_GROUP_TITLE,
  addAnchor,
  applyAnchorLookupResult,
  applyKitGenerationError,
  applyKitGenerationResponse,
  buildKitRequestPayload,
  buildPracticalDetailsView,
  canGenerateKit,
  computeMapBounds,
  confirmAnchorCandidate,
  createInitialFlowState,
  deriveFlowPhase,
  describeCategoryEvidence,
  extractMapMarkers,
  formatPriceTier,
  formatRecommendationProvenance,
  getKitStatusPresentation,
  getLabelPresentation,
  groupRecommendationsByCategory,
  isMappableRecommendation,
  KIT_STATUS_PRESENTATION,
  parseSafeKitResponse,
  resolveSelectionState,
  selectCity,
  startKitGeneration,
} from "../lib/input";
import type { SafeRecommendationItem } from "../lib/input";
import {
  clearRateLimits,
  clearResponseCache,
  handleAnchorSearch,
  handleKitRequest,
  projectPublicTrace,
  PublicSearchProcessSchema,
} from "../lib/api";
import type { TraceEvent } from "../lib/agent";
import type { StructuredOutput, StructuredRecommendation } from "../lib/output";
import { SearchResponseSchema } from "../lib/qloo/schemas";
import type { SearchResponse } from "../lib/qloo/schemas";
import { MUMBAI_NEWCOMER } from "../lib/discover/demo-profile";
import { POST as discoverRoutePost } from "../app/api/discover/route";
import { AgentTraceDrawer } from "../components/agent-trace-drawer";

// ── Test fixtures ────────────────────────────────────────────

function makeSafeRec(
  overrides: Partial<SafeRecommendationItem> = {},
): SafeRecommendationItem {
  return {
    entityId: "V-1",
    name: "Heimathafen Neukölln",
    label: "connection",
    categories: ["Live Music Venue"],
    neighborhood: "Neukölln",
    address: "Karl-Marx-Straße 141",
    website: "https://heimathafen-neukoelln.de/",
    phone: "+49 30 56821333",
    priceLevel: 2,
    location: { lat: 52.4762, lon: 13.4395 },
    mappable: true,
    queryMode: "single-anchor",
    connectionProvenance: [
      {
        anchorId: "R-1",
        anchorName: "Radiohead",
        rank: 0,
        queryId: "anchor:R-1",
      },
    ],
    categoryEvidence: {
      requestedCategory: "live_music_venue",
      score: 2,
      position: 0,
      conflict: false,
    },
    tags: [
      {
        id: "urn:tag:category:place:live_music_venue",
        name: "Live Music Venue",
        type: "urn:tag:category:place",
      },
      {
        id: "urn:tag:genre:place:indie_rock",
        name: "Indie Rock",
        type: "urn:tag:genre:place",
      },
    ],
    explanationText:
      "Qloo's taste graph surfaced this place when asked about Radiohead.",
    explanationFallback: false,
    anchorNames: ["Radiohead"],
    ...overrides,
  };
}

function makeStructuredRec(
  overrides: Partial<StructuredRecommendation> = {},
): StructuredRecommendation {
  return {
    entityId: "V-1",
    name: "Heimathafen Neukölln",
    label: "connection",
    categories: ["Live Music Venue"],
    provenance: {
      queryMode: "single-anchor",
      anchorIds: ["R-1"],
      connectionProvenance: [
        {
          anchorId: "R-1",
          anchorName: "Radiohead",
          rank: 0,
          queryId: "anchor:R-1",
        },
      ],
      categoryEvidence: {
        requestedCategory: "live_music_venue",
        score: 2,
        position: 0,
        conflict: false,
      },
    },
    details: {
      address: "Karl-Marx-Straße 141",
      neighborhood: "Neukölln",
      website: "https://heimathafen-neukoelln.de",
      phone: "+49 30 56821333",
      priceLevel: 2,
      location: { lat: 52.4762, lon: 13.4395 },
      mappable: true,
    },
    tags: [
      {
        id: "urn:tag:category:place:live_music_venue",
        name: "Live Music Venue",
        type: "urn:tag:category:place",
      },
    ],
    explanation: {
      text: "Qloo's taste graph surfaced this place when asked about Radiohead.",
      basis: {
        label: "connection",
        hasSingleAnchorSource: true,
        hasBlendedSource: false,
        hasCategoryEvidence: true,
        hasVenueEvidence: true,
        anchorNames: ["Radiohead"],
        category: "Live Music Venue",
      },
      verified: true,
      fallback: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearRateLimits();
  clearResponseCache();
});

// ── 1. Rendering trusted structured results with each evidence label ──

describe("1. Evidence labels and grounded provenance distinction", () => {
  it("provides distinct badge text, non-color symbols, and descriptions for all 3 labels", () => {
    const conn = getLabelPresentation("connection");
    const useful = getLabelPresentation("useful-place");
    const expl = getLabelPresentation("exploratory");

    assert.equal(conn.badgeText, "Connection");
    assert.equal(useful.badgeText, "Useful place");
    assert.equal(expl.badgeText, "Exploratory");

    // Non-color symbols must all be distinct so labels never rely on color alone
    assert.notEqual(conn.symbol, useful.symbol);
    assert.notEqual(conn.symbol, expl.symbol);
    assert.notEqual(useful.symbol, expl.symbol);
  });

  it("formats connection provenance with exact anchor name, 1-based rank, and honesty disclaimer", () => {
    const rec = makeSafeRec({
      label: "connection",
      queryMode: "mixed",
      connectionProvenance: [
        {
          anchorId: "R-1",
          anchorName: "Radiohead",
          rank: 0,
          queryId: "anchor:R-1",
        },
        {
          anchorId: "AS-1",
          anchorName: "Arijit Singh",
          rank: 4,
          queryId: "anchor:AS-1",
        },
      ],
    });

    const prov = formatRecommendationProvenance(rec);
    assert.equal(prov.distinctionKind, "single-anchor-connection");
    assert.equal(
      prov.headline,
      "Single-anchor Qloo query: Radiohead (rank #1), Arijit Singh (rank #5)",
    );
    assert.equal(prov.alsoInBlendedQuery, true);
    assert.ok(prov.detail.includes("combined profile query"));
    assert.ok(
      prov.honestyDisclaimer?.includes("not proof of a real-world relationship"),
    );
    assert.ok(!prov.headline.includes("%"));
    assert.ok(!prov.detail.includes("confidence"));
  });

  it("formats useful-place provenance with category evidence and no single-anchor claim", () => {
    const rec = makeSafeRec({
      label: "useful-place",
      queryMode: "blended",
      connectionProvenance: [],
      categoryEvidence: {
        requestedCategory: "book_store",
        score: 2,
        position: 0,
        conflict: false,
      },
    });

    const prov = formatRecommendationProvenance(rec);
    assert.equal(prov.distinctionKind, "category-verified");
    assert.equal(
      prov.headline,
      "Validated book store category match (blended taste-profile query)",
    );
    assert.equal(prov.anchorAttributions.length, 0);
    assert.equal(
      prov.categoryMatchLabel,
      'Validated for "book store" (primary category tag)',
    );
    assert.ok(prov.detail.includes("Not attributed to a single cultural anchor"));
  });

  it("distinguishes source-supplied Qloo category tags from deterministically validated category evidence", () => {
    // Case A: Broad query (no category filter) — entity has Qloo category tags, but categoryEvidence is null
    const broadRec = makeSafeRec({
      categories: ["Event Venue", "Live Music Venue"],
      categoryEvidence: null,
    });
    const broadCat = describeCategoryEvidence(broadRec);
    assert.deepEqual(broadCat.qlooCategories, [
      "Event Venue",
      "Live Music Venue",
    ]);
    assert.equal(broadCat.qlooCategoryLabel, "Qloo categories");
    assert.equal(broadCat.hasValidatedCategory, false);
    assert.equal(broadCat.validatedCategory, null);
    assert.equal(broadCat.displayGroupTitle, "Event Venue");
    assert.equal(broadCat.isUncategorized, false);
    assert.equal(formatRecommendationProvenance(broadRec).categoryMatchLabel, null);

    // Case B: Category-filtered query where only live_music_venue was validated (score 1, position 1, no conflict)
    const validatedRec = makeSafeRec({
      categories: ["Event Venue", "Live Music Venue"],
      categoryEvidence: {
        requestedCategory: "live_music_venue",
        score: 1,
        position: 1,
        conflict: false,
      },
    });
    const validatedCat = describeCategoryEvidence(validatedRec);
    assert.deepEqual(validatedCat.qlooCategories, [
      "Event Venue",
      "Live Music Venue",
    ]);
    assert.equal(validatedCat.qlooCategoryLabel, "Qloo categories");
    assert.equal(validatedCat.hasValidatedCategory, true);
    assert.equal(validatedCat.validatedCategory, "live music venue");
    assert.equal(
      formatRecommendationProvenance(validatedRec).categoryMatchLabel,
      'Validated for "live music venue" (secondary category tag)',
    );

    // Case C: Weak/conflicting category evidence (score 0 or conflict=true) is never treated as a validated category
    const unvalidatedScoreZero = makeSafeRec({
      categories: ["Night Club", "Bar", "Live Music Venue"],
      categoryEvidence: {
        requestedCategory: "live_music_venue",
        score: 0,
        position: 2,
        conflict: false,
      },
    });
    assert.equal(describeCategoryEvidence(unvalidatedScoreZero).hasValidatedCategory, false);
    assert.equal(describeCategoryEvidence(unvalidatedScoreZero).validatedCategory, null);
    assert.equal(
      formatRecommendationProvenance(unvalidatedScoreZero).categoryMatchLabel,
      null,
    );
  });

  it("provides truthful kit status labels and scope notes that do not overstate verification", () => {
    const successPres = getKitStatusPresentation("success");
    const partialPres = getKitStatusPresentation("partial");
    const emptyPres = getKitStatusPresentation("empty");

    assert.equal(successPres.badgeText, "Starter Kit Ready");
    assert.equal(partialPres.badgeText, "Partial Starter Kit");
    assert.equal(emptyPres.badgeText, "No Qualifying Matches");

    // Must not claim "Verified Starter Kit" or that operating hours / real-world affiliations are verified
    assert.equal(
      Object.values(KIT_STATUS_PRESENTATION).some((s) =>
        s.badgeText.includes("Verified"),
      ),
      false,
    );

    // Must accurately describe general screening checks (accommodation, transit, closed, duplicate listings)
    assert.ok(
      successPres.scopeNote.includes(
        "excluding flagged accommodation, transit, closed, and duplicate listings",
      ),
    );
    // Must not claim that general screening unconditionally excludes category conflicts across all queries
    assert.equal(
      successPres.scopeNote.includes("closed listings, and category conflicts"),
      false,
    );
    // Must explain that category-conflict checks apply only when category evidence was explicitly evaluated
    assert.ok(
      successPres.scopeNote.includes(
        "Category-conflict checks apply only to recommendations for which category evidence was explicitly evaluated",
      ),
    );
    // Must not imply that all Qloo category tags are independently validated
    assert.ok(
      successPres.scopeNote.includes(
        "Qloo category tags are not all independently validated",
      ),
    );
    assert.ok(
      successPres.scopeNote.includes(
        "does not independently verify current operating status, hours, or real-world affiliations",
      ),
    );
  });

  it("distinguishes blended-profile exploratory results from broad single-anchor exploratory results", () => {
    const blendedExpl = makeSafeRec({
      label: "exploratory",
      queryMode: "blended",
      connectionProvenance: [],
      categoryEvidence: null,
    });
    const blendedProv = formatRecommendationProvenance(blendedExpl);
    assert.equal(blendedProv.distinctionKind, "blended-profile");
    assert.equal(blendedProv.headline, "Blended taste-profile query result");
    assert.ok(blendedProv.detail.includes("combined confirmed anchors"));

    const broadExpl = makeSafeRec({
      label: "exploratory",
      queryMode: "single-anchor",
      connectionProvenance: [],
      categoryEvidence: null,
    });
    const broadProv = formatRecommendationProvenance(broadExpl);
    assert.equal(broadProv.distinctionKind, "exploratory-broad");
    assert.equal(broadProv.headline, "Exploratory taste-query suggestion");
    assert.ok(broadProv.detail.includes("top-10 single-anchor connection threshold"));
  });
});

// ── 2. Category grouping without duplicating entity records ──

describe("2. Category grouping without duplicating entity records", () => {
  it("groups by primary validated category and never duplicates multi-category entities", () => {
    const multiCat = makeSafeRec({
      entityId: "V-MULTI",
      name: "Huxleys Neue Welt",
      categories: ["Event Venue", "Live Music Venue", "Concert Hall"],
    });
    const secondEventVenue = makeSafeRec({
      entityId: "V-EVENT-2",
      name: "Tempodrom",
      categories: ["event venue"],
    });
    const bookStore = makeSafeRec({
      entityId: "V-BOOK",
      name: "Dussmann das KulturKaufhaus",
      categories: ["Book Store"],
    });
    const uncategorized = makeSafeRec({
      entityId: "V-UNCAT",
      name: "Mitte Cultural Space",
      categories: [],
    });

    const groups = groupRecommendationsByCategory([
      multiCat,
      secondEventVenue,
      bookStore,
      uncategorized,
    ]);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].title, "Event Venue");
    assert.equal(groups[0].isUncategorized, false);
    assert.deepEqual(
      groups[0].items.map((i) => i.entityId),
      ["V-MULTI", "V-EVENT-2"],
    );
    // Secondary categories are preserved on the entity itself
    assert.deepEqual(groups[0].items[0].categories, [
      "Event Venue",
      "Live Music Venue",
      "Concert Hall",
    ]);

    assert.equal(groups[1].title, "Book Store");
    assert.deepEqual(
      groups[1].items.map((i) => i.entityId),
      ["V-BOOK"],
    );

    // Uncategorized group is placed last without inventing a fake category
    assert.equal(groups[2].key, UNCATEGORIZED_GROUP_KEY);
    assert.equal(groups[2].title, UNCATEGORIZED_GROUP_TITLE);
    assert.equal(groups[2].isUncategorized, true);
    assert.deepEqual(
      groups[2].items.map((i) => i.entityId),
      ["V-UNCAT"],
    );

    // Total items across all groups equals unique entity count (4)
    const allGroupedIds = groups.flatMap((g) => g.items.map((i) => i.entityId));
    assert.deepEqual(allGroupedIds, [
      "V-MULTI",
      "V-EVENT-2",
      "V-BOOK",
      "V-UNCAT",
    ]);
  });

  it("deduplicates if the same entityId is passed more than once", () => {
    const rec1 = makeSafeRec({ entityId: "V-DUP", categories: ["Cafe"] });
    const rec2 = makeSafeRec({ entityId: "V-DUP", categories: ["Restaurant"] });

    const groups = groupRecommendationsByCategory([rec1, rec2]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 1);
    assert.equal(groups[0].items[0].entityId, "V-DUP");
  });
});

// ── 3. Unknown/missing place details without fabricated values ──

describe("3. Unknown/missing place details without fabricated values", () => {
  it("explicitly identifies unavailable details and never fabricates values", () => {
    const minimal = makeSafeRec({
      entityId: "V-MIN",
      name: "Minimal Venue",
      neighborhood: null,
      address: null,
      website: null,
      phone: null,
      priceLevel: null,
      location: null,
      mappable: false,
      tags: [],
    });

    const view = buildPracticalDetailsView(minimal);
    assert.equal(view.neighborhood, null);
    assert.equal(view.address, null);
    assert.equal(view.locationLine, null);
    assert.equal(view.websiteUrl, null);
    assert.equal(view.websiteDisplay, null);
    assert.equal(view.phone, null);
    assert.equal(view.priceTier, null);
    assert.equal(view.mappable, false);
    assert.equal(view.coordinates, null);
    assert.equal(view.hasAnyPracticalDetail, false);
    assert.deepEqual(view.unavailableFields, [
      "Address & neighborhood",
      "Website",
      "Phone",
      "Price level",
      "Opening hours",
      "Ratings",
      "Map coordinates",
    ]);
  });

  it("formats valid practical details and keeps opening hours & ratings marked unavailable", () => {
    const rich = makeSafeRec({
      neighborhood: "Kreuzberg",
      address: "Oranienstraße 190",
      website: "https://www.so36.com/programm/",
      phone: "+49 30 61401306",
      priceLevel: 3,
      location: { lat: 52.5005, lon: 13.4222 },
      mappable: true,
      categories: ["Live Music Venue"],
      tags: [
        {
          id: "urn:tag:category:place:live_music_venue",
          name: "Live Music Venue",
          type: "urn:tag:category:place",
        },
        {
          id: "urn:tag:genre:place:punk",
          name: "Punk",
          type: "urn:tag:genre:place",
        },
      ],
    });

    const view = buildPracticalDetailsView(rich);
    assert.equal(view.locationLine, "Kreuzberg · Oranienstraße 190");
    assert.equal(view.websiteUrl, "https://www.so36.com/programm/");
    assert.equal(view.websiteDisplay, "so36.com/programm");
    assert.equal(view.phone, "+49 30 61401306");
    assert.equal(view.priceTier, "$$$");
    assert.equal(view.mappable, true);
    assert.deepEqual(view.supportingTags, ["Punk"]);
    assert.deepEqual(view.unavailableFields, ["Opening hours", "Ratings"]);
  });

  it("rejects non-http/https websites and invalid price levels", () => {
    assert.equal(formatPriceTier(null), null);
    assert.equal(formatPriceTier(0), null);
    assert.equal(formatPriceTier(-2), null);
    assert.equal(formatPriceTier(NaN), null);
    assert.equal(formatPriceTier(1), "$");
    assert.equal(formatPriceTier(4), "$$$$");
    assert.equal(formatPriceTier(9), "$$$$");

    const unsafeSite = makeSafeRec({ website: "javascript:alert(1)" });
    assert.equal(buildPracticalDetailsView(unsafeSite).websiteUrl, null);
  });
});

// ── 4. Non-mappable places remaining in the list ──────────────

describe("4. Non-mappable places remaining in the list", () => {
  it("keeps non-mappable recommendations in the completion list and category groups", () => {
    const mappableRec = makeStructuredRec({
      entityId: "V-MAP",
      name: "Mapped Bookshop",
      categories: ["Book Store"],
      details: {
        address: "Friedrichstraße 90",
        neighborhood: "Mitte",
        website: null,
        phone: null,
        priceLevel: null,
        location: { lat: 52.518, lon: 13.388 },
        mappable: true,
      },
    });
    const unmappableRec = makeStructuredRec({
      entityId: "V-NOMAP",
      name: "Unmapped Bookshop",
      categories: ["Book Store"],
      details: {
        address: null,
        neighborhood: "Prenzlauer Berg",
        website: null,
        phone: null,
        priceLevel: null,
        location: null,
        mappable: false,
      },
    });

    const parsed = parseSafeKitResponse(
      {
        status: "success",
        output: {
          status: "success",
          summary: "Found 2 recommendations in Berlin.",
          recommendations: [mappableRec, unmappableRec],
          totalRecommendations: 2,
          invalidIds: [],
        },
        meta: {
          runId: "r-1",
          city: "Berlin",
          anchorCount: 1,
          mode: "agent",
          cached: false,
          durationMs: 120,
        },
      },
      200,
    );

    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("Expected ok");

    // Both places remain in completion.recommendations and category groups
    assert.equal(parsed.completion.recommendations.length, 2);
    assert.deepEqual(
      parsed.completion.recommendations.map((r) => ({
        id: r.entityId,
        mappable: r.mappable,
      })),
      [
        { id: "V-MAP", mappable: true },
        { id: "V-NOMAP", mappable: false },
      ],
    );

    const groups = groupRecommendationsByCategory(
      parsed.completion.recommendations,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 2);

    // Only the mappable place gets a map marker
    const markers = extractMapMarkers(parsed.completion.recommendations);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].entityId, "V-MAP");
  });
});

// ── 5. Invalid coordinates never producing map markers ────────

describe("5. Invalid coordinates never produce map markers", () => {
  it("excludes null, NaN, Infinity, out-of-range coordinates, and mappable=false", () => {
    const candidates: SafeRecommendationItem[] = [
      makeSafeRec({
        entityId: "BAD-NULL",
        location: null,
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-NAN-LAT",
        location: { lat: NaN, lon: 13.4 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-NAN-LON",
        location: { lat: 52.5, lon: NaN },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-INF",
        location: { lat: Infinity, lon: 13.4 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-LAT-HIGH",
        location: { lat: 90.001, lon: 13.4 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-LAT-LOW",
        location: { lat: -91, lon: 13.4 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-LON-HIGH",
        location: { lat: 52.5, lon: 180.5 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-LON-LOW",
        location: { lat: 52.5, lon: -181 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "BAD-FLAG-FALSE",
        location: { lat: 52.5, lon: 13.4 },
        mappable: false,
      }),
      makeSafeRec({
        entityId: "VALID-1",
        name: "Valid Place",
        location: { lat: 52.52, lon: 13.405 },
        mappable: true,
      }),
    ];

    for (const c of candidates.slice(0, -1)) {
      assert.equal(
        isMappableRecommendation(c),
        false,
        `${c.entityId} must not be mappable`,
      );
    }
    assert.equal(isMappableRecommendation(candidates[candidates.length - 1]), true);

    const markers = extractMapMarkers(candidates);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].entityId, "VALID-1");
    assert.equal(markers[0].orderIndex, 1);
    assert.equal(markers[0].lat, 52.52);
    assert.equal(markers[0].lon, 13.405);
  });

  it("computes empty, single-point, and multi-point bounds accurately", () => {
    assert.deepEqual(computeMapBounds([]), { mode: "empty" });

    const single = extractMapMarkers([
      makeSafeRec({
        entityId: "V-1",
        location: { lat: 43.6532, lon: -79.3832 },
        mappable: true,
      }),
    ]);
    assert.deepEqual(computeMapBounds(single), {
      mode: "single",
      center: { lat: 43.6532, lon: -79.3832 },
      zoom: 14,
    });

    const multi = extractMapMarkers([
      makeSafeRec({
        entityId: "V-1",
        location: { lat: 52.48, lon: 13.42 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "V-2",
        location: { lat: 52.54, lon: 13.38 },
        mappable: true,
      }),
    ]);
    assert.deepEqual(computeMapBounds(multi), {
      mode: "bounds",
      southWest: { lat: 52.48, lon: 13.38 },
      northEast: { lat: 52.54, lon: 13.42 },
    });
  });
});

// ── 6. Map selection and list selection using the same entity identity ──

describe("6. Synchronized map and list selection by entityId", () => {
  it("resolves the exact same entityId across list cards and map markers", () => {
    const recs: SafeRecommendationItem[] = [
      makeSafeRec({
        entityId: "ENT-MAPPED-1",
        name: "Tempodrom",
        location: { lat: 52.5015, lon: 13.3815 },
        mappable: true,
      }),
      makeSafeRec({
        entityId: "ENT-UNMAPPED-2",
        name: "Unmapped Cafe",
        location: null,
        mappable: false,
      }),
      makeSafeRec({
        entityId: "ENT-MAPPED-3",
        name: "SO36",
        location: { lat: 52.5005, lon: 13.4222 },
        mappable: true,
      }),
    ];

    // Selecting mapped item #3 from either list or map pin
    const selMapped = resolveSelectionState(recs, "ENT-MAPPED-3");
    assert.equal(selMapped.selectedEntityId, "ENT-MAPPED-3");
    assert.equal(selMapped.selectedRecommendation?.entityId, "ENT-MAPPED-3");
    assert.equal(selMapped.selectedMarker?.entityId, "ENT-MAPPED-3");
    assert.equal(selMapped.selectedMarker?.orderIndex, 2);
    assert.equal(selMapped.selectedIsMappable, true);

    // Selecting unmapped item #2 from list identifies the card without a map marker
    const selUnmapped = resolveSelectionState(recs, "ENT-UNMAPPED-2");
    assert.equal(selUnmapped.selectedEntityId, "ENT-UNMAPPED-2");
    assert.equal(selUnmapped.selectedRecommendation?.entityId, "ENT-UNMAPPED-2");
    assert.equal(selUnmapped.selectedMarker, null);
    assert.equal(selUnmapped.selectedIsMappable, false);

    // Selecting unknown ID resets cleanly
    const selUnknown = resolveSelectionState(recs, "NON-EXISTENT");
    assert.equal(selUnknown.selectedEntityId, null);
    assert.equal(selUnknown.selectedRecommendation, null);
    assert.equal(selUnknown.selectedMarker, null);
  });
});

// ── 7. Empty, partial, and successful results ─────────────────

describe("7. Empty, partial, and successful results end-to-end", () => {
  it("distinguishes success, partial (filtered invalidIds), and genuine empty results", async () => {
    const req = {
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    };

    // 7a. Success
    const { response: successRes, httpStatus: sStatus } = await handleKitRequest(
      req,
      "client-7a",
      {
        runAgent: async () => ({
          runId: "run-7a",
          status: "completed",
          finalization: {
            summary: "Done",
            recommendationIds: ["V-1"],
            recommendationCount: 1,
          },
          output: {
            status: "success",
            summary: "Found 1 recommendation in Berlin.",
            recommendations: [makeStructuredRec()],
            totalRecommendations: 1,
            invalidIds: [],
          },
          trace: [],
          toolCallCount: 2,
          qlooOutboundRequests: 2,
          qlooCacheHits: 0,
          totalDurationMs: 180,
        }),
      },
    );
    assert.equal(sStatus, 200);
    const parsedSuccess = parseSafeKitResponse(successRes, sStatus);
    assert.equal(parsedSuccess.ok, true);
    if (parsedSuccess.ok) {
      assert.equal(parsedSuccess.completion.status, "success");
      assert.equal(parsedSuccess.completion.filteredInvalidCount, 0);
      assert.equal(parsedSuccess.completion.recommendations.length, 1);
      assert.equal(parsedSuccess.completion.searchProcess.outcome, "completed");
    }

    clearResponseCache();

    // 7b. Partial (some unverified IDs filtered out)
    const { response: partialRes, httpStatus: pStatus } = await handleKitRequest(
      req,
      "client-7b",
      {
        runAgent: async () => ({
          runId: "run-7b",
          status: "completed",
          finalization: {
            summary: "Done",
            recommendationIds: ["V-1"],
            recommendationCount: 1,
          },
          output: {
            status: "partial",
            summary: "Found 1 recommendation in Berlin. 2 could not be verified.",
            recommendations: [makeStructuredRec()],
            totalRecommendations: 1,
            invalidIds: ["INVENTED-A", "INVENTED-B"],
          },
          trace: [],
          toolCallCount: 2,
          qlooOutboundRequests: 2,
          qlooCacheHits: 0,
          totalDurationMs: 210,
        }),
      },
    );
    assert.equal(pStatus, 200);
    const parsedPartial = parseSafeKitResponse(partialRes, pStatus);
    assert.equal(parsedPartial.ok, true);
    if (parsedPartial.ok) {
      assert.equal(parsedPartial.completion.status, "partial");
      assert.equal(parsedPartial.completion.filteredInvalidCount, 2);
      assert.equal(parsedPartial.completion.recommendations.length, 1);
      assert.equal(parsedPartial.completion.searchProcess.outcome, "partial");
      // Raw invalid IDs must never appear in SafeKitCompletion
      assert.equal(
        JSON.stringify(parsedPartial.completion).includes("INVENTED-A"),
        false,
      );
    }

    clearResponseCache();

    // 7c. Genuine empty
    const { response: emptyRes, httpStatus: eStatus } = await handleKitRequest(
      req,
      "client-7c",
      {
        runAgent: async () => ({
          runId: "run-7c",
          status: "completed",
          finalization: {
            summary: "None",
            recommendationIds: [],
            recommendationCount: 0,
          },
          output: {
            status: "empty",
            summary: "No verified recommendations for Berlin.",
            recommendations: [],
            totalRecommendations: 0,
            invalidIds: [],
          },
          trace: [],
          toolCallCount: 2,
          qlooOutboundRequests: 2,
          qlooCacheHits: 0,
          totalDurationMs: 140,
        }),
      },
    );
    assert.equal(eStatus, 200);
    const parsedEmpty = parseSafeKitResponse(emptyRes, eStatus);
    assert.equal(parsedEmpty.ok, true);
    if (parsedEmpty.ok) {
      assert.equal(parsedEmpty.completion.status, "empty");
      assert.equal(parsedEmpty.completion.recommendations.length, 0);
      assert.equal(parsedEmpty.completion.searchProcess.outcome, "empty");
    }
  });
});

// ── 8. Agent versus deterministic fallback mode ───────────────

describe("8. Agent-assisted versus deterministic fallback mode", () => {
  it("clearly distinguishes agent mode from deterministic fallback in completion and searchProcess", async () => {
    const req = {
      city: "Berlin",
      anchors: [{ query: "Radiohead", type: "urn:entity:artist" }],
    };

    // Agent mode
    const { response: agentRes } = await handleKitRequest(req, "c-agent", {
      runAgent: async () => ({
        runId: "run-agent",
        status: "completed",
        finalization: {
          summary: "Done",
          recommendationIds: ["V-1"],
          recommendationCount: 1,
        },
        output: {
          status: "success",
          summary: "Found 1 recommendation in Berlin.",
          recommendations: [makeStructuredRec()],
          totalRecommendations: 1,
          invalidIds: [],
        },
        trace: [
          {
            id: 0,
            timestamp: new Date().toISOString(),
            durationMs: 40,
            type: "tool_dispatch",
            toolName: "discover_places",
            toolInput: { anchor_ids: ["R-1"], city: "Berlin" },
            status: "success",
            acceptedCount: 1,
            reviewCount: 0,
            rejectedCount: 1,
            rejectedReasons: { hotel_accommodation: 1 },
            qlooRequestsMade: 2,
            qlooCacheHits: 0,
            fallbackUsed: false,
          },
        ],
        toolCallCount: 1,
        qlooOutboundRequests: 2,
        qlooCacheHits: 0,
        totalDurationMs: 150,
      }),
    });

    assert.equal(agentRes.meta.mode, "agent");
    assert.equal(agentRes.searchProcess?.mode, "agent");
    assert.equal(
      agentRes.searchProcess?.modeLabel,
      "Agent-assisted discovery (Bedrock + Qloo)",
    );
    assert.equal(agentRes.searchProcess?.fallbackTriggered, false);

    clearResponseCache();

    // Deterministic fallback mode (agent throws / Bedrock unavailable)
    const { response: detRes } = await handleKitRequest(req, "c-det", {
      runAgent: async () => {
        throw new Error("Bedrock service unavailable");
      },
      searchEntity: async (query) => ({
        data: {
          results: [
            {
              name: query,
              entity_id: "E-Radiohead",
              types: ["urn:entity:artist"],
            },
          ],
        },
        meta: { path: "/search", params: { query }, cached: false },
      }),
      discover: async (input) => ({
        city: input.city,
        accepted: [
          {
            entityId: "V-DET",
            name: "Deterministic Venue",
            entity: {
              entity_id: "V-DET",
              name: "Deterministic Venue",
              tags: [
                {
                  id: "urn:tag:category:place:book_store",
                  name: "Book Store",
                  type: "urn:tag:category:place",
                },
              ],
              properties: { address: "Torstraße 10", neighborhood: "Mitte" },
              location: { lat: 52.528, lon: 13.401 },
            },
            validation: {
              entityId: "V-DET",
              name: "Deterministic Venue",
              verdict: "accepted",
              mappable: true,
            },
            sources: [
              {
                queryId: "anchor:E-Radiohead",
                queryType: "single-anchor",
                anchorId: "E-Radiohead",
                anchorName: "Radiohead",
                city: "Berlin",
                rank: 1,
              },
            ],
          },
        ],
        review: [],
        rejected: [
          {
            entityId: "H-1",
            name: "Hotel Berlin",
            entity: { entity_id: "H-1", name: "Hotel Berlin" },
            validation: {
              entityId: "H-1",
              name: "Hotel Berlin",
              verdict: "rejected",
              reason: "hotel_accommodation",
              mappable: true,
            },
            sources: [],
          },
        ],
        failures: [],
        budget: { queriesUsed: 2, queriesBudget: 2, totalResults: 2 },
      }),
    });

    assert.equal(detRes.meta.mode, "deterministic");
    assert.equal(detRes.searchProcess?.mode, "deterministic");
    assert.equal(
      detRes.searchProcess?.modeLabel,
      "Deterministic Qloo discovery (fallback mode)",
    );
    assert.equal(detRes.searchProcess?.fallbackTriggered, true);
    assert.equal(detRes.searchProcess?.fallbackRecovered, true);
    assert.ok(detRes.searchProcess?.fallbackReason?.includes("deterministic"));
    assert.equal(detRes.searchProcess?.totals.accepted, 1);
    assert.equal(detRes.searchProcess?.totals.rejected, 1);
    assert.deepEqual(detRes.searchProcess?.totals.rejectedReasons, {
      hotel_accommodation: 1,
    });
  });

  it("handles deterministic timeout, upstream error, and client fallback synthesis without false zero-anchor messages", () => {
    const timeoutProc = projectPublicTrace({
      city: "Berlin",
      mode: "deterministic",
      cached: false,
      durationMs: 28000,
      outcome: "timeout",
      anchorCount: 2,
    });
    assert.equal(timeoutProc.outcome, "timeout");
    assert.equal(timeoutProc.steps[0].status, "failed");
    assert.ok(timeoutProc.steps[0].title.includes("timed out"));
    assert.equal(
      timeoutProc.steps[0].detail.includes("No anchors could be resolved"),
      false,
    );

    const errProc = projectPublicTrace({
      city: "Berlin",
      mode: "deterministic",
      cached: false,
      durationMs: 400,
      outcome: "error",
      anchorCount: 2,
    });
    assert.equal(errProc.outcome, "error");
    assert.equal(errProc.steps[0].status, "failed");
    assert.equal(
      errProc.steps[0].detail.includes("No anchors could be resolved"),
      false,
    );

    // Client fallback synthesis when searchProcess is omitted on a deterministic response
    const parsed = parseSafeKitResponse(
      {
        status: "success",
        output: {
          status: "success",
          summary: "Found 1 recommendation in Berlin.",
          recommendations: [makeStructuredRec()],
          totalRecommendations: 1,
          invalidIds: [],
        },
        meta: {
          runId: "r-det-synth",
          city: "Berlin",
          anchorCount: 2,
          mode: "deterministic",
          cached: false,
          durationMs: 190,
        },
      },
      200,
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.completion.searchProcess.mode, "deterministic");
      assert.equal(parsed.completion.searchProcess.fallbackRecovered, true);
      assert.equal(parsed.completion.searchProcess.totals.accepted, 1);
      assert.equal(
        parsed.completion.searchProcess.steps[0].detail.includes(
          "No anchors could be resolved",
        ),
        false,
      );
    }

    // Preserves valid searchProcess containing normal parenthetical text like "That Show (2005)"
    const validProcWithParens = projectPublicTrace({
      city: "Berlin",
      mode: "agent",
      cached: false,
      durationMs: 120,
      outcome: "completed",
      verifiedAnchors: [{ name: "Live at Pompeii (Film)" }],
    });
    const parsedWithParens = parseSafeKitResponse(
      {
        status: "success",
        output: {
          status: "success",
          summary: "Found 1 recommendation in Berlin.",
          recommendations: [makeStructuredRec()],
          totalRecommendations: 1,
          invalidIds: [],
        },
        meta: {
          runId: "r-parens",
          city: "Berlin",
          anchorCount: 1,
          mode: "agent",
          cached: false,
          durationMs: 120,
        },
        searchProcess: validProcWithParens,
      },
      200,
    );
    assert.equal(parsedWithParens.ok, true);
    if (parsedWithParens.ok) {
      assert.equal(parsedWithParens.completion.searchProcess.steps.length, 1);
      assert.ok(
        parsedWithParens.completion.searchProcess.steps[0].detail.includes(
          "Live at Pompeii (Film)",
        ),
      );
    }
  });
});

// ── 9. Trace projection removes secrets, raw summaries, raw arguments, and upstream errors ──

describe("9. Trace projection security & allowlist guarantees", () => {
  it("strips secrets, raw model summaries, arbitrary toolInput keys, and raw upstream errors", () => {
    const pollutedEvents: TraceEvent[] = [
      {
        id: 0,
        timestamp: "2026-10-21T10:00:00Z",
        durationMs: 120,
        type: "model_call",
        inputTokens: 500,
        outputTokens: 120,
        stopReason: "tool_use",
        status: "execution_error",
        detail:
          "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY Bedrock 500 at converse()",
        fallbackUsed: false,
      },
      {
        id: 1,
        timestamp: "2026-10-21T10:00:01Z",
        durationMs: 85,
        type: "tool_dispatch",
        toolName: "resolve_anchor",
        toolInput: {
          query: "Radiohead",
          type: "urn:entity:artist",
          apiKey: "sk-qloo-secret-key-999",
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9",
          nestedArbitraryPayload: { rawUpstreamHeader: "X-Api-Key: secret123" },
        },
        status: "success",
        qlooRequestsMade: 1,
        qlooCacheHits: 0,
        fallbackUsed: false,
      },
      {
        id: 2,
        timestamp: "2026-10-21T10:00:02Z",
        durationMs: 140,
        type: "tool_dispatch",
        toolName: "discover_places",
        toolInput: {
          anchor_ids: ["R-1"],
          city: "Berlin",
          unrestrictedArg: "password=supersecret",
        },
        status: "execution_error",
        detail:
          "GET https://hackathon.api.qloo.com/v2/insights?x-api-key=qloo_api_key_leak 503 Service Unavailable",
        fallbackUsed: false,
      },
      {
        id: 3,
        timestamp: "2026-10-21T10:00:03Z",
        durationMs: 15,
        type: "tool_dispatch",
        toolName: "finalize",
        toolInput: {
          summary:
            "Here are my 98% confidence recommendations personally endorsed by Radiohead!",
          recommendation_ids: ["V-1", "INVENTED-999"],
        },
        status: "success",
        fallbackUsed: false,
      },
    ];

    const projected = projectPublicTrace(pollutedEvents, {
      city: "Berlin",
      mode: "agent",
      cached: false,
      durationMs: 360,
      outcome: "completed",
    });

    const schemaCheck = PublicSearchProcessSchema.safeParse(projected);
    assert.equal(schemaCheck.success, true);

    const json = JSON.stringify(projected);
    const html = renderToStaticMarkup(
      createElement(AgentTraceDrawer, {
        process: projected,
        isOpen: true,
        onToggle: () => {},
      }),
    );

    for (const target of [json, html]) {
      assert.equal(target.includes("wJalrXUtnFEMI"), false, "no AWS secret");
      assert.equal(target.includes("AWS_SECRET_ACCESS_KEY"), false);
      assert.equal(target.includes("sk-qloo-secret-key-999"), false, "no Qloo key");
      assert.equal(target.includes("eyJhbGciOiJIUzI1NiJ9"), false, "no Bearer token");
      assert.equal(target.includes("nestedArbitraryPayload"), false, "no arbitrary tool args");
      assert.equal(target.includes("rawUpstreamHeader"), false);
      assert.equal(target.includes("unrestrictedArg"), false);
      assert.equal(target.includes("supersecret"), false);
      assert.equal(target.includes("hackathon.api.qloo.com"), false, "no upstream URL");
      assert.equal(target.includes("qloo_api_key_leak"), false);
      assert.equal(target.includes("503 Service Unavailable"), false, "no raw upstream error");
      assert.equal(target.includes("98% confidence"), false, "no raw model summary");
      assert.equal(target.includes("personally endorsed"), false);
      assert.equal(target.includes("INVENTED-999"), false, "no raw finalize IDs");
      assert.equal(target.includes("inputTokens"), false, "no token counters");
      assert.equal(target.includes("toolCallCount"), false);
      assert.equal(target.includes("qlooOutboundRequests"), false);
      assert.equal(target.includes("finalization"), false);
    }
  });
});

// ── 10. Fallback and rejected-candidate trace events displayed accurately ──

describe("10. Fallback stages, repeated calls, and rejected-candidate counts in trace", () => {
  it("preserves repeated attempts distinctly and renders fallback recovery + rejection reasons", () => {
    const traceEvents: TraceEvent[] = [
      {
        id: 0,
        timestamp: "2026-10-21T10:00:00Z",
        durationMs: 45,
        type: "tool_dispatch",
        toolName: "resolve_anchor",
        toolInput: { query: "Radiohead", type: "urn:entity:artist" },
        status: "success",
        qlooRequestsMade: 1,
        qlooCacheHits: 0,
        fallbackUsed: false,
      },
      {
        id: 1,
        timestamp: "2026-10-21T10:00:01Z",
        durationMs: 30,
        type: "tool_dispatch",
        toolName: "resolve_anchor",
        toolInput: { query: "Radiohead", type: "urn:entity:artist" },
        status: "success",
        qlooRequestsMade: 1,
        qlooCacheHits: 1,
        fallbackUsed: false,
      },
      {
        id: 2,
        timestamp: "2026-10-21T10:00:02Z",
        durationMs: 110,
        type: "tool_dispatch",
        toolName: "discover_places",
        toolInput: {
          anchor_ids: ["R-1", "Z-1"],
          city: "Berlin",
          category_tag_id: "urn:tag:category:place:coffee",
        },
        status: "success",
        acceptedCount: 0,
        reviewCount: 1,
        rejectedCount: 3,
        rejectedReasons: {
          hotel_accommodation: 2,
          closed: 1,
        },
        qlooRequestsMade: 4,
        qlooCacheHits: 1,
        fallbackUsed: false,
      },
      {
        id: 3,
        timestamp: "2026-10-21T10:00:02Z",
        durationMs: 0,
        type: "fallback",
        status: "fallback_triggered",
        fallbackUsed: true,
        fallbackReason: "Discovery returned 0 accepted results",
        originalTagId: "urn:tag:category:place:coffee",
        anchorIdsUsed: ["R-1", "Z-1"],
      },
      {
        id: 4,
        timestamp: "2026-10-21T10:00:02Z",
        durationMs: 0,
        type: "fallback",
        status: "fallback_skipped",
        fallbackUsed: true,
        fallbackStage: "alt_tag",
        fallbackReason: "Known empty tag: urn:tag:category:place:coffee",
        originalTagId: "urn:tag:category:place:coffee",
      },
      {
        id: 5,
        timestamp: "2026-10-21T10:00:03Z",
        durationMs: 95,
        type: "fallback",
        status: "fallback_success",
        fallbackUsed: true,
        fallbackStage: "drop_tag",
        fallbackReason: "Dropped category tag, classifying from entity tags",
        originalTagId: "urn:tag:category:place:coffee",
        tagDropped: true,
        anchorIdsUsed: ["R-1", "Z-1"],
        acceptedCount: 4,
        reviewCount: 1,
        rejectedCount: 2,
        rejectedReasons: {
          transit_airport: 1,
          category_conflict: 1,
        },
        qlooRequestsMade: 7,
        qlooCacheHits: 1,
      },
      {
        id: 6,
        timestamp: "2026-10-21T10:00:04Z",
        durationMs: 12,
        type: "tool_dispatch",
        toolName: "finalize",
        toolInput: { summary: "Done", recommendation_ids: ["V-1", "V-2"] },
        status: "success",
        qlooRequestsMade: 7,
        qlooCacheHits: 1,
        fallbackUsed: false,
      },
    ];

    const projected = projectPublicTrace(traceEvents, {
      city: "Berlin",
      mode: "agent",
      cached: false,
      durationMs: 320,
      outcome: "completed",
      verifiedAnchors: [{ name: "Radiohead" }, { name: "Zara" }],
    });

    assert.equal(projected.fallbackTriggered, true);
    assert.equal(projected.fallbackRecovered, true);
    assert.equal(projected.qlooCacheStatus, "mixed");

    // Totals aggregate across initial discovery + fallback stage
    assert.equal(projected.totals.accepted, 4);
    assert.equal(projected.totals.review, 2);
    assert.equal(projected.totals.rejected, 5);
    assert.deepEqual(projected.totals.rejectedReasons, {
      hotel_accommodation: 2,
      closed: 1,
      transit_airport: 1,
      category_conflict: 1,
    });

    // Repeated anchor resolution attempts are kept distinct with attemptNumber 1 and 2
    const resolveSteps = projected.steps.filter(
      (s) => s.kind === "anchor_resolution",
    );
    assert.equal(resolveSteps.length, 2);
    assert.equal(resolveSteps[0].attemptNumber, 1);
    assert.equal(resolveSteps[0].cacheStatus, "live");
    assert.equal(resolveSteps[1].attemptNumber, 2);
    assert.equal(resolveSteps[1].cacheStatus, "cached");
    assert.ok(resolveSteps[1].title.includes("attempt #2"));

    // Fallback stages are present and accurate
    const fbSteps = projected.steps.filter((s) => s.kind === "fallback_step");
    assert.equal(fbSteps.length, 3);
    assert.equal(fbSteps[0].fallback?.stage, "triggered");
    assert.equal(fbSteps[1].fallback?.stage, "alt_tag");
    assert.equal(fbSteps[1].status, "skipped");
    assert.equal(fbSteps[2].fallback?.stage, "drop_tag");
    assert.equal(fbSteps[2].status, "recovered");
    assert.equal(fbSteps[2].fallback?.recovered, true);

    // Render AgentTraceDrawer HTML and verify visible counts and labels
    const html = renderToStaticMarkup(
      createElement(AgentTraceDrawer, {
        process: projected,
        isOpen: true,
        onToggle: () => {},
      }),
    );
    assert.ok(html.includes("Attempt #2"));
    assert.ok(html.includes("hotel / lodging: 2"));
    assert.ok(html.includes("closed venue: 1"));
    assert.ok(html.includes("transit / station: 1"));
    assert.ok(html.includes("conflicting primary category: 1"));
    assert.ok(html.includes("Recovered accepted places"));
  });
});

// ── 11. Failure and retry behavior does not retain stale results ──

describe("11. Failure and retry behavior never retains stale results", () => {
  it("clears previous results immediately when a new request starts or fails, while preserving inputs for retry", () => {
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

    // 1. First request for Berlin succeeds
    state = startKitGeneration(state).state;
    const berlinOutput: StructuredOutput = {
      status: "success",
      summary: "Found 1 recommendation in Berlin.",
      recommendations: [makeStructuredRec({ name: "Berlin Venue" })],
      totalRecommendations: 1,
      invalidIds: [],
    };
    state = applyKitGenerationResponse(
      state,
      {
        status: "success",
        output: berlinOutput,
        meta: {
          runId: "r-berlin",
          city: "Berlin",
          anchorCount: 1,
          mode: "agent",
          cached: false,
          durationMs: 100,
        },
      },
      200,
    );
    assert.equal(state.generation.result?.city, "Berlin");
    assert.equal(state.generation.result?.recommendations[0].name, "Berlin Venue");

    // 2. Switch destination city to Toronto -> Berlin results cleared immediately
    state = selectCity(state, "Toronto").state;
    assert.equal(state.city, "Toronto");
    assert.equal(
      state.generation.result,
      null,
      "switching city must immediately clear previous city results",
    );
    // Confirmed anchor is preserved so user can generate for Toronto
    assert.equal(canGenerateKit(state), true);

    // 3. Start generation for Toronto, then simulate failure (504 timeout)
    state = startKitGeneration(state).state;
    assert.equal(state.generation.result, null);
    state = applyKitGenerationResponse(
      state,
      {
        status: "error",
        output: null,
        error: { code: "deadline_exceeded", message: "Request timed out." },
      },
      504,
    );
    assert.equal(deriveFlowPhase(state), "generation_error");
    assert.equal(
      state.generation.result,
      null,
      "failed request must never leave stale results",
    );
    assert.equal(state.city, "Toronto");
    assert.equal(state.anchors[0].status, "confirmed");
    assert.equal(canGenerateKit(state), true);

    // 4. Even if user didn't switch city before re-generating and the re-generation fails,
    // stale results from the earlier run are cleared:
    state = startKitGeneration(state).state;
    state = applyKitGenerationResponse(
      state,
      {
        status: "success",
        output: {
          ...berlinOutput,
          summary: "Found 1 recommendation in Toronto.",
          recommendations: [makeStructuredRec({ name: "Toronto Venue" })],
        },
        meta: {
          runId: "r-toronto",
          city: "Toronto",
          anchorCount: 1,
          mode: "agent",
          cached: false,
          durationMs: 110,
        },
      },
      200,
    );
    assert.equal(state.generation.result?.recommendations[0].name, "Toronto Venue");

    // Now trigger another generation that throws a network error
    state = startKitGeneration(state).state;
    assert.equal(state.generation.result, null);
    state = applyKitGenerationError(state, new Error("Network disconnected"));
    assert.equal(state.generation.status, "error");
    assert.equal(
      state.generation.result,
      null,
      "network error must not retain previous results",
    );
    assert.equal(canGenerateKit(state), true);
  });
});

// ── 12. Entity-confirmation flow and existing /api/kit payload remain functional ──

describe("12. End-to-end entity confirmation and /api/kit flow", () => {
  it("searches, confirms, builds valid /api/kit payload, and parses full P4-3 completion", async () => {
    const rawRadiohead = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "fixtures", "search-radiohead.json"),
        "utf-8",
      ),
    );
    const parsedRadiohead: SearchResponse =
      SearchResponseSchema.parse(rawRadiohead);

    const fakeSearch = async (query: string) => ({
      data:
        query.toLowerCase().trim() === "radiohead"
          ? parsedRadiohead
          : { results: [] },
      meta: { path: "/search", params: { query }, cached: false },
    });

    let state = createInitialFlowState("custom", "Berlin");
    state = addAnchor(state, "Radiohead", "urn:entity:artist").state;
    const anchorId = state.anchors[0].id;

    const { response: searchRes } = await handleAnchorSearch(
      { query: "Radiohead", type: "urn:entity:artist" },
      "c-12",
      { searchEntity: fakeSearch },
    );
    state = applyAnchorLookupResult(state, anchorId, searchRes);
    assert.equal(state.anchors[0].status, "candidates");

    state = confirmAnchorCandidate(
      state,
      anchorId,
      "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    ).state;
    assert.equal(canGenerateKit(state), true);

    const payload = buildKitRequestPayload(state);
    assert.ok(payload);

    const { response: kitRes, httpStatus } = await handleKitRequest(
      payload,
      "c-12",
      {
        searchEntity: fakeSearch,
        runAgent: async () => ({
          runId: "run-e2e-12",
          status: "completed",
          finalization: {
            summary: "Done",
            recommendationIds: ["V-1"],
            recommendationCount: 1,
          },
          output: {
            status: "success",
            summary: "Found 1 recommendation in Berlin.",
            recommendations: [makeStructuredRec()],
            totalRecommendations: 1,
            invalidIds: [],
          },
          trace: [
            {
              id: 0,
              timestamp: new Date().toISOString(),
              durationMs: 60,
              type: "tool_dispatch",
              toolName: "discover_places",
              toolInput: {
                anchor_ids: ["70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C"],
                city: "Berlin",
              },
              status: "success",
              acceptedCount: 1,
              reviewCount: 0,
              rejectedCount: 0,
              rejectedReasons: {},
              qlooRequestsMade: 2,
              qlooCacheHits: 0,
              fallbackUsed: false,
            },
          ],
          toolCallCount: 1,
          qlooOutboundRequests: 2,
          qlooCacheHits: 0,
          totalDurationMs: 110,
        }),
      },
    );

    state = startKitGeneration(state).state;
    state = applyKitGenerationResponse(state, kitRes, httpStatus);

    assert.equal(deriveFlowPhase(state), "success");
    assert.ok(state.generation.result);
    assert.equal(state.generation.result.city, "Berlin");
    assert.equal(state.generation.result.recommendations.length, 1);
    assert.equal(state.generation.result.searchProcess.steps.length, 2); // anchor_verification + place_discovery
    assert.equal(
      state.generation.result.searchProcess.steps[0].kind,
      "anchor_verification",
    );
    assert.equal(
      state.generation.result.searchProcess.steps[1].kind,
      "place_discovery",
    );
  });
});

// ── 13. Existing /api/discover behavior remains intact ────────

describe("13. Existing /api/discover behavior remains intact", () => {
  it("keeps MUMBAI_NEWCOMER profile and /api/discover POST handler intact", () => {
    assert.equal(MUMBAI_NEWCOMER.name, "Mumbai Newcomer — Berlin Starter Kit");
    assert.equal(MUMBAI_NEWCOMER.city, "Berlin");
    assert.equal(MUMBAI_NEWCOMER.anchors.length, 5);
    assert.equal(typeof discoverRoutePost, "function");
  });
});
