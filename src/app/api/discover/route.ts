import { searchEntity } from "@/lib/qloo/client";
import { resolveEntityFromResults } from "@/lib/qloo/resolver";
import type { ResolveResult } from "@/lib/qloo/resolver";
import { discover } from "@/lib/discover";
import type { DiscoveryResult, CulturalAnchor } from "@/lib/discover";
import { assignLabel } from "@/lib/recommend";
import type { Recommendation } from "@/lib/recommend";
import { MUMBAI_NEWCOMER } from "@/lib/discover/demo-profile";
import type { DemoAnchorSpec } from "@/lib/discover/demo-profile";

// --- Response types (sent to the client) ---

export interface AnchorResolution {
  query: string;
  type: string;
  status: "resolved" | "ambiguous" | "not_found" | "error";
  resolved?: { entityId: string; name: string; disambiguation?: string };
  ambiguousCount?: number;
  error?: string;
}

export interface VenueDetails {
  category: string | null;
  address: string | null;
  neighborhood: string | null;
  website: string | null;
  phone: string | null;
  priceLevel: number | null;
}

export interface RecommendationWithVenue extends Recommendation {
  venue: VenueDetails;
}

export interface DiscoverApiResponse {
  profile: { name: string; city: string; description: string };
  resolutions: AnchorResolution[];
  recommendations: RecommendationWithVenue[];
  reviewCount: number;
  rejectedCount: number;
  rejectedReasons: Record<string, number>;
  failures: { queryId: string; error: string }[];
  budget: { queriesUsed: number; queriesBudget: number; totalResults: number };
}

// --- Resolution ---

async function resolveAnchor(
  spec: DemoAnchorSpec,
): Promise<{ resolution: AnchorResolution; anchor?: CulturalAnchor }> {
  try {
    const searchResult = await searchEntity(spec.query);
    const resolved: ResolveResult = resolveEntityFromResults(
      searchResult.data.results,
      spec.type,
    );

    if (resolved.status === "resolved") {
      return {
        resolution: {
          query: spec.query,
          type: spec.type,
          status: "resolved",
          resolved: {
            entityId: resolved.entity.entityId,
            name: resolved.entity.name,
            disambiguation: resolved.entity.disambiguation,
          },
        },
        anchor: {
          entityId: resolved.entity.entityId,
          name: resolved.entity.name,
        },
      };
    }

    if (resolved.status === "ambiguous") {
      return {
        resolution: {
          query: spec.query,
          type: spec.type,
          status: "ambiguous",
          ambiguousCount: resolved.candidates.length,
        },
      };
    }

    return {
      resolution: { query: spec.query, type: spec.type, status: "not_found" },
    };
  } catch (err) {
    return {
      resolution: {
        query: spec.query,
        type: spec.type,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// --- Handler ---

export async function POST(): Promise<Response> {
  try {
    const profile = MUMBAI_NEWCOMER;
    const resolveResults = await Promise.all(
      profile.anchors.map(resolveAnchor),
    );

    const resolutions = resolveResults.map((r) => r.resolution);
    const anchors = resolveResults
      .map((r) => r.anchor)
      .filter((a): a is CulturalAnchor => a != null);

    if (anchors.length === 0) {
      const body: DiscoverApiResponse = {
        profile: {
          name: profile.name,
          city: profile.city,
          description: profile.description,
        },
        resolutions,
        recommendations: [],
        reviewCount: 0,
        rejectedCount: 0,
        rejectedReasons: {},
        failures: [],
        budget: { queriesUsed: 0, queriesBudget: 0, totalResults: 0 },
      };
      return Response.json(body);
    }

    const discoveryResult: DiscoveryResult = await discover({
      anchors,
      city: profile.city,
    });

    const recommendations: RecommendationWithVenue[] = [];
    for (const candidate of discoveryResult.accepted) {
      const rec = assignLabel(candidate);
      if (!rec) continue;

      const tags = candidate.entity.tags ?? [];
      const categoryTag = tags.find((t) =>
        t.id.startsWith("urn:tag:category:place:"),
      );
      const props = candidate.entity.properties;

      recommendations.push({
        ...rec,
        venue: {
          category: categoryTag?.name ?? null,
          address: props?.address ?? null,
          neighborhood: props?.neighborhood ?? null,
          website: props?.website ?? null,
          phone: props?.phone ?? null,
          priceLevel: props?.price_level ?? null,
        },
      });
    }

    const rejectedReasons: Record<string, number> = {};
    for (const r of discoveryResult.rejected) {
      const reason = r.validation.reason ?? "unknown";
      rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
    }

    const body: DiscoverApiResponse = {
      profile: {
        name: profile.name,
        city: profile.city,
        description: profile.description,
      },
      resolutions,
      recommendations,
      reviewCount: discoveryResult.review.length,
      rejectedCount: discoveryResult.rejected.length,
      rejectedReasons,
      failures: discoveryResult.failures.map((f) => ({
        queryId: f.queryId,
        error: f.error,
      })),
      budget: discoveryResult.budget,
    };

    return Response.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: "Discovery failed", detail: message },
      { status: 500 },
    );
  }
}
