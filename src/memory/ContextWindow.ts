/**
 * Context Window Manager - Active context management with auto-compaction
 * Manages the current conversation context and handles token limits
 */

import { getLogger } from "../utils/logger.js";
import type {
  MemoryEntry,
  ContextWindow,
  ContextCompactionResult,
} from "./types.js";

export interface ContextWindowConfig {
  maxSize: number;
  compactionThreshold: number;
  reservedTokens: number;
  maxAge: number; // milliseconds
}

export interface ContextEntry extends Omit<MemoryEntry, "priority"> {
  tokens: number;
  addedAt: Date;
  priority: number;
}

/**
 * Context Window Manager
 * Handles the active context window with automatic compaction
 */
export class ContextWindowManager {
  private window: ContextWindow;
  private entries: ContextEntry[] = [];
  private config: ContextWindowConfig;
  private logger = getLogger();

  constructor(config?: Partial<ContextWindowConfig>) {
    this.config = {
      maxSize: 100000, // 100k tokens default
      compactionThreshold: 0.8, // Compact at 80% capacity
      reservedTokens: 10000, // Reserve 10k tokens for system
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      ...config,
    };

    this.window = {
      id: crypto.randomUUID ? crypto.randomUUID() : this.generateId(),
      maxSize: this.config.maxSize,
      currentSize: 0,
      entries: [],
    };
  }

  /**
   * Add an entry to the context window
   */
  add(entry: MemoryEntry, tokens: number, priority: number = 1): boolean {
    const contextEntry: ContextEntry = {
      ...entry,
      tokens,
      addedAt: new Date(),
      priority,
    };

    // Check if we need compaction
    if (this.needsCompaction(tokens)) {
      this.compact();
    }

    // Add entry
    this.entries.push(contextEntry);
    this.window.entries.push(entry);
    this.window.currentSize += tokens;

    this.logger.debug(
      `Added ${tokens} tokens to context window (${this.window.currentSize}/${this.config.maxSize})`,
    );
    return true;
  }

  /**
   * Add multiple entries
   */
  addMany(
    entries: Array<{ entry: MemoryEntry; tokens: number; priority?: number }>,
  ): void {
    for (const { entry, tokens, priority } of entries) {
      this.add(entry, tokens, priority ?? 1);
    }
  }

  /**
   * Remove an entry by ID
   */
  remove(id: string): boolean {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index === -1) return false;

    const entry = this.entries[index];
    this.entries.splice(index, 1);
    this.window.entries = this.window.entries.filter((e) => e.id !== id);
    this.window.currentSize -= entry.tokens;

