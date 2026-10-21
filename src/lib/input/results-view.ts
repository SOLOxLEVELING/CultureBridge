import { isValidCoordinate } from "../output/schema";
import type { RecommendationLabel } from "../recommend";
import type { SafeRecommendationItem } from "./flow";

// ── 1. Evidence label presentation (color + symbol + text) ──

export interface LabelPresentation {
  label: RecommendationLabel;
  badgeText: string;
  symbol: string;
  shortTitle: string;
  description: string;
  badgeClassName: string;
  markerClassName: string;
}

export const LABEL_PRESENTATION: Record<RecommendationLabel, LabelPresentation> = {
  connection: {
    label: "connection",
    badgeText: "Connection",
    symbol: "◆",
    shortTitle: "Single-anchor Qloo query match",
    description:
      "Returned in the top 10 of a single-anchor Qloo query and passed deterministic validation. Indicates taste-graph query provenance, not a real-world endorsement or affiliation.",
    badgeClassName:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300",
    markerClassName: "cb-marker-connection",
  },
  "useful-place": {
    label: "useful-place",
    badgeText: "Useful place",
    symbol: "▪",
    shortTitle: "Category-matched venue with practical details",
    description:
      "Passed place-category tag scoring and includes practical venue details (address, phone, or website) in Qloo's catalog. Makes no claim about a specific single anchor or current operating status.",
    badgeClassName:
      "border-foreground/25 bg-foreground/[0.07] text-foreground/90",
    markerClassName: "cb-marker-useful",
  },
  exploratory: {
    label: "exploratory",
    badgeText: "Exploratory",
    symbol: "◇",
    shortTitle: "Blended profile or broader discovery suggestion",
    description:
      "Passed entity validation from a blended multi-anchor query, fallback stage, or lower-ranked query without direct single-anchor connection evidence.",
    badgeClassName:
      "border-foreground/15 border-dashed bg-foreground/[0.025] text-foreground/70",
    markerClassName: "cb-marker-exploratory",
  },
};

export function getLabelPresentation(
  label: RecommendationLabel,
): LabelPresentation {
  return LABEL_PRESENTATION[label] ?? LABEL_PRESENTATION.exploratory;
}

// ── 1b. Kit status presentation (truthful scope & status) ───

export interface KitStatusPresentation {
  status: "success" | "partial" | "empty";
  badgeText: string;
  scopeNote: string;
  badgeClassName: string;
}

export const KIT_STATUS_PRESENTATION: Record<
  "success" | "partial" | "empty",
  KitStatusPresentation
> = {
  success: {
    status: "success",
    badgeText: "Starter Kit Ready",
    scopeNote:
      "Places passed Qloo taste-graph lookup and general deterministic screening (excluding flagged accommodation, transit, closed, and duplicate listings). Category-conflict checks apply only to recommendations for which category evidence was explicitly evaluated; Qloo category tags are not all independently validated, and CultureBridge does not independently verify current operating status, hours, or real-world affiliations.",
    badgeClassName:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  },
  partial: {
    status: "partial",
    badgeText: "Partial Starter Kit",
    scopeNote:
      "Showing only candidates that passed deterministic screening; unaccepted or ungrounded candidate IDs were excluded.",
    badgeClassName:
      "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  },
  empty: {
    status: "empty",
    badgeText: "No Qualifying Matches",
    scopeNote:
      "No candidates returned by Qloo met the deterministic screening criteria for this query.",
    badgeClassName:
      "border-foreground/20 bg-foreground/[0.05] text-foreground/75",
  },
};

export function getKitStatusPresentation(
  status: "success" | "partial" | "empty",
): KitStatusPresentation {
  return KIT_STATUS_PRESENTATION[status] ?? KIT_STATUS_PRESENTATION.empty;
}

// ── 1c. Category evidence vs. Qloo category tags ────────────

export interface CategoryEvidenceView {
  qlooCategories: string[];
  qlooCategoryLabel: string;
  validatedCategory: string | null;
  hasValidatedCategory: boolean;
  displayGroupTitle: string;
  isUncategorized: boolean;
}

export function describeCategoryEvidence(
  rec: Pick<SafeRecommendationItem, "categories" | "categoryEvidence">,
): CategoryEvidenceView {
  const qlooCategories = (rec.categories ?? [])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);

  const ev = rec.categoryEvidence;
  const hasValidatedCategory = Boolean(
    ev !== null &&
      ev !== undefined &&
      typeof ev.requestedCategory === "string" &&
      ev.requestedCategory.trim().length > 0 &&
      typeof ev.score === "number" &&
      ev.score >= 1 &&
      ev.conflict === false,
  );

  const validatedCategory =
    hasValidatedCategory && ev
      ? ev.requestedCategory.trim().replace(/_/g, " ")
      : null;

  const isUncategorized = qlooCategories.length === 0;
  const displayGroupTitle = isUncategorized
    ? UNCATEGORIZED_GROUP_TITLE
    : qlooCategories[0];

  return {
    qlooCategories,
    qlooCategoryLabel:
      qlooCategories.length === 1 ? "Qloo category" : "Qloo categories",
    validatedCategory,
    hasValidatedCategory,
    displayGroupTitle,
    isUncategorized,
  };
}

