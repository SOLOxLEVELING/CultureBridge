import type { Tool } from "@aws-sdk/client-bedrock-runtime";

// --- Argument types ---

export interface ResolveAnchorArgs {
  query: string;
  type: string;
}

export interface DiscoverPlacesArgs {
  anchor_ids: string[];
  anchor_names: string[];
  city: string;
  category_tag_id?: string;
}

export interface FindTagsArgs {
  query: string;
}

export interface FinalizeArgs {
  summary: string;
  recommendation_ids: string[];
}

// --- Tool name constants ---

export const TOOL_NAMES = {
  RESOLVE_ANCHOR: "resolve_anchor",
  DISCOVER_PLACES: "discover_places",
  FIND_TAGS: "find_tags",
  FINALIZE: "finalize",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// --- Tool specifications for Bedrock Converse API ---

const RESOLVE_ANCHOR_SPEC: Tool = {
  toolSpec: {
    name: TOOL_NAMES.RESOLVE_ANCHOR,
    description:
      "Resolve a cultural anchor (artist, movie, TV show, etc.) to a Qloo entity ID via type-aware search. Returns resolved, ambiguous, or not_found. Never silently selects an ambiguous entity.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The name to search for, e.g. 'Radiohead' or 'Slumdog Millionaire'.",
          },
          type: {
            type: "string",
            description:
              "The Qloo entity type URN, e.g. 'urn:entity:artist', 'urn:entity:movie', 'urn:entity:tv_show'.",
          },
        },
        required: ["query", "type"],
      },
    },
  },
};

const DISCOVER_PLACES_SPEC: Tool = {
  toolSpec: {
    name: TOOL_NAMES.DISCOVER_PLACES,
    description:
      "Discover places in a city using one or more resolved cultural anchors as taste signals. With one anchor, runs a single-anchor Qloo query. With multiple anchors, runs individual single-anchor queries plus a blended query. Results are automatically validated and categorized as accepted, review, or rejected. Accepted results receive deterministic recommendation labels.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          anchor_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of resolved Qloo entity IDs to use as taste signals. Use IDs from resolve_anchor results only.",
            minItems: 1,
            maxItems: 5,
          },
          anchor_names: {
            type: "array",
            items: { type: "string" },
            description:
              "Human-readable names corresponding to each anchor_id, in the same order.",
            minItems: 1,
            maxItems: 5,
          },
          city: {
            type: "string",
            description: "The destination city, e.g. 'Berlin'.",
          },
          category_tag_id: {
            type: "string",
            description:
              "Optional Qloo category tag ID to filter results, e.g. 'urn:tag:category:place:cafe'. Use find_tags to discover valid IDs.",
          },
        },
        required: ["anchor_ids", "anchor_names", "city"],
      },
    },
  },
};

const FIND_TAGS_SPEC: Tool = {
  toolSpec: {
    name: TOOL_NAMES.FIND_TAGS,
    description:
      "Search for Qloo category tags by keyword. Returns tag IDs and names that can be used as the category_tag_id in discover_places. Never invent a tag ID.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search keyword for the category, e.g. 'cafe', 'live music', 'record store'.",
          },
        },
        required: ["query"],
      },
    },
  },
};

const FINALIZE_SPEC: Tool = {
  toolSpec: {
    name: TOOL_NAMES.FINALIZE,
    description:
      "Signal that the discovery process is complete. Provide a short summary of what was discovered and the entity IDs of recommended places. This tool ends the agent loop.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "A brief summary of the discovery run and its results for the user.",
          },
          recommendation_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "The entity IDs of accepted places to include in the final recommendation set. Must only contain IDs that were returned as accepted by discover_places.",
          },
        },
        required: ["summary", "recommendation_ids"],
      },
    },
  },
};

export const ALL_TOOL_SPECS: Tool[] = [
  RESOLVE_ANCHOR_SPEC,
  DISCOVER_PLACES_SPEC,
  FIND_TAGS_SPEC,
  FINALIZE_SPEC,
];