    return true;
  }

  /**
   * Clear the context window
   */
  clear(): void {
    this.entries = [];
    this.window.entries = [];
    this.window.currentSize = 0;
    this.window.summary = undefined;
    this.logger.debug("Context window cleared");
  }

  /**
   * Get current context entries
   */
  getEntries(): ContextEntry[] {
    return [...this.entries];
  }

  /**
   * Get context as text for LLM
   */
  getContextText(): string {
    return this.entries.map((e) => this.formatEntryForContext(e)).join("\n\n");
  }

  /**
   * Get context size in tokens
   */
  getSize(): number {
    return this.window.currentSize;
  }

  /**
   * Get remaining capacity
   */
  getRemainingCapacity(): number {
    return Math.max(
      0,
      this.config.maxSize -
        this.window.currentSize -
        this.config.reservedTokens,
    );
  }

  /**
   * Check if context window is empty
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Check if context window needs compaction
   */
  needsCompaction(additionalTokens: number = 0): boolean {
    const threshold = this.config.maxSize * this.config.compactionThreshold;
    return this.window.currentSize + additionalTokens > threshold;
  }

  /**
   * Compact the context window
   */
  compact(): ContextCompactionResult {
    const startSize = this.entries.length;
    const startTokens = this.window.currentSize;

    // Sort entries by priority and age
    this.entries.sort((a, b) => {
      // Higher priority first
      if (a.priority !== b.priority) return b.priority - a.priority;
      // More recent first
      return b.addedAt.getTime() - a.addedAt.getTime();
    });

    // Calculate target size after compaction
    const targetSize = this.config.maxSize * 0.5; // Reduce to 50%

    // Remove low-priority/old entries until we're under target
    const removed: ContextEntry[] = [];

    while (this.window.currentSize > targetSize && this.entries.length > 0) {
      // Find lowest priority entry
      let lowestPriority = this.entries[0].priority;
      let lowestIndex = 0;

      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i].priority < lowestPriority) {
          lowestPriority = this.entries[i].priority;
          lowestIndex = i;
        }
      }

      // Remove it
      const entry = this.entries.splice(lowestIndex, 1)[0];
      removed.push(entry);
      this.window.currentSize -= entry.tokens;
    }

    // Update window entries
    this.window.entries = this.entries.map((e) => ({
      ...e,
    })) as unknown as MemoryEntry[];
    this.window.lastCompacted = new Date();

    // Generate summary of removed content
    const summary = this.generateSummary(removed);

    this.logger.debug(
      `Compacted context: removed ${removed.length} entries, freed ${startTokens - this.window.currentSize} tokens`,
    );

    return {
      removedEntries: removed.length,
      retainedSize: this.window.currentSize,
      summary,
    };
  }

  /**
   * Set context window summary
   */
  setSummary(summary: string): void {
    this.window.summary = summary;
  }

  /**
   * Get context window summary
   */
  getSummary(): string | undefined {
    return this.window.summary;
  }

  /**
   * Get context window state
   */
  getState(): ContextWindow {
    return { ...this.window };
  }

  /**
   * Restore context window state
   */
  restore(state: ContextWindow): void {
    this.window = { ...state };
    this.entries = state.entries.map((e) => ({
      ...e,
      tokens: this.estimateTokens(e.content),
      addedAt: e.createdAt,
      priority: 1,
    }));
  }

  /**
   * Estimate tokens for text
   */
  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Export context for persistence
   */
  export(): {
    window: ContextWindow;
    entries: Array<{ id: string; tokens: number; priority: number }>;
  } {
    return {
      window: this.window,
      entries: this.entries.map((e) => ({
        id: e.id,
        tokens: e.tokens,
        priority: e.priority,
      })),
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private generateId(): string {
    return "ctx_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  private formatEntryForContext(entry: ContextEntry): string {
    const header = `[${entry.type}] ${entry.id}`;
    const metadata = entry.metadata.tags?.length
      ? ` (tags: ${entry.metadata.tags.join(", ")})`
      : "";
    const timestamp = entry.addedAt.toISOString();

    return `${header}${metadata}\nTimestamp: ${timestamp}\n\n${entry.content}`;
  }

  private generateSummary(removed: ContextEntry[]): string {
    if (removed.length === 0) return "";

    const typeGroups: Record<string, ContextEntry[]> = {};

    for (const entry of removed) {
      if (!typeGroups[entry.type]) {
        typeGroups[entry.type] = [];
      }
      typeGroups[entry.type].push(entry);
    }

    const summaryParts: string[] = ["Removed context entries:"];

    for (const [type, entries] of Object.entries(typeGroups)) {
      summaryParts.push(`- ${type}: ${entries.length} entries`);
      // Include brief summaries of high-priority removed entries
      const highPriority = entries.filter((e) => e.priority >= 2);
      if (highPriority.length > 0) {
        for (const entry of highPriority.slice(0, 3)) {
          summaryParts.push(`  - ${entry.content.slice(0, 100)}...`);
        }
      }
    }

    return summaryParts.join("\n");
  }
}

/**
 * Create a ContextWindowManager instance
 */
export function createContextWindow(
  config?: Partial<ContextWindowConfig>,
): ContextWindowManager {
  return new ContextWindowManager(config);
}
