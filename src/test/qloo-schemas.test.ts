import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SearchResponseSchema,
  InsightsResponseSchema,
  TagsResponseSchema,
} from "../lib/qloo/schemas";

function loadFixture(name: string): unknown {
  const path = resolve(import.meta.dirname, "fixtures", name);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("SearchResponseSchema", () => {
  it("parses Arijit Singh search results", () => {
    const raw = loadFixture("search-arijit-singh.json");
    const parsed = SearchResponseSchema.parse(raw);
    assert.equal(parsed.results.length, 3);
    assert.equal(parsed.results[0].name, "Arijit Singh");
    assert.equal(parsed.results[0].entity_id, "549B1B26-01A6-45A7-90C2-EF559A34D8E6");
    assert.deepEqual(parsed.results[0].types, ["urn:entity:person"]);
    assert.equal(parsed.results[1].types[0], "urn:entity:artist");
    assert.equal(parsed.results[2].types[0], "urn:entity:album");
  });

  it("parses The Office search results with disambiguation", () => {
    const raw = loadFixture("search-the-office.json");
    const parsed = SearchResponseSchema.parse(raw);
    assert.equal(parsed.results.length, 3);
    const tvShows = parsed.results.filter((r) =>
      r.types.includes("urn:entity:tv_show"),
    );
    assert.equal(tvShows.length, 2, "should have two tv_show entries");
    assert.notEqual(
      tvShows[0].entity_id,
      tvShows[1].entity_id,
      "tv_show entries should have different IDs",
    );
  });

  it("parses Radiohead search with same ID across types", () => {
    const raw = loadFixture("search-radiohead.json");
    const parsed = SearchResponseSchema.parse(raw);
    const artist = parsed.results.find((r) =>
      r.types.includes("urn:entity:artist"),
    );
    const person = parsed.results.find((r) =>
      r.types.includes("urn:entity:person"),
    );
    assert.ok(artist);
    assert.ok(person);
    assert.equal(
      artist.entity_id,
      person.entity_id,
      "Radiohead artist and person share the same entity_id",
    );
  });

  it("parses Zara search with brand vs place types", () => {
    const raw = loadFixture("search-zara.json");
    const parsed = SearchResponseSchema.parse(raw);
    const brand = parsed.results.find((r) =>
      r.types.includes("urn:entity:brand"),
    );
    const places = parsed.results.filter((r) =>
      r.types.includes("urn:entity:place"),
    );
    assert.ok(brand);
    assert.equal(places.length, 2);
  });

  it("rejects response missing results array", () => {
    assert.throws(() => SearchResponseSchema.parse({ foo: "bar" }));
  });

  it("rejects entity missing required name", () => {
    assert.throws(() =>
      SearchResponseSchema.parse({
        results: [{ entity_id: "x", types: [] }],
      }),
    );
  });
});

describe("InsightsResponseSchema", () => {
  it("parses Berlin validation sample with all entity types", () => {
    const raw = loadFixture("insights-berlin-validation-sample.json");
    const parsed = InsightsResponseSchema.parse(raw);
    assert.equal(parsed.results.entities.length, 3);

    const cafe = parsed.results.entities[0];
    assert.equal(cafe.name, "Steel Vintage Bikes Café");
    assert.equal(cafe.properties?.is_closed, false);
    assert.ok(cafe.location);
    assert.equal(typeof cafe.location.lat, "number");
    assert.equal(typeof cafe.location.lon, "number");
    assert.ok(cafe.tags && cafe.tags.length >= 1);
    assert.equal(cafe.tags[0].id, "urn:tag:category:place:cafe");
  });

  it("preserves hotel fields on hotel entity", () => {
    const raw = loadFixture("insights-berlin-validation-sample.json");
    const parsed = InsightsResponseSchema.parse(raw);
    const hotel = parsed.results.entities[1];
    assert.equal(hotel.name, "Hotel Catalonia Berlin Mitte");
    assert.equal(hotel.properties?.hotel_class, 4);
    assert.equal(hotel.properties?.star_rating, 4);
    assert.equal(hotel.properties?.number_of_rooms, 131);
    assert.equal(hotel.properties?.check_in_time, "15:00");
  });

  it("preserves explainability scores", () => {
    const raw = loadFixture("insights-berlin-validation-sample.json");
    const parsed = InsightsResponseSchema.parse(raw);

    const cafe = parsed.results.entities[0];
    const scores =
      cafe.query?.explainability?.["signal.interests.entities"];
    assert.ok(scores);
    assert.equal(scores.length, 4);
    const total = scores.reduce((s, e) => s + e.score, 0);
    assert.ok(
      Math.abs(total - 1.0) < 0.01,
      `explainability scores should sum to ~1.0, got ${total}`,
    );

    const hotel = parsed.results.entities[1];
    const hotelScores =
      hotel.query?.explainability?.["signal.interests.entities"];
    assert.ok(hotelScores);
    assert.equal(hotelScores.length, 1);
    assert.equal(hotelScores[0].score, 1);
  });

  it("rejects response missing entities array", () => {
    assert.throws(() =>
      InsightsResponseSchema.parse({ results: { foo: "bar" } }),
    );
  });
});

describe("TagsResponseSchema", () => {
  it("parses live music tag search with multiple families", () => {
    const raw = loadFixture("tags-search-live-music.json");
    const parsed = TagsResponseSchema.parse(raw);
    assert.equal(parsed.results.tags.length, 5);

    const types = parsed.results.tags.map((t) => t.type);
    assert.ok(types.includes("urn:tag:good_for:qloo"));
    assert.ok(types.includes("urn:tag:category:place"));

    const categoryTag = parsed.results.tags.find(
      (t) => t.type === "urn:tag:category:place",
    );
    assert.ok(categoryTag);
    assert.equal(categoryTag.id, "urn:tag:category:place:live_music_venue");
    assert.equal(categoryTag.name, "Live music venue");
  });

  it("preserves popularity values", () => {
    const raw = loadFixture("tags-search-live-music.json");
    const parsed = TagsResponseSchema.parse(raw);
    for (const tag of parsed.results.tags) {
      assert.equal(typeof tag.popularity, "number");
      assert.ok(tag.popularity! > 0 && tag.popularity! <= 1);
    }
  });

  it("rejects response missing tags array", () => {
    assert.throws(() =>
      TagsResponseSchema.parse({ results: {} }),
    );
  });
});