// ── 2. Grounded provenance & query-mode distinction ─────────

export type ProvenanceDistinctionKind =
  | "single-anchor-connection"
  | "blended-profile"
  | "category-verified"
  | "exploratory-broad";

export interface ProvenancePresentation {
  distinctionKind: ProvenanceDistinctionKind;
  headline: string;
  detail: string;
  anchorAttributions: {
    anchorId: string;
    anchorName: string;
    displayRank: number;
  }[];
  alsoInBlendedQuery: boolean;
  categoryMatchLabel: string | null;
  honestyDisclaimer: string | null;
}

export function formatRecommendationProvenance(
  rec: SafeRecommendationItem,
): ProvenancePresentation {
  const connList = Array.isArray(rec.connectionProvenance)
    ? rec.connectionProvenance
    : [];
  const anchorAttributions = connList.map((cp) => ({
    anchorId: cp.anchorId,
    anchorName: cp.anchorName,
    displayRank: Math.max(1, Math.floor(cp.rank) + 1),
  }));

  const alsoInBlendedQuery =
    rec.queryMode === "mixed" || rec.queryMode === "blended";

  const categoryInfo = describeCategoryEvidence(rec);
  const categorySlug = categoryInfo.validatedCategory;

  const categoryMatchLabel =
    categorySlug && rec.categoryEvidence && categoryInfo.hasValidatedCategory
      ? `Validated for "${categorySlug}" (${
          rec.categoryEvidence.position === 0
            ? "primary category tag"
            : rec.categoryEvidence.position === 1
              ? "secondary category tag"
              : "category tag match"
        })`
      : null;

  if (rec.label === "connection" && anchorAttributions.length > 0) {
    const anchorSummary = anchorAttributions
      .map((a) => `${a.anchorName} (rank #${a.displayRank})`)
      .join(", ");

    return {
      distinctionKind: "single-anchor-connection",
      headline: `Single-anchor Qloo query: ${anchorSummary}`,
      detail:
        rec.queryMode === "mixed"
          ? `Surfaced within the top 10 of ${anchorAttributions.length === 1 ? "a single-anchor Qloo query" : "single-anchor Qloo queries"} and also appeared in the combined profile query.`
          : `Surfaced within the top 10 of ${anchorAttributions.length === 1 ? "a single-anchor Qloo query" : "single-anchor Qloo queries"}.`,
      anchorAttributions,
      alsoInBlendedQuery: rec.queryMode === "mixed",
      categoryMatchLabel,
      honestyDisclaimer:
        "Reflects Qloo taste-graph query provenance only — not proof of a real-world relationship with the artist, show, film, or brand.",
    };
  }

  if (rec.label === "useful-place") {
    const querySourceDesc =
      rec.queryMode === "blended"
        ? "blended taste-profile query"
        : rec.queryMode === "mixed"
          ? "single-anchor and blended queries"
          : "Qloo category query";

    return {
      distinctionKind: "category-verified",
      headline: categorySlug
        ? `Validated ${categorySlug} category match (${querySourceDesc})`
        : `Category-matched venue (${querySourceDesc})`,
      detail:
        "Passed deterministic category-tag scoring and includes Qloo venue details (address, phone, or website). Not attributed to a single cultural anchor.",
      anchorAttributions: [],
      alsoInBlendedQuery,
      categoryMatchLabel,
      honestyDisclaimer: null,
    };
  }

  if (rec.queryMode === "blended") {
    return {
      distinctionKind: "blended-profile",
      headline: "Blended taste-profile query result",
      detail:
        "Surfaced from your combined confirmed anchors in a blended Qloo query. Not attributed to any single anchor.",
      anchorAttributions: [],
      alsoInBlendedQuery: true,
      categoryMatchLabel,
      honestyDisclaimer: null,
    };
  }

  return {
    distinctionKind: "exploratory-broad",
    headline:
      rec.queryMode === "mixed"
        ? "Broad & blended taste-query suggestion"
        : "Exploratory taste-query suggestion",
    detail:
      "Passed entity validation from a broader or lower-ranked Qloo query outside the top-10 single-anchor connection threshold.",
    anchorAttributions: [],
    alsoInBlendedQuery,
    categoryMatchLabel,
    honestyDisclaimer: null,
  };
}

