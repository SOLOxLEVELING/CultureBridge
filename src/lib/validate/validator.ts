import type { InsightEntity, EntityTag } from "../qloo/schemas";

// --- Outcome types ---

export type ValidationVerdict = "accepted" | "review" | "rejected";

export type RejectionReason =
  | "closed"
  | "hotel_accommodation"
  | "transit_airport"
  | "missing_name"
  | "duplicate"
  | "category_conflict";

export type ReviewReason = "weak_category_evidence";

export interface ValidationResult {
  entityId: string;
  name: string;
  verdict: ValidationVerdict;
  reason?: RejectionReason | ReviewReason;
  mappable: boolean;
  categoryEvidence?: CategoryEvidence;
}

// --- Category evidence scoring ---

export interface CategoryEvidence {
  requestedCategory: string;
  score: number;
  position: number | null;
  conflict: boolean;
}

const ACCOMMODATION_CATEGORIES = new Set([
  "hotel",
  "hostel",
  "motel",
  "bed_breakfast",
  "resort_hotel",
  "wellness_hotel",
  "youth_hostel",
  "apartment_building",
  "serviced_apartment",
  "inn",
  "lodge",
  "guest_house",
]);

const TRANSIT_CATEGORIES = new Set([
  "airport",
  "international_airport",
  "subway_station",
  "train_station",
  "bus_station",
  "ferry_terminal",
  "transit_station",
]);

const CATEGORY_CONFLICTS: Record<string, Set<string>> = {
  record_store: new Set([
    "hair_salon",
    "hairdresser",
    "wine_store",
    "wine_bar",
    "garden_center",
    "florist",
    "pharmacy",
  ]),
  book_store: new Set([
    "hair_salon",
    "hairdresser",
    "wine_store",
    "garden_center",
  ]),
  live_music_venue: new Set([
    "hair_salon",
    "hairdresser",
    "laundromat",
  ]),
};

function categorySlug(tagId: string): string {
  const prefix = "urn:tag:category:place:";
  return tagId.startsWith(prefix) ? tagId.slice(prefix.length) : tagId;
}

function getCategoryTags(entity: InsightEntity): EntityTag[] {
  return (entity.tags ?? []).filter((t) =>
    t.id.startsWith("urn:tag:category:place:"),
  );
}

function hasHotelProperties(entity: InsightEntity): boolean {
  const p = entity.properties;
  if (!p) return false;
  return (
    (p.hotel_class != null && p.hotel_class !== 0) ||
    (p.star_rating != null && p.star_rating !== 0) ||
    (p.number_of_rooms != null && p.number_of_rooms !== 0) ||
    (p.check_in_time != null && p.check_in_time !== "")
  );
}

function isAccommodation(entity: InsightEntity): boolean {
  if (hasHotelProperties(entity)) return true;
  const cats = getCategoryTags(entity);
  return cats.some((t) => ACCOMMODATION_CATEGORIES.has(categorySlug(t.id)));
}

function isTransit(entity: InsightEntity): boolean {
  const cats = getCategoryTags(entity);
  if (cats.some((t) => TRANSIT_CATEGORIES.has(categorySlug(t.id)))) return true;
  const name = entity.name.toLowerCase();
  return /\b(airport|flughafen)\b/.test(name);
}

export function scoreCategoryEvidence(
  entity: InsightEntity,
  requestedCategory: string,
): CategoryEvidence {
  const cats = getCategoryTags(entity);
  const requestedSlug = categorySlug(requestedCategory);
  const conflicts = CATEGORY_CONFLICTS[requestedSlug];

  const position = cats.findIndex(
    (t) => categorySlug(t.id) === requestedSlug,
  );

  const firstSlug = cats.length > 0 ? categorySlug(cats[0].id) : null;
  const hasConflict = !!(
    conflicts &&
    firstSlug &&
    conflicts.has(firstSlug)
  );

  let score: number;
  if (position === 0) {
    score = 2;
  } else if (position === 1) {
    score = 1;
  } else if (position > 1) {
    score = 0;
  } else {
    score = -1;
  }

  return {
    requestedCategory: requestedSlug,
    score,
    position: position >= 0 ? position : null,
    conflict: hasConflict,
  };
}

// --- Single entity validation ---

export function validateEntity(
  entity: InsightEntity,
  requestedCategory?: string,
): ValidationResult {
  const base = {
    entityId: entity.entity_id,
    name: entity.name,
    mappable: !!(entity.location?.lat != null && entity.location?.lon != null),
  };

  if (!entity.name) {
    return { ...base, verdict: "rejected", reason: "missing_name" };
  }

  if (entity.properties?.is_closed === true) {
    return { ...base, verdict: "rejected", reason: "closed" };
  }

  if (isAccommodation(entity)) {
    return { ...base, verdict: "rejected", reason: "hotel_accommodation" };
  }

  if (isTransit(entity)) {
    return { ...base, verdict: "rejected", reason: "transit_airport" };
  }

  if (requestedCategory) {
    const evidence = scoreCategoryEvidence(entity, requestedCategory);

    if (evidence.conflict) {
      return {
        ...base,
        verdict: "rejected",
        reason: "category_conflict",
        categoryEvidence: evidence,
      };
    }

    if (evidence.score <= 0) {
      return {
        ...base,
        verdict: "review",
        reason: "weak_category_evidence",
        categoryEvidence: evidence,
      };
    }

    return { ...base, verdict: "accepted", categoryEvidence: evidence };
  }

  return { ...base, verdict: "accepted" };
}

// --- Location proximity ---

const DUPLICATE_PROXIMITY_METERS = 200;

interface LatLon {
  lat: number;
  lon: number;
}

function getLatLon(entity: InsightEntity): LatLon | null {
  if (entity.location?.lat != null && entity.location?.lon != null) {
    return { lat: entity.location.lat, lon: entity.location.lon };
  }
  return null;
}

function approxDistanceMeters(a: LatLon, b: LatLon): number {
  const avgLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * 111_000;
  const dLon = (a.lon - b.lon) * 111_000 * Math.cos(avgLatRad);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// --- Batch validation with deduplication ---

export function validateEntities(
  entities: InsightEntity[],
  requestedCategory?: string,
): ValidationResult[] {
  const seenIds = new Set<string>();
  const acceptedByName = new Map<string, LatLon | null>();
  const results: ValidationResult[] = [];

  for (const entity of entities) {
    const mappable = !!(
      entity.location?.lat != null && entity.location?.lon != null
    );
    const dupeResult: ValidationResult = {
      entityId: entity.entity_id,
      name: entity.name,
      verdict: "rejected",
      reason: "duplicate",
      mappable,
    };

    if (seenIds.has(entity.entity_id)) {
      results.push(dupeResult);
      continue;
    }
    seenIds.add(entity.entity_id);

    const result = validateEntity(entity, requestedCategory);

    if (result.verdict === "rejected") {
      results.push(result);
      continue;
    }

    const normalized = entity.name.toLowerCase().trim();
    const prev = acceptedByName.get(normalized);
    if (prev !== undefined) {
      const curLoc = getLatLon(entity);
      if (prev !== null && curLoc !== null) {
        if (approxDistanceMeters(prev, curLoc) < DUPLICATE_PROXIMITY_METERS) {
          results.push(dupeResult);
          continue;
        }
      }
    }

    acceptedByName.set(normalized, getLatLon(entity));
    results.push(result);
  }

  return results;
}
