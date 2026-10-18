import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SearchResponseSchema } from "../lib/qloo/schemas";
import { resolveEntityFromResults } from "../lib/qloo/resolver";

function loadSearch(name: string) {
  const path = resolve(import.meta.dirname, "fixtures", name);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return SearchResponseSchema.parse(raw).results;
}

describe("resolveEntityFromResults", () => {
  it("resolves Arijit Singh as artist, not person", () => {
    const results = loadSearch("search-arijit-singh.json");
    const out = resolveEntityFromResults(results, "urn:entity:artist");

    assert.equal(out.status, "resolved");
    assert.equal(out.status === "resolved" && out.entity.entityId, "924C8504-4BD8-4615-AB2D-1C16880A8A62");
    assert.equal(out.status === "resolved" && out.entity.name, "Arijit Singh");
    assert.equal(out.status === "resolved" && out.entity.requestedType, "urn:entity:artist");
  });

  it("returns ambiguous for The Office with two tv_show candidates", () => {
    const results = loadSearch("search-the-office.json");
    const out = resolveEntityFromResults(results, "urn:entity:tv_show");

    assert.equal(out.status, "ambiguous");
    if (out.status !== "ambiguous") throw new Error("unreachable");

    assert.equal(out.candidates.length, 2);

    const ids = out.candidates.map((c) => c.entityId).sort();
    assert.deepEqual(ids, [
      "7C2ECF3A-BDD2-49BB-84CF-2FC048F7C797",
      "E5AE1F26-04CB-4CDD-BBA4-87FB6541F848",
    ]);

    for (const c of out.candidates) {
      assert.equal(c.requestedType, "urn:entity:tv_show");
    }

    const disambigs = out.candidates.map((c) => c.disambiguation);
    assert.ok(disambigs.some((d) => d?.includes("2005")), "should preserve disambiguation metadata");
  });

  it("resolves Radiohead as artist without false ambiguity from duplicate entity_id", () => {
    const results = loadSearch("search-radiohead.json");
    const out = resolveEntityFromResults(results, "urn:entity:artist");

    assert.equal(out.status, "resolved");
    assert.equal(out.status === "resolved" && out.entity.entityId, "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C");
    assert.equal(out.status === "resolved" && out.entity.name, "Radiohead");
  });

  it("resolves Zara as brand, not place", () => {
    const results = loadSearch("search-zara.json");
    const out = resolveEntityFromResults(results, "urn:entity:brand");

    assert.equal(out.status, "resolved");
    assert.equal(out.status === "resolved" && out.entity.entityId, "74A44B01-5C99-4754-9585-F487D21C543D");
    assert.equal(out.status === "resolved" && out.entity.name, "Zara");
  });

  it("returns not_found when no candidate of the requested type exists", () => {
    const results = loadSearch("search-arijit-singh.json");
    const out = resolveEntityFromResults(results, "urn:entity:tv_show");

    assert.equal(out.status, "not_found");
    assert.equal(out.status === "not_found" && out.requestedType, "urn:entity:tv_show");
  });

  it("returns not_found for empty results", () => {
    const out = resolveEntityFromResults([], "urn:entity:artist");
    assert.equal(out.status, "not_found");
  });

  it("Zara returns ambiguous when resolving as place (two distinct place IDs)", () => {
    const results = loadSearch("search-zara.json");
    const out = resolveEntityFromResults(results, "urn:entity:place");

    assert.equal(out.status, "ambiguous");
    if (out.status !== "ambiguous") throw new Error("unreachable");
    assert.equal(out.candidates.length, 2);
  });
});