// ── 3. Practical venue details & explicit unknowns ──────────

export interface PracticalDetailsView {
  neighborhood: string | null;
  address: string | null;
  locationLine: string | null;
  websiteUrl: string | null;
  websiteDisplay: string | null;
  phone: string | null;
  priceTier: string | null;
  mappable: boolean;
  coordinates: { lat: number; lon: number } | null;
  supportingTags: string[];
  unavailableFields: string[];
  hasAnyPracticalDetail: boolean;
}

function cleanOptionalText(val: string | null | undefined): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeDisplayWebsite(raw: string | null | undefined): {
  url: string;
  display: string;
} | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.replace(/^www\./i, "");
    const path =
      parsed.pathname && parsed.pathname !== "/"
        ? parsed.pathname.replace(/\/$/, "")
        : "";
    const display = `${host}${path}`.slice(0, 48);
    return { url: parsed.toString(), display: display || host };
  } catch {
    return null;
  }
}

export function formatPriceTier(priceLevel: number | null | undefined): string | null {
  if (
    typeof priceLevel !== "number" ||
    !Number.isFinite(priceLevel) ||
    priceLevel < 1
  ) {
    return null;
  }
  const clamped = Math.min(Math.floor(priceLevel), 4);
  return clamped >= 1 ? "$".repeat(clamped) : null;
}

export function isMappableRecommendation(
  rec: Pick<SafeRecommendationItem, "mappable" | "location">,
): boolean {
  if (!rec.mappable || !rec.location) return false;
  return isValidCoordinate(rec.location.lat, rec.location.lon);
}

