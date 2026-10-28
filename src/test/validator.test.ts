import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InsightEntity } from "../lib/qloo/schemas";
import {
  validateEntity,
  validateEntities,
  scoreCategoryEvidence,
} from "../lib/validate";

function loadEdgeCases(): Record<string, InsightEntity> {
  const path = resolve(import.meta.dirname, "fixtures", "validator-edge-cases.json");
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const map: Record<string, InsightEntity> = {};
  for (const e of raw.entities) {
    map[e.name] = e as InsightEntity;
  }
  return map;
}

function loadInsightsSample(): InsightEntity[] {
  const path = resolve(
    import.meta.dirname,
    "fixtures",
    "insights-berlin-validation-sample.json",
  );
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return raw.results.entities as InsightEntity[];
}

// --- Synthetic entities for cases not found in real data ---

const SYNTHETIC_CLOSED: InsightEntity = {
  name: "SYNTHETIC: Closed Cafe",
  entity_id: "SYNTH-CLOSED-0001",
  properties: { is_closed: true, website: null },
  location: { lat: 52.5, lon: 13.4 },
  tags: [
    { id: "urn:tag:category:place:cafe", name: "Cafe", type: "urn:tag:category:place" },
  ],
} as InsightEntity;

const SYNTHETIC_NO_COORDS: InsightEntity = {
  name: "SYNTHETIC: No-Coords Bookshop",
  entity_id: "SYNTH-NOCOORDS-0001",
  properties: { is_closed: false },
  tags: [
    { id: "urn:tag:category:place:book_store", name: "Book store", type: "urn:tag:category:place" },
  ],
} as InsightEntity;

const SYNTHETIC_NO_NAME: InsightEntity = {
  name: "",
  entity_id: "SYNTH-NONAME-0001",
  properties: { is_closed: false },
  location: { lat: 52.5, lon: 13.4 },
  tags: [],
} as InsightEntity;

describe("validateEntity — basic rejections", () => {
  it("rejects closed place", () => {
    const r = validateEntity(SYNTHETIC_CLOSED);
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "closed");
  });

  it("rejects entity with empty name", () => {
    const r = validateEntity(SYNTHETIC_NO_NAME);
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "missing_name");
  });

  it("rejects hotel by hotel properties", () => {
    const sample = loadInsightsSample();
    const hotel = sample.find((e) => e.name === "Hotel Catalonia Berlin Mitte")!;
    const r = validateEntity(hotel);
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "hotel_accommodation");
  });

  it("rejects airport (real data: Toronto Pearson)", () => {
    const edges = loadEdgeCases();
    const r = validateEntity(edges["Toronto Pearson International Airport"]);
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "transit_airport");
  });

  it("rejects subway station (real data: Dundas Station)", () => {
    const edges = loadEdgeCases();
    const r = validateEntity(edges["Dundas Station"]);
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "transit_airport");
  });
});

describe("validateEntity — accepted without category filter", () => {
  it("accepts valid cafe (real data: Steel Vintage Bikes Café)", () => {
    const sample = loadInsightsSample();
    const cafe = sample.find((e) => e.name === "Steel Vintage Bikes Café")!;
    const r = validateEntity(cafe);
    assert.equal(r.verdict, "accepted");
    assert.equal(r.mappable, true);
  });

  it("accepts Chutnify (real data: Indian restaurant)", () => {
    const sample = loadInsightsSample();
    const chutnify = sample.find((e) => e.name === "Chutnify")!;
    const r = validateEntity(chutnify);
    assert.equal(r.verdict, "accepted");
    assert.equal(r.mappable, true);
  });
});

describe("validateEntity — mappable flag", () => {
  it("marks entity without coordinates as non-mappable but not rejected", () => {
    const r = validateEntity(SYNTHETIC_NO_COORDS);
    assert.equal(r.verdict, "accepted");
    assert.equal(r.mappable, false);
  });

  it("marks entity with coordinates as mappable", () => {
    const edges = loadEdgeCases();
    const r = validateEntity(edges["Huxleys Neue Welt"]);
    assert.equal(r.mappable, true);
  });
});

