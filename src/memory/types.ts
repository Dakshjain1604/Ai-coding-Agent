/**
 * Memory Types - Type definitions for the memory system
 */

// ============================================================================
// Core Memory Types
// ============================================================================

export type MemoryType =
  | "pattern"
  | "decision"
  | "preference"
  | "conversation"
  | "execution"
  | "plan";

export type MemoryPriority = "low" | "medium" | "high" | "critical";

/** Who the entry is about: "user" (preferences, cross-task) or "project"
 * (facts/patterns/decisions about this codebase). Not a third "session"
 * value — current-session memory is already covered by SessionCache
 * (in-memory until flush) + conversation_turns (durable per-turn log). */
export type MemoryScope = "user" | "project";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[];
  scope: MemoryScope;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  accessCount: number;
  priority: MemoryPriority;
}

export interface MemoryMetadata {
  source?: string;
  tags?: string[];
  confidence?: number;
  relevanceScore?: number;
  agentType?: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface MemoryQuery {
  type?: MemoryType;
  scope?: MemoryScope;
  tags?: string[];
  text?: string;
  embedding?: number[];
  startDate?: Date;
  endDate?: Date;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  highlights?: string[];
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ConversationRecord {
  id: string;
  startTime: Date;
  endTime?: Date;
  turns: ConversationTurn[];
  summary?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// SQLite Store Types
// ============================================================================

export interface SQLiteConfig {
  path: string;
  enableEmbeddings: boolean;
  embeddingModel?: string;
}

export interface ExecutionRecord {
  id: string;
  agentType: string;
  task: string;
  result: string;
  durationMs: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface PatternRecord {
  id: string;
  patternType: string;
  pattern: string;
  confidence: number;
  lastUsed: Date;
  useCount: number;
}

// ============================================================================
// Project Memory Types
// ============================================================================

export interface ProjectMemoryConfig {
  rootDir: string;
  memoryDir: string;
  maxFileSize: number;
  autoSave: boolean;
}

// ============================================================================
// Memory Manager Types
// ============================================================================

export interface MemoryManagerConfig {
  project: ProjectMemoryConfig;
  sqlite: SQLiteConfig;
  contextWindow: {
    maxSize: number;
    compactionThreshold: number;
  };
  enableEmbeddings: boolean;
}

export interface MemoryStats {
  totalEntries: number;
  totalSize: number;
  byType: Record<MemoryType, number>;
  oldestEntry?: Date;
  newestEntry?: Date;
  averageAccessCount: number;
}
