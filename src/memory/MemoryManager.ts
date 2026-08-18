/**
 * Memory Manager - Unified memory interface
 * Coordinates SQLite storage (sole source of truth for MemoryEntry data)
 * and the in-session write-buffer cache.
 */

import { join } from "path";
import { getLogger } from "../utils/logger.js";
import type {
  MemoryEntry,
  MemoryType,
  MemoryScope,
  MemoryQuery,
  MemorySearchResult,
  MemoryManagerConfig,
  MemoryStats,
  ConversationRecord,
  ConversationTurn,
  ExecutionRecord,
  PatternRecord,
} from "./types.js";
import { SQLiteStore, createSQLiteStore } from "./SQLiteStore.js";
import { SessionCache } from "./SessionCache.js";
import { v4 as uuid } from "uuid";

const INFERRED_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INFERRED_DEFAULT_CONFIDENCE = 0.5;
const EXPLICIT_CONFIDENCE = 1.0;

/**
 * Memory Manager
 * Provides a unified interface for all memory operations
 *
 * Note: message/context truncation for LLM calls is owned solely by
 * BaseAgent.truncateMessages() (the hot path that actually feeds the model).
 * MemoryManager does not maintain a second, competing context-window budget.
 *
 * SQLite is the sole store for MemoryEntry data — a prior markdown
 * dual-write (ProjectMemory) was retired because its regex-based
 * markdown "database" silently dropped fields (expiresAt, most metadata)
 * on every reload. `exportProjectKnowledge()` renders a read-only markdown
 * view on demand instead of maintaining a parallel written store.
 */
export class MemoryManager {
  private sqliteStore: SQLiteStore;
  private sessionCache = new SessionCache();
  private sessionInitialized = false;
  private config: MemoryManagerConfig;
  private logger = getLogger();

  constructor(config?: Partial<MemoryManagerConfig>) {
    const rootDir = config?.project?.rootDir ?? process.cwd();
    const memoryDir =
      config?.project?.memoryDir ?? join(rootDir, ".claude", "memory");

    this.config = {
      project: {
        rootDir,
        memoryDir,
        maxFileSize: config?.project?.maxFileSize ?? 10 * 1024 * 1024,
        autoSave: config?.project?.autoSave ?? true,
      },
      sqlite: {
        path: config?.sqlite?.path ?? join(rootDir, ".claude", "memory.db"),
        enableEmbeddings: config?.sqlite?.enableEmbeddings ?? true,
        embeddingModel: config?.sqlite?.embeddingModel,
      },
      contextWindow: {
        maxSize: config?.contextWindow?.maxSize ?? 100000,
        compactionThreshold: config?.contextWindow?.compactionThreshold ?? 0.8,
      },
      enableEmbeddings: config?.enableEmbeddings ?? true,
    };

    this.sqliteStore = createSQLiteStore(this.config.sqlite);

    this.logger.info("Memory Manager initialized");
  }

  async initSession(): Promise<void> {
    if (this.sessionInitialized) return;
    const allEntries = this.sqliteStore
      .queryMemory({})
      .map((result) => result.entry);
    this.sessionCache.loadAll(allEntries);
    this.sessionInitialized = true;
  }

  async flushSession(): Promise<void> {
    if (!this.sessionCache.isDirty()) return;
    const pending = this.sessionCache.getPendingWrites();
    for (const entry of pending) {
      this.sqliteStore.storeMemory(entry);
    }
    this.sessionCache.clearPending();
  }

  // ============================================================================
  // Memory Operations
  // ============================================================================

  /**
   * Store a memory entry.
   *
   * `source` decides the confidence/expiry defaults, not a full
   * trajectory-mining pipeline: "explicit" (an actual user statement, via
   * remember()) gets full confidence and never expires; "inferred"
   * (everything else — the default, so existing call sites keep their
   * current behavior) gets a lower default confidence and a 30-day expiry
   * so cleanup() actually has something to purge over time. Either default
   * is skipped if the caller already set confidence/expiresAt explicitly.
   */
  async store(
    type: MemoryType,
    content: string,
    metadata?: Record<string, unknown>,
    priority?: "low" | "medium" | "high" | "critical",
    options?: { scope?: MemoryScope; source?: "explicit" | "inferred" },
  ): Promise<MemoryEntry> {
    const source = options?.source ?? "inferred";
    const finalMetadata = { ...(metadata ?? {}) };

    // expiresAt travels in via the metadata bag (no dedicated store() param
    // needed) but belongs only on the entry's top-level field, not
    // duplicated inside the stored metadata blob.
    const explicitExpiresAt = finalMetadata.expiresAt as Date | undefined;
    delete finalMetadata.expiresAt;

    if (finalMetadata.confidence === undefined) {
      finalMetadata.confidence =
        source === "explicit" ? EXPLICIT_CONFIDENCE : INFERRED_DEFAULT_CONFIDENCE;
    }

    const now = new Date();
    const expiresAt =
      explicitExpiresAt ??
      (source === "inferred"
        ? new Date(now.getTime() + INFERRED_MEMORY_TTL_MS)
        : undefined);

    const entry: MemoryEntry = {
      id: uuid(),
      type,
      content,
      metadata: finalMetadata,
      scope: options?.scope ?? "project",
      priority: priority ?? "medium",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      accessCount: 0,
    };

    if (this.sessionInitialized) {
      this.sessionCache.add(entry);
    } else {
      this.sqliteStore.storeMemory(entry);
    }

    this.logger.memoryStore(entry.id);
    return entry;
  }

