/**
 * Tests for SessionCache (memory/SessionCache.ts) — the in-memory
 * relevance-search layer behind "relevant memories" injection into every
 * task's context, previously zero test coverage.
 *
 * Centerpiece regression: scoreMatch() split the query on whitespace
 * without filtering out the "" elements a leading/trailing-whitespace
 * query produces (" a b ".split(/\s+/) === ["","a","b",""]). Since
 * `"anything".includes("")` is always true in JS, each empty "word" was
 * counted as a free match — confirmed live: a query with surrounding
 * whitespace scored a COMPLETELY UNRELATED entry 0.5 instead of 0, which
 * would have passed search()'s `score > 0` filter and injected an
 * irrelevant memory into a task's context. An empty query scored
 * everything a perfect 1.0 for the same reason.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SessionCache } from "../../src/memory/SessionCache.js";
import type { MemoryEntry } from "../../src/memory/types.js";

function makeEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    type: "pattern",
    priority: "medium",
    timestamp: new Date(),
    tags: [],
    confidence: 1,
  };
}

describe("SessionCache — scoreMatch() whitespace bug (via search())", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
    cache.loadAll([
      makeEntry("exact", "hello world here"),
      makeEntry("partial", "hello universe"),
      makeEntry("unrelated", "completely different topic"),
    ]);
  });

  it("a completely unrelated entry scores zero for a normal (unpadded) query", () => {
    const results = cache.search("hello world", 10);
    expect(results.find((r) => r.entry.id === "unrelated")).toBeUndefined();
  });

  it("a completely unrelated entry ALSO scores zero for a query with leading/trailing whitespace", () => {
    const results = cache.search("  hello world  ", 10);
    expect(results.find((r) => r.entry.id === "unrelated")).toBeUndefined();
  });

  it("leading-whitespace-only query doesn't inflate scores", () => {
    const results = cache.search("   hello world", 10);
    expect(results.find((r) => r.entry.id === "unrelated")).toBeUndefined();
  });

  it("trailing-whitespace-only query doesn't inflate scores", () => {
    const results = cache.search("hello world   ", 10);
    expect(results.find((r) => r.entry.id === "unrelated")).toBeUndefined();
  });

  it("scores are identical whether or not the query has surrounding whitespace", () => {
    const unpadded = cache.search("hello world", 10);
    const padded = cache.search("  hello world  ", 10);
    const unpaddedScores = Object.fromEntries(unpadded.map((r) => [r.entry.id, r.score]));
    const paddedScores = Object.fromEntries(padded.map((r) => [r.entry.id, r.score]));
    expect(paddedScores).toEqual(unpaddedScores);
  });

  it("a genuinely empty query returns no results (not a perfect-score match-all)", () => {
    expect(cache.search("", 10)).toEqual([]);
  });

  it("a whitespace-only query returns no results", () => {
    expect(cache.search("   ", 10)).toEqual([]);
  });

  it("multiple internal spaces between words don't distort the score", () => {
    const normal = cache.search("hello world", 10);
    const doubleSpaced = cache.search("hello    world", 10);
    expect(doubleSpaced.find((r) => r.entry.id === "exact")?.score).toBe(
      normal.find((r) => r.entry.id === "exact")?.score,
    );
  });

  it("a tab or newline between query words is treated as a separator, not a literal", () => {
    const results = cache.search("hello\tworld", 10);
    expect(results.find((r) => r.entry.id === "exact")?.score).toBe(1);
  });
});

describe("SessionCache — search() correctness", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
    cache.loadAll([
      makeEntry("a", "The quick brown fox"),
      makeEntry("b", "jumps over the lazy dog"),
      makeEntry("c", "quick brown results"),
    ]);
  });

  it("is case-insensitive", () => {
    const results = cache.search("QUICK BROWN", 10);
    expect(results.map((r) => r.entry.id).sort()).toEqual(["a", "c"]);
  });

  it("matches on partial word overlap, scored proportionally", () => {
    const results = cache.search("quick brown fox", 10);
    const a = results.find((r) => r.entry.id === "a");
    const c = results.find((r) => r.entry.id === "c");
    expect(a?.score).toBe(1); // all 3 words present
    expect(c?.score).toBeCloseTo(2 / 3); // "quick brown" present, "fox" not
  });

  it("excludes entries with zero matching words", () => {
    const results = cache.search("quick brown", 10);
    expect(results.find((r) => r.entry.id === "b")).toBeUndefined();
  });

  it("sorts results by score descending", () => {
    const results = cache.search("quick brown fox", 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("respects the limit parameter", () => {
    const results = cache.search("quick brown fox jumps lazy dog the", 1);
    expect(results.length).toBe(1);
  });

  it("returns an empty array when nothing has been loaded", () => {
    const empty = new SessionCache();
    expect(empty.search("anything", 10)).toEqual([]);
  });

  it("returns an empty array for a limit of zero", () => {
    expect(cache.search("quick", 0)).toEqual([]);
  });
});

describe("SessionCache — loadAll()", () => {
  it("replaces any previously loaded entries", () => {
    const cache = new SessionCache();
    cache.loadAll([makeEntry("old", "old content")]);
    cache.loadAll([makeEntry("new", "new content")]);
    expect(cache.getAll().map((e) => e.id)).toEqual(["new"]);
  });

  it("does not share array identity with the input (defensive copy)", () => {
    const cache = new SessionCache();
    const input = [makeEntry("a", "content")];
    cache.loadAll(input);
    input.push(makeEntry("b", "sneaky mutation"));
    expect(cache.getAll().length).toBe(1);
  });

  it("handles an empty array", () => {
    const cache = new SessionCache();
    cache.loadAll([]);
    expect(cache.getAll()).toEqual([]);
  });
});

describe("SessionCache — add() / pending writes / dirty tracking", () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it("isDirty() is false for a fresh cache", () => {
    expect(cache.isDirty()).toBe(false);
  });

  it("add() marks the cache dirty", () => {
    cache.add(makeEntry("a", "content"));
    expect(cache.isDirty()).toBe(true);
  });

  it("add() appends the entry to both entries and pendingWrites", () => {
    const entry = makeEntry("a", "content");
    cache.add(entry);
    expect(cache.getAll()).toContainEqual(entry);
    expect(cache.getPendingWrites()).toContainEqual(entry);
  });

  it("add() makes the entry immediately searchable", () => {
    cache.add(makeEntry("a", "findable content"));
    expect(cache.search("findable", 10).length).toBe(1);
  });

  it("getPendingWrites() returns a defensive copy", () => {
    cache.add(makeEntry("a", "content"));
    const pending = cache.getPendingWrites();
    pending.push(makeEntry("b", "sneaky"));
    expect(cache.getPendingWrites().length).toBe(1);
  });

  it("clearPending() empties the pending-writes queue", () => {
    cache.add(makeEntry("a", "content"));
    cache.clearPending();
    expect(cache.getPendingWrites()).toEqual([]);
  });

  it("clearPending() resets isDirty() to false", () => {
    cache.add(makeEntry("a", "content"));
    cache.clearPending();
    expect(cache.isDirty()).toBe(false);
  });

  it("clearPending() does not remove entries from the searchable set", () => {
    cache.add(makeEntry("a", "findable content"));
    cache.clearPending();
    expect(cache.search("findable", 10).length).toBe(1);
  });

  it("multiple add()s accumulate in pendingWrites in order", () => {
    cache.add(makeEntry("a", "first"));
    cache.add(makeEntry("b", "second"));
    expect(cache.getPendingWrites().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("add() after loadAll() combines both sets in getAll()", () => {
    cache.loadAll([makeEntry("loaded", "content")]);
    cache.add(makeEntry("added", "content"));
    expect(cache.getAll().map((e) => e.id).sort()).toEqual(["added", "loaded"]);
  });
});

describe("SessionCache — getAll()", () => {
  it("returns a defensive copy, not the internal array", () => {
    const cache = new SessionCache();
    cache.loadAll([makeEntry("a", "content")]);
    const result = cache.getAll();
    result.push(makeEntry("b", "sneaky"));
    expect(cache.getAll().length).toBe(1);
  });

  it("returns an empty array for a fresh cache", () => {
    expect(new SessionCache().getAll()).toEqual([]);
  });
});
