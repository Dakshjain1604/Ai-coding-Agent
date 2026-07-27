/**
 * Memory Manager - Unified memory interface
 * Coordinates Project Memory, SQLite Store, and Context Window
 */

import { join } from "path";
import { getLogger } from "../utils/logger.js";
import type {
  MemoryEntry,
  MemoryType,
  MemoryQuery,
  MemorySearchResult,
  MemoryManagerConfig,
  MemoryStats,
  ConversationRecord,
  ConversationTurn,
  ExecutionRecord,
  PatternRecord,
} from "./types.js";
import { ProjectMemory, createProjectMemory } from "./ProjectMemory.js";
import { SQLiteStore, createSQLiteStore } from "./SQLiteStore.js";
import { ContextWindowManager, createContextWindow } from "./ContextWindow.js";
import { SessionCache } from "./SessionCache.js";
import { v4 as uuid } from "uuid";

/**
 * Memory Manager
 * Provides a unified interface for all memory operations
 */
export class MemoryManager {
  private projectMemory: ProjectMemory;
  private sqliteStore: SQLiteStore;
  private contextWindow: ContextWindowManager;
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

    this.projectMemory = createProjectMemory(this.config.project);
    this.sqliteStore = createSQLiteStore(this.config.sqlite);
    this.contextWindow = createContextWindow(this.config.contextWindow);

    this.logger.info("Memory Manager initialized");
  }

  async initSession(): Promise<void> {
    if (this.sessionInitialized) return;
    const allEntries = await this.projectMemory.loadAll();
    this.sessionCache.loadAll(allEntries);
    this.sessionInitialized = true;
  }

  async flushSession(): Promise<void> {
    if (!this.sessionCache.isDirty()) return;
    const pending = this.sessionCache.getPendingWrites();
    if (pending.length > 0) {
      await this.projectMemory.batchWrite(pending);
      for (const entry of pending) {
        this.sqliteStore.storeMemory(entry);
      }
      this.sessionCache.clearPending();
    }
  }

  // ============================================================================
  // Memory Operations
  // ============================================================================

  /**
   * Store a memory entry
   */
  async store(
    type: MemoryType,
    content: string,
    metadata?: Record<string, unknown>,
    priority?: "low" | "medium" | "high" | "critical",
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: uuid(),
      type,
      content,
      metadata: metadata ?? {},
      priority: priority ?? "medium",
      createdAt: new Date(),
      updatedAt: new Date(),
      accessCount: 0,
    };

    if (this.sessionInitialized) {
      this.sessionCache.add(entry);
    } else {
      await this.projectMemory.store({
        type,
        content,
        metadata: metadata ?? {},
        priority: priority ?? "medium",
      });
      this.sqliteStore.storeMemory({
        ...entry,
        embedding: metadata?.embedding as number[] | undefined,
      });
    }

    const tokens = this.contextWindow.estimateTokens(content);
    if (this.contextWindow.getRemainingCapacity() >= tokens) {
      this.contextWindow.add(
        entry,
        tokens,
        this.getPriorityValue(priority ?? "medium"),
      );
    }

    this.logger.memoryStore(entry.id);
    return entry;
  }

  /**
   * Retrieve a memory entry by ID
   */
  async retrieve(id: string): Promise<MemoryEntry | null> {
    // Try SQLite first (faster)
    const entry = this.sqliteStore.getMemory(id);
    if (entry) return entry;

    // Fall back to project memory
    return this.projectMemory.retrieve(id);
  }

  /**
   * Query memory entries
   */
  async query(query: MemoryQuery): Promise<MemorySearchResult[]> {
    // Query SQLite for fast results
    const results = this.sqliteStore.queryMemory(query);

    // If not found in SQLite, fall back to project memory
    if (results.length === 0) {
      return this.projectMemory.query(query);
    }

    return results;
  }

  /**
   * Update a memory entry
   */
  async update(
    id: string,
    updates: Partial<MemoryEntry>,
  ): Promise<MemoryEntry | null> {
    // Update in SQLite
    this.sqliteStore.updateMemory(id, updates);

    // Update in project memory
    return this.projectMemory.update(id, updates);
  }

  /**
   * Delete a memory entry
   */
  async delete(id: string): Promise<boolean> {
    // Delete from SQLite
    this.sqliteStore.deleteMemory(id);

    // Delete from project memory
    return this.projectMemory.delete(id);
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
   * Add a turn to the current conversation
   */
  addConversationTurn(
    conversationId: string,
    role: "user" | "assistant" | "system",
    content: string,
    metadata?: Record<string, unknown>,
  ): ConversationTurn {
    const turn: ConversationTurn = {
      id: uuid(),
      role,
      content,
      timestamp: new Date(),
      metadata,
    };

    // Store turn directly to database without reloading/reinserting full conversation
    this.sqliteStore.storeTurn(conversationId, turn);

    return turn;
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
   * Log an execution
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
  // Context Window Operations
  // ============================================================================

  /**
   * Add to context window
   */
  addToContext(entry: MemoryEntry, tokens?: number, priority?: number): void {
    const estimatedTokens =
      tokens ?? this.contextWindow.estimateTokens(entry.content);
    this.contextWindow.add(entry, estimatedTokens, priority ?? 1);
  }

  /**
   * Get context text
   */
  getContextText(): string {
    return this.contextWindow.getContextText();
  }

  /**
   * Get context size
   */
  getContextSize(): number {
    return this.contextWindow.getSize();
  }

  /**
   * Get remaining context capacity
   */
  getRemainingContextCapacity(): number {
    return this.contextWindow.getRemainingCapacity();
  }

  /**
   * Clear context window
   */
  clearContext(): void {
    this.contextWindow.clear();
  }

  /**
   * Compact context window
   */
  compactContext(): {
    removedEntries: number;
    retainedSize: number;
    summary: string;
  } {
    return this.contextWindow.compact();
  }

  // ============================================================================
  // Statistics and Maintenance
  // ============================================================================

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    const projectStats = await this.projectMemory.getStats();
    const sqliteStats = this.sqliteStore.getStats();

    return {
      totalEntries: projectStats.totalEntries,
      totalSize: sqliteStats.memoryEntries,
      byType: projectStats.byType,
      oldestEntry: projectStats.oldestEntry,
      newestEntry: projectStats.newestEntry,
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
   * Clear all memory (with backup)
   */
  async clear(): Promise<void> {
    await this.projectMemory.clear();
    this.clearContext();
    this.logger.info("All memory cleared");
  }

  /**
   * Close connections
   */
  close(): void {
    this.sqliteStore.close();
    this.logger.debug("Memory Manager closed");
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private getPriorityValue(
    priority: "low" | "medium" | "high" | "critical",
  ): number {
    const values = { low: 1, medium: 2, high: 3, critical: 4 };
    return values[priority] ?? 2;
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