  /**
   * Remember an explicit user-stated fact/preference — full confidence,
   * no expiry, scoped to the user (not the project).
   */
  async remember(fact: string): Promise<MemoryEntry> {
    return this.store("preference", fact, {}, "high", {
      scope: "user",
      source: "explicit",
    });
  }

  /**
   * Forget the closest-matching remembered fact.
   */
  async forget(fact: string): Promise<boolean> {
    const results = await this.search(fact, 1);
    if (!results.length) return false;
    return this.delete(results[0].entry.id);
  }

  /**
   * Retrieve a memory entry by ID
   */
  async retrieve(id: string): Promise<MemoryEntry | null> {
    return this.sqliteStore.getMemory(id);
  }

  /**
   * Query memory entries
   */
  async query(query: MemoryQuery): Promise<MemorySearchResult[]> {
    return this.sqliteStore.queryMemory(query);
  }

  /**
   * Update a memory entry
   */
  async update(
    id: string,
    updates: Partial<MemoryEntry>,
  ): Promise<MemoryEntry | null> {
    this.sqliteStore.updateMemory(id, updates);
    return this.sqliteStore.getMemory(id);
  }

  /**
   * Delete a memory entry
   */
  async delete(id: string): Promise<boolean> {
    return this.sqliteStore.deleteMemory(id);
  }

  /**
   * Search memory by text
   */
  async search(text: string, limit?: number): Promise<MemorySearchResult[]> {
    if (this.sessionInitialized) {
      return this.sessionCache.search(text, limit ?? 10);
    }
    return this.query({ text, limit: limit ?? 10 });
  }

