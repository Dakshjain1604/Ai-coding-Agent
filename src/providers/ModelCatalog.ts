/**
 * Model Catalog - fetches and caches model capability/pricing data from a
 * public catalog (models.dev-style: https://models.dev/api.json) instead of
 * relying solely on a hand-maintained table.
 *
 * `ModelRouter`'s hardcoded `MODEL_SPECS` remains the offline fallback —
 * this class never throws and never returns malformed data; on any
 * network failure, timeout, or unparseable response it simply returns
 * nothing for the caller to fall back on. The exact upstream JSON shape is
 * not something this codebase controls, so parsing is deliberately
 * defensive: entries that don't fit the expected numeric fields are
 * skipped rather than propagated as garbage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getLogger } from "../utils/logger.js";

export interface ModelCapability {
  contextLength: number;
  /** Approximate cost in USD per million input tokens (0 for free/local models). */
  costInputPerM: number;
  /** Approximate cost in USD per million output tokens (0 for free/local models). */
  costOutputPerM: number;
}

export interface ModelCatalogConfig {
  /** Catalog endpoint. Defaults to models.dev's public API. */
  url?: string;
  /** Where the on-disk cache lives. Defaults to `<projectRoot>/.claude/models-catalog.json`. */
  cachePath?: string;
  /** How long a successful fetch stays fresh before re-fetching. Default 24h. */
  ttlMs?: number;
  /** Abort the fetch if it hasn't resolved within this long. Default 3s. */
  fetchTimeoutMs?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface CacheFile {
  fetchedAt: number;
  models: Record<string, ModelCapability>;
}

const DEFAULT_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3000;

/** Pull a finite, non-negative number out of one of several plausible field names. */
function pickNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Best-effort normalization of one catalog entry into our shape. Returns
 * undefined (skip this entry) if it doesn't have parseable numeric fields
 * — never guesses, never throws.
 */
function normalizeEntry(raw: unknown): ModelCapability | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;

  // models.dev nests limits/cost; tolerate both nested and flat shapes.
  const limit =
    typeof entry.limit === "object" && entry.limit !== null
      ? (entry.limit as Record<string, unknown>)
      : entry;
  const cost =
    typeof entry.cost === "object" && entry.cost !== null
      ? (entry.cost as Record<string, unknown>)
      : entry;

  const contextLength = pickNumber(limit, [
    "context",
    "contextLength",
    "context_length",
    "contextWindow",
    "context_window",
  ]);
  if (contextLength === undefined) return undefined;

  const costInputPerM =
    pickNumber(cost, ["input", "inputCost", "input_cost", "costPerInputToken"]) ??
    0;
  const costOutputPerM =
    pickNumber(cost, [
      "output",
      "outputCost",
      "output_cost",
      "costPerOutputToken",
    ]) ?? 0;

  return { contextLength, costInputPerM, costOutputPerM };
}

/**
 * Flattens the catalog's top-level shape into `modelId -> ModelCapability`.
 * Tolerates both `{ [provider]: { models: { [id]: {...} } } }` (models.dev's
 * documented shape) and a flat `{ [id]: {...} }` map.
 */
function normalizeCatalog(raw: unknown): Record<string, ModelCapability> {
  const result: Record<string, ModelCapability> = {};
  if (typeof raw !== "object" || raw === null) return result;

  for (const [providerKey, providerValue] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (typeof providerValue !== "object" || providerValue === null) continue;
    const providerObj = providerValue as Record<string, unknown>;

    const modelsObj =
      typeof providerObj.models === "object" && providerObj.models !== null
        ? (providerObj.models as Record<string, unknown>)
        : // Not nested under `models` — maybe providerValue IS the model entry
          undefined;

    if (modelsObj) {
      for (const [modelId, modelRaw] of Object.entries(modelsObj)) {
        const normalized = normalizeEntry(modelRaw);
        if (normalized) result[modelId] = normalized;
      }
    } else {
      const normalized = normalizeEntry(providerObj);
      if (normalized) result[providerKey] = normalized;
    }
  }

  return result;
}

export class ModelCatalog {
  private readonly url: string;
  private readonly cachePath: string;
  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger = getLogger();

