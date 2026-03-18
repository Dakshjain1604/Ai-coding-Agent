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

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[];
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
// Context Window Types
// ============================================================================

export interface ContextWindow {
  id: string;
  maxSize: number;
  currentSize: number;
  entries: MemoryEntry[];
  summary?: string;
  lastCompacted?: Date;
  priorityMap?: Record<string, number>;
}

export interface ContextCompactionResult {
  removedEntries: number;
  retainedSize: number;
  summary: string;
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

export interface MemoryFile {
  path: string;
  type: MemoryType;
  content: string;
  lastModified: Date;
}

export interface PatternFile {
  patterns: PatternRecord[];
  lastUpdated: Date;
}

export interface DecisionFile {
  decisions: DecisionRecord[];
  lastUpdated: Date;
}

export interface DecisionRecord {
  id: string;
  date: Date;
  decision: string;
  rationale: string;
  alternatives?: string[];
  impact?: string;
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