  /**
   * Search memory by similarity (requires embeddings)
   */
  async searchSimilar(
    embedding: number[],
    limit?: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.config.enableEmbeddings) {
      throw new Error("Embeddings are not enabled");
    }
    return this.sqliteStore.findSimilar(embedding, limit ?? 10);
  }

  /**
   * Store an embedding for a memory entry
   */
  async storeEmbedding(id: string, embedding: number[]): Promise<void> {
    this.sqliteStore.storeEmbedding(id, embedding);
  }

  /**
   * Render all project-scoped memory as a human-readable markdown view —
   * generated on demand from SQLite, never written to disk as a maintained
   * file, so there's nothing for it to drift from. Backs the "show project
   * knowledge" user-control command.
   */
  async exportProjectKnowledge(): Promise<string> {
    const results = this.sqliteStore.queryMemory({ scope: "project" });
    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const { entry } of results) {
      const group = byType.get(entry.type) ?? [];
      group.push(entry);
      byType.set(entry.type, group);
    }

    const sections: string[] = ["# Project Knowledge\n"];
    for (const [type, entries] of byType) {
      sections.push(`## ${type}\n`);
      for (const entry of entries) {
        const tags = entry.metadata.tags?.length
          ? ` (tags: ${entry.metadata.tags.join(", ")})`
          : "";
        sections.push(`- ${entry.content}${tags}`);
      }
      sections.push("");
    }
    return sections.join("\n");
  }

  // ============================================================================
  // Conversation Operations
  // ============================================================================

  /**
   * Start a new conversation
   */
  startConversation(): string {
    const record: Omit<ConversationRecord, "id"> = {
      startTime: new Date(),
      turns: [],
    };

    const saved = this.sqliteStore.storeConversation(record);
    this.logger.debug(`Started conversation ${saved.id}`);
    return saved.id;
  }

  /**
   * Record a single turn in an already-started conversation — a thin
   * wrapper over the already-implemented SQLiteStore.storeTurn(), which
   * previously had no caller anywhere in the codebase (see
   * BaseAgent.initializeContext()/addMessage() for the wiring).
   */
  recordTurn(
    conversationId: string,
    role: ConversationTurn["role"],
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.sqliteStore.storeTurn(conversationId, {
      id: uuid(),
      role,
      content,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * Get conversation by ID
   */
  getConversation(id: string): ConversationRecord | null {
    return this.sqliteStore.getConversation(id);
  }

  /**
   * Get recent conversations
   */
  getRecentConversations(limit?: number): ConversationRecord[] {
    return this.sqliteStore.getRecentConversations(limit ?? 10);
  }

  /**
   * Search conversations
   */
  searchConversations(query: string, limit?: number): ConversationRecord[] {
    return this.sqliteStore.searchConversations(query, limit ?? 10);
  }

  // ============================================================================
  // Execution Operations
  // ============================================================================

  /**
   * Log an execution.
   *
   * Intentionally write-once-per-task, direct to SQLite — this does NOT go
   * through the session batch (unlike `store()`'s MemoryEntry path, which
   * loads once at session start and flushes once at session end). Execution
   * records are one-per-task by construction, so there's nothing to batch.
   */
  logExecution(
    agentType: string,
    task: string,
    result: string,
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): ExecutionRecord {
    return this.sqliteStore.storeExecution({
      agentType,
      task,
      result,
      durationMs,
      timestamp: new Date(),
      metadata,
    });
  }

  /**
   * Get executions by agent
   */
  getExecutionsByAgent(agentType: string, limit?: number): ExecutionRecord[] {
    return this.sqliteStore.getExecutionsByAgent(agentType, limit ?? 50);
  }

  /**
   * Get recent executions
   */
  getRecentExecutions(limit?: number): ExecutionRecord[] {
    return this.sqliteStore.getRecentExecutions(limit ?? 50);
  }

  // ============================================================================
  // Pattern Operations
  // ============================================================================

  /**
   * Store a learned pattern
   */
  storePattern(
    patternType: string,
    pattern: string,
    confidence?: number,
  ): PatternRecord {
    return this.sqliteStore.storePattern({
      patternType,
      pattern,
      confidence: confidence ?? 0.5,
      lastUsed: new Date(),
      useCount: 0,
    });
  }

  /**
   * Get patterns by type
   */
  getPatterns(patternType: string): PatternRecord[] {
    return this.sqliteStore.getPatternsByType(patternType);
  }

  /**
   * Update pattern confidence
   */
  updatePatternConfidence(patternId: string, confidence: number): void {
    this.sqliteStore.updatePatternConfidence(patternId, confidence);
  }

  // ============================================================================
  // Statistics and Maintenance
  // ============================================================================

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    const sqliteStats = this.sqliteStore.getStats();
    const detailed = this.sqliteStore.getStatsDetailed();

    const byType: Record<MemoryType, number> = {
      pattern: 0,
      decision: 0,
      preference: 0,
      conversation: 0,
      execution: 0,
      plan: 0,
    };
    for (const [type, count] of Object.entries(detailed.byType)) {
      if (type in byType) byType[type as MemoryType] = count;
    }

    return {
      totalEntries: sqliteStats.memoryEntries,
      totalSize: sqliteStats.memoryEntries,
      byType,
      oldestEntry: detailed.oldestEntry,
      newestEntry: detailed.newestEntry,
      averageAccessCount: 0, // Would need to calculate
    };
  }

  /**
   * Cleanup expired entries
   */
  async cleanup(): Promise<number> {
    return this.sqliteStore.cleanup();
  }

  /**
   * Clear all memory entries.
   */
  async clear(): Promise<void> {
    this.sqliteStore.clearAllMemory();
    this.logger.info("All memory cleared");
  }

  /**
   * Close connections
   */
  close(): void {
    this.sqliteStore.close();
    this.logger.debug("Memory Manager closed");
  }
}

// Singleton instance
let memoryManagerInstance: MemoryManager | null = null;

/**
 * Get or create MemoryManager instance
 */
export function getMemoryManager(
  config?: Partial<MemoryManagerConfig>,
): MemoryManager {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager(config);
  }
  return memoryManagerInstance;
}

/**
 * Create a new MemoryManager instance
 */
export function createMemoryManager(
  config?: Partial<MemoryManagerConfig>,
): MemoryManager {
  return new MemoryManager(config);
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetMemoryManager(): void {
  if (memoryManagerInstance) {
    memoryManagerInstance.close();
    memoryManagerInstance = null;
  }
}