describe("scoreCategoryEvidence", () => {
  const edges = loadEdgeCases();

  it("scores Huxleys as position 1 for live_music_venue (second tag)", () => {
    const ev = scoreCategoryEvidence(
      edges["Huxleys Neue Welt"],
      "urn:tag:category:place:live_music_venue",
    );
    assert.equal(ev.position, 1);
    assert.equal(ev.score, 1);
    assert.equal(ev.conflict, false);
  });

  it("scores Tresor as position 2 for live_music_venue (third tag)", () => {
    const ev = scoreCategoryEvidence(
      edges["Tresor Berlin I Club & label"],
      "urn:tag:category:place:live_music_venue",
    );
    assert.equal(ev.position, 2);
    assert.equal(ev.score, 0);
    assert.equal(ev.conflict, false);
  });

  it("scores Coretex Records as position 1 for record_store (second tag)", () => {
    const ev = scoreCategoryEvidence(
      edges["Coretex Records"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(ev.position, 1);
    assert.equal(ev.score, 1);
    assert.equal(ev.conflict, false);
  });

  it("detects conflict for Motif Wein as record_store (wine_store first)", () => {
    const ev = scoreCategoryEvidence(
      edges["Motif Wein"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(ev.conflict, true);
    assert.equal(ev.position, 2);
  });

  it("detects conflict for ESHK Friseur as record_store (hair_salon first)", () => {
    const ev = scoreCategoryEvidence(
      edges["ESHK Friseur Moabit"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(ev.conflict, true);
  });
});

describe("validateEntity — category filtering", () => {
  const edges = loadEdgeCases();

  it("accepts Huxleys Neue Welt for live_music_venue (score 1, no conflict)", () => {
    const r = validateEntity(
      edges["Huxleys Neue Welt"],
      "urn:tag:category:place:live_music_venue",
    );
    assert.equal(r.verdict, "accepted");
    assert.equal(r.categoryEvidence?.score, 1);
  });

  it("puts Tresor in review for live_music_venue (score 0, no conflict)", () => {
    const r = validateEntity(
      edges["Tresor Berlin I Club & label"],
      "urn:tag:category:place:live_music_venue",
    );
    assert.equal(r.verdict, "review");
    assert.equal(r.reason, "weak_category_evidence");
    assert.equal(r.categoryEvidence?.score, 0);
  });

  it("accepts Coretex Records for record_store (score 1, no conflict)", () => {
    const r = validateEntity(
      edges["Coretex Records"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(r.verdict, "accepted");
    assert.equal(r.categoryEvidence?.score, 1);
  });

  it("rejects Motif Wein for record_store (conflict: wine_store first)", () => {
    const r = validateEntity(
      edges["Motif Wein"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "category_conflict");
  });

  it("rejects ESHK Friseur for record_store (conflict: hair_salon first)", () => {
    const r = validateEntity(
      edges["ESHK Friseur Moabit"],
      "urn:tag:category:place:record_store",
    );
    assert.equal(r.verdict, "rejected");
    assert.equal(r.reason, "category_conflict");
  });
});

describe("validateEntities — entity_id deduplication", () => {
  it("rejects exact same entity_id returned twice", () => {
    const sample = loadInsightsSample();
    const cafe = sample.find((e) => e.name === "Steel Vintage Bikes Café")!;
    const results = validateEntities([cafe, cafe]);
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[1].verdict, "rejected");
    assert.equal(results[1].reason, "duplicate");
  });

  it("retains first occurrence when same entity_id appears twice", () => {
    const edges = loadEdgeCases();
    const huxleys = edges["Huxleys Neue Welt"];
    const results = validateEntities(
      [huxleys, huxleys],
      "urn:tag:category:place:live_music_venue",
    );
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[0].categoryEvidence?.score, 1);
    assert.equal(results[1].verdict, "rejected");
    assert.equal(results[1].reason, "duplicate");
  });
});

describe("validateEntities — name+proximity deduplication", () => {
  it("deduplicates same name, different IDs, nearby coordinates", () => {
    const a = {
      name: "Test Cafe",
      entity_id: "ID-A",
      properties: { is_closed: false },
      location: { lat: 52.5, lon: 13.4 },
      tags: [],
    } as unknown as InsightEntity;
    const b = {
      name: "test cafe",
      entity_id: "ID-B",
      properties: { is_closed: false },
      location: { lat: 52.5001, lon: 13.4001 },
      tags: [],
    } as unknown as InsightEntity;
    const results = validateEntities([a, b]);
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[1].verdict, "rejected");
    assert.equal(results[1].reason, "duplicate");
  });

  it("retains both when same name, different IDs, distant coordinates", () => {
    const a = {
      name: "Test Cafe",
      entity_id: "ID-A",
      properties: { is_closed: false },
      location: { lat: 52.5, lon: 13.4 },
      tags: [],
    } as unknown as InsightEntity;
    const b = {
      name: "Test Cafe",
      entity_id: "ID-B",
      properties: { is_closed: false },
      location: { lat: 48.1, lon: 11.5 },
      tags: [],
    } as unknown as InsightEntity;
    const results = validateEntities([a, b]);
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[1].verdict, "accepted");
  });

  it("retains both when same name but neither has coordinates", () => {
    const a = {
      name: "Test Cafe",
      entity_id: "ID-A",
      properties: { is_closed: false },
      tags: [],
    } as unknown as InsightEntity;
    const b = {
      name: "Test Cafe",
      entity_id: "ID-B",
      properties: { is_closed: false },
      tags: [],
    } as unknown as InsightEntity;
    const results = validateEntities([a, b]);
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[1].verdict, "accepted");
  });

  it("retains both when same name but only one has coordinates", () => {
    const a = {
      name: "Test Cafe",
      entity_id: "ID-A",
      properties: { is_closed: false },
      location: { lat: 52.5, lon: 13.4 },
      tags: [],
    } as unknown as InsightEntity;
    const b = {
      name: "Test Cafe",
      entity_id: "ID-B",
      properties: { is_closed: false },
      tags: [],
    } as unknown as InsightEntity;
    const results = validateEntities([a, b]);
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[1].verdict, "accepted");
  });
});

describe("validateEntities — rejected entities do not poison dedup set", () => {
  it("rejected hotel does not suppress valid venue with same name", () => {
    const hotel = {
      name: "Berlin Cafe",
      entity_id: "HOTEL-ID",
      properties: {
        is_closed: false,
        hotel_class: 3,
        star_rating: 3,
        number_of_rooms: 50,
      },
      location: { lat: 52.5, lon: 13.4 },
      tags: [
        {
          id: "urn:tag:category:place:hotel",
          name: "Hotel",
          type: "urn:tag:category:place",
        },
      ],
    } as unknown as InsightEntity;
    const cafe = {
      name: "Berlin Cafe",
      entity_id: "CAFE-ID",
      properties: { is_closed: false },
      location: { lat: 52.5001, lon: 13.4001 },
      tags: [
        {
          id: "urn:tag:category:place:cafe",
          name: "Cafe",
          type: "urn:tag:category:place",
        },
      ],
    } as unknown as InsightEntity;
    const results = validateEntities([hotel, cafe]);
    assert.equal(results[0].verdict, "rejected");
    assert.equal(results[0].reason, "hotel_accommodation");
    assert.equal(results[1].verdict, "accepted");
  });

  it("rejected transit entity does not suppress valid venue with same name", () => {
    const transit = {
      name: "Central Station Cafe",
      entity_id: "TRANSIT-ID",
      properties: { is_closed: false },
      location: { lat: 52.5, lon: 13.4 },
      tags: [
        {
          id: "urn:tag:category:place:train_station",
          name: "Train station",
          type: "urn:tag:category:place",
        },
      ],
    } as unknown as InsightEntity;
    const cafe = {
      name: "Central Station Cafe",
      entity_id: "CAFE-ID",
      properties: { is_closed: false },
      location: { lat: 52.5001, lon: 13.4001 },
      tags: [
        {
          id: "urn:tag:category:place:cafe",
          name: "Cafe",
          type: "urn:tag:category:place",
        },
      ],
    } as unknown as InsightEntity;
    const results = validateEntities([transit, cafe]);
    assert.equal(results[0].verdict, "rejected");
    assert.equal(results[0].reason, "transit_airport");
    assert.equal(results[1].verdict, "accepted");
  });

  it("preserves category evidence on first retained entity", () => {
    const edges = loadEdgeCases();
    const results = validateEntities(
      [edges["Coretex Records"]],
      "urn:tag:category:place:record_store",
    );
    assert.equal(results[0].verdict, "accepted");
    assert.equal(results[0].categoryEvidence?.score, 1);
    assert.equal(results[0].categoryEvidence?.position, 1);
  });

  it("does not falsely reject non-accommodation venues that only have number_of_rooms alongside non-hotel place categories", () => {
    const restaurantWithRoomCount: InsightEntity = {
      name: "Lokal",
      entity_id: "538E64BA-A571-49F0-9B1B-58C7B76FBD26",
      properties: {
        is_closed: false,
        hotel_class: null,
        star_rating: null,
        number_of_rooms: 55,
        check_in_time: null,
      },
      location: { lat: 52.527, lon: 13.389 },
      tags: [
        {
          id: "urn:tag:category:place:restaurant",
          name: "Restaurant",
          type: "urn:tag:category:place",
        },
        {
          id: "urn:tag:category:place:german_restaurant",
          name: "German restaurant",
          type: "urn:tag:category:place",
        },
      ],
    };

    const uncategorizedApartmentWithRoomCount: InsightEntity = {
      name: "Homaris East Side",
      entity_id: "003DA6F7-3A9E-4F16-9ECF-7A9B4B8F5DDA",
      properties: {
        is_closed: false,
        hotel_class: null,
        star_rating: null,
        number_of_rooms: 36,
        check_in_time: null,
      },
      location: { lat: 52.51, lon: 13.43 },
      tags: [],
    };

    assert.equal(validateEntity(restaurantWithRoomCount).verdict, "accepted");
    const aptResult = validateEntity(uncategorizedApartmentWithRoomCount);
    assert.equal(aptResult.verdict, "rejected");
    assert.equal(aptResult.reason, "hotel_accommodation");
  });
});
