import {
  SearchResponseSchema,
  InsightsResponseSchema,
  TagsResponseSchema,
} from "./schemas";
import type {
  SearchResponse,
  InsightsResponse,
  TagsResponse,
} from "./schemas";

const BASE_URL = "https://hackathon.api.qloo.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function cacheKey(path: string, params: Record<string, string>): string {
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${path}?${sorted}`;
}

function getCached<T>(key: string): { data: T; cached: true } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { data: entry.data as T, cached: true };
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getApiKey(): string {
  const key = process.env.QLOO_API_KEY;
  if (!key) throw new Error("QLOO_API_KEY environment variable is not set");
  return key;
}

export class QlooApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`Qloo API ${path} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "QlooApiError";
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function callApi(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(signal);

    if (attempt > 0) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await abortableSleep(backoff, signal);
    }

    try {
      const res = await fetchWithTimeout(
        url.toString(),
        { headers: { "X-Api-Key": getApiKey() } },
        REQUEST_TIMEOUT_MS,
        signal,
      );

      if (res.status >= 500 || res.status === 429) {
        lastError = new QlooApiError(res.status, path, await res.text());
        continue;
      }

      if (!res.ok) {
        throw new QlooApiError(res.status, path, await res.text());
      }

      return await res.json();
    } catch (e) {
      if (isAbortError(e)) throw e;
      throwIfAborted(signal);
      if (e instanceof QlooApiError && e.status < 500 && e.status !== 429) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError ?? new Error(`Qloo API ${path} failed after retries`);
}

export interface QlooCallMeta {
  path: string;
  params: Record<string, string>;
  cached: boolean;
}

export interface QlooResult<T> {
  data: T;
  meta: QlooCallMeta;
}

async function cachedCall<T>(
  path: string,
  params: Record<string, string>,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<QlooResult<T>> {
  const key = cacheKey(path, params);
  const hit = getCached<T>(key);
  if (hit) {
    return { data: hit.data, meta: { path, params, cached: true } };
  }

  const raw = await callApi(path, params, signal);
  const data = parse(raw);
  setCache(key, data);
  return { data, meta: { path, params, cached: false } };
}

export async function searchEntity(
  query: string,
  take: number = 10,
  signal?: AbortSignal,
): Promise<QlooResult<SearchResponse>> {
  return cachedCall(
    "/search",
    { query, take: String(take) },
    (raw) => SearchResponseSchema.parse(raw),
    signal,
  );
}

export interface InsightsParams {
  anchors: string[];
  city: string;
  tagId?: string;
  take?: number;
  explainability?: boolean;
}

export async function insights(
  params: InsightsParams,
  signal?: AbortSignal,
): Promise<QlooResult<InsightsResponse>> {
  const query: Record<string, string> = {
    "filter.type": "urn:entity:place",
    "filter.location.query": params.city,
    take: String(params.take ?? 10),
  };

  if (params.anchors.length > 0) {
    query["signal.interests.entities"] = params.anchors.join(",");
  }

  if (params.tagId) {
    query["filter.tags"] = params.tagId;
  }

  if (params.explainability !== false) {
    query["feature.explainability"] = "true";
  }

  return cachedCall(
    "/v2/insights",
    query,
    (raw) => InsightsResponseSchema.parse(raw),
    signal,
  );
}

export async function searchTags(
  query: string,
  take: number = 5,
  signal?: AbortSignal,
): Promise<QlooResult<TagsResponse>> {
  return cachedCall(
    "/v2/tags",
    { "filter.query": query, take: String(take) },
    (raw) => TagsResponseSchema.parse(raw),
    signal,
  );
}

export function clearCache(): void {
  cache.clear();
}
