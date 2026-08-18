/**
 * Session Cache - In-memory session store for the current session
 * Provides O(1) text search without I/O during agent execution
 */

import type { MemoryEntry, MemorySearchResult } from "./types.js";

export class SessionCache {
  private entries: MemoryEntry[] = [];
  private dirty = false;
  private pendingWrites: MemoryEntry[] = [];

  loadAll(entries: MemoryEntry[]): void {
    this.entries = [...entries];
  }

  search(text: string, limit: number): MemorySearchResult[] {
    const query = text.toLowerCase();
    return this.entries
      .map((entry) => ({
        entry,
        score: this.scoreMatch(entry.content, query),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  add(entry: MemoryEntry): void {
    this.entries.push(entry);
    this.pendingWrites.push(entry);
    this.dirty = true;
  }

  getPendingWrites(): MemoryEntry[] {
    return [...this.pendingWrites];
  }

  clearPending(): void {
    this.pendingWrites = [];
    this.dirty = false;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  private scoreMatch(content: string, query: string): number {
    const lower = content.toLowerCase();
    // .split(/\s+/) on a string with leading/trailing whitespace produces
    // "" elements at the ends (e.g. " a b ".split(/\s+/) === ["","a","b",""]).
    // Since `"anything".includes("")` is always true, each of those empty
    // "words" was previously counted as a free match — inflating the score
    // toward 1 for ANY padded query, including one with zero real matches.
    // Confirmed live: an entirely unrelated entry scored 0.5 instead of 0
    // purely because the query happened to have surrounding whitespace,
    // which would pass search()'s `score > 0` filter and inject an
    // irrelevant memory into a task's context.
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return 0;
    return words.filter((w) => lower.includes(w)).length / words.length;
  }
}
