import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchEntity, clearCache } from "../lib/qloo/client";

const originalFetch = globalThis.fetch;
const FAKE_API_KEY = "test-qloo-key";

function installApiKey(): string | undefined {
  const prev = process.env.QLOO_API_KEY;
  process.env.QLOO_API_KEY = FAKE_API_KEY;
  return prev;
}

function restoreApiKey(prev: string | undefined): void {
  if (prev === undefined) delete process.env.QLOO_API_KEY;
  else process.env.QLOO_API_KEY = prev;
}

const VALID_SEARCH_BODY = JSON.stringify({
  results: [
    {
      entity_id: "ent-1",
      name: "Test Entity",
      types: ["urn:entity:artist"],
    },
  ],
});

describe("Qloo client — cancellation", () => {
  let prevKey: string | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearCache();
    if (prevKey !== undefined || process.env.QLOO_API_KEY === FAKE_API_KEY) {
      restoreApiKey(prevKey);
    }
  });

  it("rejects immediately with pre-aborted signal, never calls fetch", async () => {
    prevKey = installApiKey();
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(VALID_SEARCH_BODY, { status: 200 });
    };

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () => searchEntity("test", 10, ac.signal),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(fetchCalled, false);
  });

  it("aborts in-flight fetch when signal fires mid-request", async () => {
    prevKey = installApiKey();
    let fetchCallCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(new Response(VALID_SEARCH_BODY, { status: 200 }));
        }, 500);
      });
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await assert.rejects(
      () => searchEntity("test", 10, ac.signal),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(fetchCallCount, 1);
  });

  it("does not retry after abort — only one fetch attempt", async () => {
    prevKey = installApiKey();
    let fetchCallCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Response("Server Error", { status: 500 });
    };

    const ac = new AbortController();
    // Abort shortly after first attempt starts — should prevent retry backoff
    setTimeout(() => ac.abort(), 20);

    await assert.rejects(
      () => searchEntity("test", 10, ac.signal),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    // Without abort, MAX_RETRIES=2 would cause 3 attempts. With abort, at most 1.
    assert.ok(fetchCallCount <= 1, `Expected at most 1 fetch call, got ${fetchCallCount}`);
  });

  it("does not cache result from aborted request", async () => {
    prevKey = installApiKey();
    let fetchCallCount = 0;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (fetchCallCount === 1) {
        // First call: slow, will be aborted
        return new Promise<Response>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(new Response(VALID_SEARCH_BODY, { status: 200 }));
          }, 500);
        });
      }
      // Second call: fast, succeeds
      return new Response(VALID_SEARCH_BODY, { status: 200 });
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    await assert.rejects(
      () => searchEntity("same-query", 10, ac.signal),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    // Second call with no signal should hit the network, not cache
    const result = await searchEntity("same-query", 10);
    assert.equal(result.meta.cached, false);
    assert.equal(fetchCallCount, 2);
  });

  it("aborts during retry backoff sleep", async () => {
    prevKey = installApiKey();
    let fetchCallCount = 0;
    const start = Date.now();

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      // Always return 500 to trigger retry
      return new Response("Server Error", { status: 500 });
    };

    const ac = new AbortController();
    // Abort 100ms in — first fetch is instant (returns 500), then INITIAL_BACKOFF_MS=500 starts.
    // Abort should interrupt the 500ms backoff.
    setTimeout(() => ac.abort(), 100);

    await assert.rejects(
      () => searchEntity("test", 10, ac.signal),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    const elapsed = Date.now() - start;
    // Without abort, the full backoff would take 500ms+. With abort, under 200ms.
    assert.ok(elapsed < 400, `Expected abort to cut backoff short, took ${elapsed}ms`);
    assert.equal(fetchCallCount, 1);
  });
});
