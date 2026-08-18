/**
 * ModelCatalog must never let a network problem break agent routing —
 * these tests exercise the fetch/cache/fallback/cooldown behavior with an
 * injected fetch implementation, no real network access required.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ModelCatalog } from "../../src/providers/ModelCatalog.js";

function fakeCatalogResponse() {
  return {
    anthropic: {
      models: {
        "claude-sonnet-4-6": {
          limit: { context: 200000 },
          cost: { input: 3, output: 15 },
        },
        "claude-haiku-4-5-20251001": {
          limit: { context: 200000 },
          cost: { input: 0.8, output: 4 },
        },
      },
    },
    // An entry with no parseable numeric fields should be skipped, not crash.
    mystery: { models: { "weird-model": { note: "no numbers here" } } },
  };
}

function mockFetch(
  status: number,
  body: unknown,
  { throws = false, delayMs = 0 }: { throws?: boolean; delayMs?: number } = {},
): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    if (throws) throw new Error("network down");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("ModelCatalog", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("fetches, normalizes, and caches a successful response", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(200, fakeCatalogResponse()),
    });

    const model = await catalog.getModel("claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model?.contextLength).toBe(200000);
    expect(model?.costInputPerM).toBe(3);
    expect(model?.costOutputPerM).toBe(15);
  });

  it("skips entries with no parseable numeric fields instead of returning garbage", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(200, fakeCatalogResponse()),
    });

    const model = await catalog.getModel("weird-model");
    expect(model).toBeUndefined();
  });

  it("writes a disk cache after a successful fetch", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(200, fakeCatalogResponse()),
    });
    await catalog.getAll();

    const raw = JSON.parse(
      readFileSync(join(dir, ".claude", "models-catalog.json"), "utf-8"),
    );
    expect(raw.models["claude-sonnet-4-6"].contextLength).toBe(200000);
    expect(typeof raw.fetchedAt).toBe("number");
  });

  it("falls back to undefined (never throws) when the endpoint 404s", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(404, {}),
    });

    await expect(catalog.getModel("anything")).resolves.toBeUndefined();
  });

  it("falls back to undefined (never throws) when fetch itself rejects", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(200, {}, { throws: true }),
    });

    await expect(catalog.getModel("anything")).resolves.toBeUndefined();
  });

  it("aborts and falls back when the fetch exceeds fetchTimeoutMs", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, {
      fetchImpl: mockFetch(200, fakeCatalogResponse(), { delayMs: 200 }),
      fetchTimeoutMs: 20,
    });

    const start = Date.now();
    const result = await catalog.getModel("claude-sonnet-4-6");
    expect(result).toBeUndefined();
    // Should resolve close to the timeout, not the full 200ms delay.
    expect(Date.now() - start).toBeLessThan(150);
  });

  it("prefers a stale on-disk cache over an empty result when the fetch fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const cacheDir = join(dir, ".claude");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "models-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days old — well past any TTL
        models: { "stale-model": { contextLength: 4096, costInputPerM: 1, costOutputPerM: 2 } },
      }),
    );

    const catalog = new ModelCatalog(dir, { fetchImpl: mockFetch(500, {}) });
    const result = await catalog.getModel("stale-model");
    expect(result?.contextLength).toBe(4096);
  });

  it("does not re-attempt a fetch on every call within the failure cooldown", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    let callCount = 0;
    const failingFetch = (async () => {
      callCount++;
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const catalog = new ModelCatalog(dir, {
      fetchImpl: failingFetch,
      fetchTimeoutMs: 50, // cooldown = fetchTimeoutMs * 20 = 1000ms
    });

    await catalog.getAll();
    await catalog.getAll();
    await catalog.getAll();

    expect(callCount).toBe(1);
  });

  it("returns an empty map (not a throw) with no cache and no reachable endpoint", async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
    const catalog = new ModelCatalog(dir, { fetchImpl: mockFetch(500, {}) });
    const all = await catalog.getAll();
    expect(all).toEqual({});
  });
});
