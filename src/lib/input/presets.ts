import { z } from "zod";

// ── Supported Qloo anchor entity types ───────────────────────

export const SUPPORTED_ANCHOR_TYPES = [
  "urn:entity:artist",
  "urn:entity:tv_show",
  "urn:entity:movie",
  "urn:entity:brand",
  "urn:entity:person",
] as const;

export type SupportedAnchorType = (typeof SUPPORTED_ANCHOR_TYPES)[number];

export const SupportedAnchorTypeSchema = z.enum(SUPPORTED_ANCHOR_TYPES, {
  error: "Unsupported anchor entity type.",
});

export const ANCHOR_TYPE_META: Record<
  SupportedAnchorType,
  { label: string; pluralLabel: string; placeholder: string }
> = {
  "urn:entity:artist": {
    label: "Artist",
    pluralLabel: "Artists",
    placeholder: "e.g. Radiohead, Arijit Singh, Björk",
  },
  "urn:entity:tv_show": {
    label: "TV show",
    pluralLabel: "TV shows",
    placeholder: "e.g. The Office, The Bear",
  },
  "urn:entity:movie": {
    label: "Movie",
    pluralLabel: "Movies",
    placeholder: "e.g. Slumdog Millionaire, Past Lives",
  },
  "urn:entity:brand": {
    label: "Brand",
    pluralLabel: "Brands",
    placeholder: "e.g. Zara, A24, Vogue",
  },
  "urn:entity:person": {
    label: "Person",
    pluralLabel: "People",
    placeholder: "e.g. Anthony Bourdain",
  },
};

export function formatAnchorType(type: string): string {
  if (type in ANCHOR_TYPE_META) {
    return ANCHOR_TYPE_META[type as SupportedAnchorType].label;
  }
  return type.replace(/^urn:entity:/, "").replace(/_/g, " ");
}

export function isSupportedAnchorType(type: string): type is SupportedAnchorType {
  return (SUPPORTED_ANCHOR_TYPES as readonly string[]).includes(type);
}

// ── Tested destination cities ────────────────────────────────

export const TESTED_CITIES = ["Berlin", "Toronto"] as const;

export type TestedCity = (typeof TESTED_CITIES)[number];

export const DEFAULT_CITY: TestedCity = "Berlin";

export const CITY_META: Record<
  TestedCity,
  { name: TestedCity; country: string; note: string }
> = {
  Berlin: {
    name: "Berlin",
    country: "Germany",
    note: "Neighborhoods across Mitte, Kreuzberg, Neukölln, and Friedrichshain.",
  },
  Toronto: {
    name: "Toronto",
    country: "Canada",
    note: "Neighborhoods across Downtown, Queen West, Kensington, and the Annex.",
  },
};

export const CitySelectionSchema = z
  .string()
  .trim()
  .min(1, "City is required.")
  .max(100, "City must be 100 characters or fewer.");

export function isTestedCity(city: string): city is TestedCity {
  return (TESTED_CITIES as readonly string[]).includes(city);
}

// ── Constraints ──────────────────────────────────────────────

// Matches discover_places maxItems (5) and KitRequestSchema confirmedAnchors.max(5)
export const MAX_TRUSTED_ANCHORS = 5;

// ── Persona preset definitions ───────────────────────────────
// Data-driven preset seeds. Notice that presets only specify
// query + type — NEVER a pre-confirmed Qloo entity ID. Every
// preset anchor must go through real server-side Qloo search
// and explicit user confirmation.

export type PresetId =
  | "mumbai-newcomer"
  | "art-indie"
  | "food-fashion"
  | "custom";

export interface PresetAnchorSeed {
  query: string;
  type: SupportedAnchorType;
}

export interface PersonaPreset {
  id: PresetId;
  name: string;
  tagline: string;
  description: string;
  isDefault: boolean;
  anchors: readonly PresetAnchorSeed[];
}

export const DEFAULT_PRESET_ID: PresetId = "mumbai-newcomer";

export const PERSONA_PRESETS: readonly PersonaPreset[] = [
  {
    id: "mumbai-newcomer",
    name: "Mumbai newcomer",
    tagline: "Playback, alt-rock, workplace comedy, high-street style",
    description:
      "Blends Hindi playback music and British alternative rock with a classic sitcom and everyday fashion.",
    isDefault: true,
    anchors: [
      { query: "Arijit Singh", type: "urn:entity:artist" },
      { query: "The Office", type: "urn:entity:tv_show" },
      { query: "Radiohead", type: "urn:entity:artist" },
      { query: "Zara", type: "urn:entity:brand" },
    ],
  },
  {
    id: "art-indie",
    name: "Art & indie",
    tagline: "Experimental music and independent cinema",
    description:
      "Built around art-rock, avant-garde electronic music, and independent film production.",
    isDefault: false,
    anchors: [
      { query: "Radiohead", type: "urn:entity:artist" },
      { query: "Björk", type: "urn:entity:artist" },
      { query: "A24", type: "urn:entity:brand" },
    ],
  },
  {
    id: "food-fashion",
    name: "Food & fashion",
    tagline: "Culinary culture, travel writing, editorial style",
    description:
      "Combines kitchen storytelling and food travel with fashion journalism and retail.",
    isDefault: false,
    anchors: [
      { query: "The Bear", type: "urn:entity:tv_show" },
      { query: "Anthony Bourdain", type: "urn:entity:person" },
      { query: "Vogue", type: "urn:entity:brand" },
      { query: "Zara", type: "urn:entity:brand" },
    ],
  },
  {
    id: "custom",
    name: "Custom",
    tagline: "Your own cultural anchors",
    description:
      "Start with a blank slate and add up to five artists, shows, movies, brands, or people you already know.",
    isDefault: false,
    anchors: [],
  },
] as const;

export function getPresetById(id: PresetId): PersonaPreset {
  const found = PERSONA_PRESETS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Unknown preset ID: ${id}`);
  }
  return found;
}