  private memoryCache: CacheFile | null = null;
  /** When the last fetch attempt failed — used to avoid re-attempting (and re-paying the timeout) on every single call while offline. */
  private lastFailureAt: number | null = null;
  private readonly failureCooldownMs: number;

  constructor(projectRoot?: string, config?: ModelCatalogConfig) {
    this.url = config?.url ?? DEFAULT_URL;
    this.cachePath =
      config?.cachePath ??
      join(projectRoot ?? process.cwd(), ".claude", "models-catalog.json");
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchTimeoutMs = config?.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config?.fetchImpl ?? globalThis.fetch;
    // Deliberately much shorter than ttlMs: a failed fetch should be
    // retried reasonably soon (network may come back), but not on every
    // single call in a tight loop.
    this.failureCooldownMs = config?.fetchTimeoutMs
      ? config.fetchTimeoutMs * 20
      : 60_000;
  }

  /**
   * Returns the full catalog, freshest available: in-memory cache, then
   * fresh on-disk cache, then a live fetch (cached on success), then a
   * stale on-disk cache as a last resort, then an empty map. Never throws.
   */
  async getAll(): Promise<Record<string, ModelCapability>> {
    if (this.memoryCache && this.isFresh(this.memoryCache.fetchedAt)) {
      return this.memoryCache.models;
    }

    const onDisk = this.readDiskCache();
    if (onDisk && this.isFresh(onDisk.fetchedAt)) {
      this.memoryCache = onDisk;
      return onDisk.models;
    }

    // Recently failed (e.g. offline machine) — don't pay the fetch timeout
    // again on every single routing call; fall straight to whatever's
    // available (stale cache or empty, both handled below).
    if (
      this.lastFailureAt !== null &&
      Date.now() - this.lastFailureAt < this.failureCooldownMs
    ) {
      return onDisk?.models ?? {};
    }

    const fetched = await this.tryFetch();
    if (fetched) {
      this.lastFailureAt = null;
      const cacheFile: CacheFile = { fetchedAt: Date.now(), models: fetched };
      this.memoryCache = cacheFile;
      this.writeDiskCache(cacheFile);
      return fetched;
    }

    // Fetch failed — a stale cache beats nothing.
    this.lastFailureAt = Date.now();
    if (onDisk) {
      this.memoryCache = onDisk;
      return onDisk.models;
    }

    return {};
  }

  async getModel(modelId: string): Promise<ModelCapability | undefined> {
    const all = await this.getAll();
    return all[modelId];
  }

  private isFresh(fetchedAt: number): boolean {
    return Date.now() - fetchedAt < this.ttlMs;
  }

  private async tryFetch(): Promise<Record<string, ModelCapability> | null> {
    if (typeof this.fetchImpl !== "function") return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.debug(
          `ModelCatalog fetch returned ${response.status}, falling back`,
        );
        return null;
      }
      const json = await response.json();
      const normalized = normalizeCatalog(json);
      if (Object.keys(normalized).length === 0) {
        this.logger.debug(
          "ModelCatalog fetch succeeded but no entries were parseable, falling back",
        );
        return null;
      }
      return normalized;
    } catch (error) {
      this.logger.debug(
        `ModelCatalog fetch failed (${error instanceof Error ? error.message : "unknown error"}), falling back to offline data`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private readDiskCache(): CacheFile | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, "utf-8"));
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof raw.fetchedAt === "number" &&
        typeof raw.models === "object" &&
        raw.models !== null
      ) {
        return raw as CacheFile;
      }
      return null;
    } catch {
      return null;
    }
  }

  private writeDiskCache(cache: CacheFile): void {
    try {
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // Cache write failure is non-fatal — the fetched data is still
      // returned for this process's lifetime via memoryCache.
    }
  }
}

let modelCatalogInstance: ModelCatalog | null = null;

export function getModelCatalog(
  projectRoot?: string,
  config?: ModelCatalogConfig,
): ModelCatalog {
  if (!modelCatalogInstance) {
    modelCatalogInstance = new ModelCatalog(projectRoot, config);
  }
  return modelCatalogInstance;
}

export function resetModelCatalog(): void {
  modelCatalogInstance = null;
}
