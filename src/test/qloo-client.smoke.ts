import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { searchEntity, insights, searchTags, clearCache } from "../lib/qloo";

if (!process.env.SMOKE) {
  console.log("Skipping smoke tests (set SMOKE=1 to run)");
  process.exit(0);
}

if (!process.env.QLOO_API_KEY) {
  console.error("QLOO_API_KEY required for smoke tests");
  process.exit(1);
}

describe("Qloo client live smoke tests", () => {
  before(() => clearCache());

  it("searchEntity resolves Radiohead", async () => {
    const { data, meta } = await searchEntity("Radiohead", 3);
    assert.equal(meta.path, "/search");
    assert.equal(meta.cached, false);
    assert.ok(data.results.length > 0, "should return at least one result");
    const artist = data.results.find((r) =>
      r.types.includes("urn:entity:artist"),
    );
    assert.ok(artist, "should find an artist-type result");
    assert.equal(artist.name, "Radiohead");
  });

  it("insights returns Berlin places for a taste signal", async () => {
    const search = await searchEntity("Radiohead", 3);
    const artist = search.data.results.find((r) =>
      r.types.includes("urn:entity:artist"),
    );
    assert.ok(artist);

    const { data, meta } = await insights({
      anchors: [artist.entity_id],
      city: "Berlin",
      take: 5,
    });
    assert.equal(meta.path, "/v2/insights");
    assert.ok(
      data.results.entities.length > 0,
      "should return at least one entity",
    );
    const first = data.results.entities[0];
    assert.ok(first.name, "entity should have a name");
    assert.ok(first.entity_id, "entity should have an entity_id");
  });

  it("searchTags finds live music tags", async () => {
    const { data, meta } = await searchTags("live music", 5);
    assert.equal(meta.path, "/v2/tags");
    assert.ok(data.results.tags.length > 0, "should return at least one tag");
    const categoryTag = data.results.tags.find(
      (t) => t.type === "urn:tag:category:place",
    );
    assert.ok(categoryTag, "should include a category:place tag");
  });

  it("cache returns cached result on repeat call", async () => {
    await searchEntity("Radiohead", 3);
    const { meta } = await searchEntity("Radiohead", 3);
    assert.equal(meta.cached, true, "second call should be cached");
  });
});
