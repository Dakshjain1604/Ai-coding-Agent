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
    const words = query.split(/\s+/);
    return words.filter((w) => lower.includes(w)).length / words.length;
  }
}
