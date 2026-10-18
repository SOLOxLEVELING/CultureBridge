import type { SearchEntity } from "./schemas";

export interface ResolvedEntity {
  entityId: string;
  name: string;
  requestedType: string;
  disambiguation: string | undefined;
}

export type ResolveResult =
  | { status: "resolved"; entity: ResolvedEntity }
  | { status: "ambiguous"; candidates: ResolvedEntity[] }
  | { status: "not_found"; requestedType: string };

export function resolveEntityFromResults(
  results: SearchEntity[],
  requestedType: string,
): ResolveResult {
  const typeMatches = results.filter((r) => r.types.includes(requestedType));

  if (typeMatches.length === 0) {
    return { status: "not_found", requestedType };
  }

  const deduped = new Map<string, SearchEntity>();
  for (const match of typeMatches) {
    if (!deduped.has(match.entity_id)) {
      deduped.set(match.entity_id, match);
    }
  }

  const unique = [...deduped.values()];

  const toResolved = (e: SearchEntity): ResolvedEntity => ({
    entityId: e.entity_id,
    name: e.name,
    requestedType,
    disambiguation: e.disambiguation || undefined,
  });

  if (unique.length === 1) {
    return { status: "resolved", entity: toResolved(unique[0]) };
  }

  return { status: "ambiguous", candidates: unique.map(toResolved) };
}