export function buildPracticalDetailsView(
  rec: SafeRecommendationItem,
): PracticalDetailsView {
  const neighborhood = cleanOptionalText(rec.neighborhood);
  const address = cleanOptionalText(rec.address);
  const locationLine =
    neighborhood && address
      ? `${neighborhood} · ${address}`
      : neighborhood ?? address ?? null;

  const site = sanitizeDisplayWebsite(rec.website);
  const phone = cleanOptionalText(rec.phone);
  const priceTier = formatPriceTier(rec.priceLevel);
  const mappable = isMappableRecommendation(rec);
  const coordinates =
    mappable && rec.location
      ? { lat: rec.location.lat, lon: rec.location.lon }
      : null;

  const categoryLowerSet = new Set(
    (rec.categories ?? []).map((c) => c.trim().toLowerCase()),
  );
  const supportingTags: string[] = [];
  const seenTagNames = new Set<string>();
  for (const tag of rec.tags ?? []) {
    if (tag.id.startsWith("urn:tag:category:place:")) continue;
    const tagName = cleanOptionalText(tag.name);
    if (!tagName) continue;
    const key = tagName.toLowerCase();
    if (categoryLowerSet.has(key) || seenTagNames.has(key)) continue;
    seenTagNames.add(key);
    supportingTags.push(tagName);
  }

  const unavailableFields: string[] = [];
  if (!address && !neighborhood) {
    unavailableFields.push("Address & neighborhood");
  } else if (!address) {
    unavailableFields.push("Street address");
  } else if (!neighborhood) {
    unavailableFields.push("Neighborhood");
  }
  if (!site) unavailableFields.push("Website");
  if (!phone) unavailableFields.push("Phone");
  if (!priceTier) unavailableFields.push("Price level");
  unavailableFields.push("Opening hours");
  unavailableFields.push("Ratings");
  if (!mappable) unavailableFields.push("Map coordinates");

  const hasAnyPracticalDetail = Boolean(
    locationLine || site || phone || priceTier,
  );

  return {
    neighborhood,
    address,
    locationLine,
    websiteUrl: site?.url ?? null,
    websiteDisplay: site?.display ?? null,
    phone,
    priceTier,
    mappable,
    coordinates,
    supportingTags: supportingTags.slice(0, 6),
    unavailableFields,
    hasAnyPracticalDetail,
  };
}

// ── 4. Category grouping without entity duplication ─────────

export const UNCATEGORIZED_GROUP_KEY = "__uncategorized__";
export const UNCATEGORIZED_GROUP_TITLE = "Uncategorized places";

export interface CategoryRecommendationGroup {
  key: string;
  title: string;
  isUncategorized: boolean;
  items: SafeRecommendationItem[];
}

export function groupRecommendationsByCategory(
  recommendations: readonly SafeRecommendationItem[],
): CategoryRecommendationGroup[] {
  const seenEntityIds = new Set<string>();
  const groupMap = new Map<string, CategoryRecommendationGroup>();
  let uncategorizedGroup: CategoryRecommendationGroup | null = null;

  for (const rec of recommendations) {
    if (!rec || typeof rec.entityId !== "string" || !rec.entityId.trim()) {
      continue;
    }
    // Never duplicate an entity record across or within category groups
    if (seenEntityIds.has(rec.entityId)) {
      continue;
    }
    seenEntityIds.add(rec.entityId);

    const validCategories = (rec.categories ?? [])
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter((c) => c.length > 0);

    if (validCategories.length === 0) {
      if (!uncategorizedGroup) {
        uncategorizedGroup = {
          key: UNCATEGORIZED_GROUP_KEY,
          title: UNCATEGORIZED_GROUP_TITLE,
          isUncategorized: true,
          items: [],
        };
      }
      uncategorizedGroup.items.push(rec);
      continue;
    }

    // Group by the entity's first Qloo place-category tag for display; secondary Qloo
    // category tags remain on rec.categories so the card displays all Qloo category tags without duplicating the entity.
    const primaryCategory = validCategories[0];
    const normalizedKey = primaryCategory.toLowerCase();

    let group = groupMap.get(normalizedKey);
    if (!group) {
      group = {
        key: normalizedKey,
        title: primaryCategory,
        isUncategorized: false,
        items: [],
      };
      groupMap.set(normalizedKey, group);
    }
    group.items.push(rec);
  }

  const orderedGroups = [...groupMap.values()];
  if (uncategorizedGroup && uncategorizedGroup.items.length > 0) {
    orderedGroups.push(uncategorizedGroup);
  }

  return orderedGroups;
}

// ── 5. Map markers, bounds, and synchronized selection ──────

export interface MapMarkerItem {
  entityId: string;
  orderIndex: number;
  name: string;
  lat: number;
  lon: number;
  label: RecommendationLabel;
  badgeText: string;
  symbol: string;
  categories: string[];
  locationLine: string | null;
}

export type MapViewportSpec =
  | { mode: "empty" }
  | { mode: "single"; center: { lat: number; lon: number }; zoom: number }
  | {
      mode: "bounds";
      southWest: { lat: number; lon: number };
      northEast: { lat: number; lon: number };
    };

export function extractMapMarkers(
  recommendations: readonly SafeRecommendationItem[],
): MapMarkerItem[] {
  const markers: MapMarkerItem[] = [];
  const seenEntityIds = new Set<string>();

  for (const rec of recommendations) {
    if (!rec || typeof rec.entityId !== "string" || !rec.entityId.trim()) {
      continue;
    }
    if (seenEntityIds.has(rec.entityId)) continue;

    if (!isMappableRecommendation(rec) || !rec.location) {
      continue;
    }

    const { lat, lon } = rec.location;
    if (!isValidCoordinate(lat, lon)) {
      continue;
    }

    seenEntityIds.add(rec.entityId);
    const presentation = getLabelPresentation(rec.label);
    const neighborhood = cleanOptionalText(rec.neighborhood);
    const address = cleanOptionalText(rec.address);
    const locationLine =
      neighborhood && address
        ? `${neighborhood} · ${address}`
        : neighborhood ?? address ?? null;

    markers.push({
      entityId: rec.entityId,
      orderIndex: markers.length + 1,
      name: rec.name,
      lat,
      lon,
      label: rec.label,
      badgeText: presentation.badgeText,
      symbol: presentation.symbol,
      categories: (rec.categories ?? []).filter(
        (c) => typeof c === "string" && c.trim().length > 0,
      ),
      locationLine,
    });
  }

  return markers;
}

export function computeMapBounds(
  markers: readonly MapMarkerItem[],
): MapViewportSpec {
  const valid = markers.filter((m) => isValidCoordinate(m.lat, m.lon));
  if (valid.length === 0) {
    return { mode: "empty" };
  }

  if (valid.length === 1) {
    return {
      mode: "single",
      center: { lat: valid[0].lat, lon: valid[0].lon },
      zoom: 14,
    };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const m of valid) {
    if (m.lat < minLat) minLat = m.lat;
    if (m.lat > maxLat) maxLat = m.lat;
    if (m.lon < minLon) minLon = m.lon;
    if (m.lon > maxLon) maxLon = m.lon;
  }

  // If all markers share virtually identical coordinates, use single-point center
  if (Math.abs(maxLat - minLat) < 1e-5 && Math.abs(maxLon - minLon) < 1e-5) {
    return {
      mode: "single",
      center: { lat: valid[0].lat, lon: valid[0].lon },
      zoom: 14,
    };
  }

  return {
    mode: "bounds",
    southWest: { lat: minLat, lon: minLon },
    northEast: { lat: maxLat, lon: maxLon },
  };
}

export interface SelectionState {
  selectedEntityId: string | null;
  selectedRecommendation: SafeRecommendationItem | null;
  selectedMarker: MapMarkerItem | null;
  selectedIsMappable: boolean;
}

export function resolveSelectionState(
  recommendations: readonly SafeRecommendationItem[],
  selectedEntityId: string | null,
): SelectionState {
  if (!selectedEntityId) {
    return {
      selectedEntityId: null,
      selectedRecommendation: null,
      selectedMarker: null,
      selectedIsMappable: false,
    };
  }

  const rec =
    recommendations.find((r) => r.entityId === selectedEntityId) ?? null;
  if (!rec) {
    return {
      selectedEntityId: null,
      selectedRecommendation: null,
      selectedMarker: null,
      selectedIsMappable: false,
    };
  }

  const markers = extractMapMarkers(recommendations);
  const marker = markers.find((m) => m.entityId === rec.entityId) ?? null;

  return {
    selectedEntityId: rec.entityId,
    selectedRecommendation: rec,
    selectedMarker: marker,
    selectedIsMappable: marker !== null,
  };
}
