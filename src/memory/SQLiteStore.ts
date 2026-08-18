/**
 * SQLite Store - Search & history database for memory
 * Enables fast queries, semantic search, and persistent history
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { getLogger } from '../utils/logger.js';
import type {
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,
  MemoryType,
  ConversationRecord,
  ConversationTurn,
  ExecutionRecord,
  PatternRecord,
  SQLiteConfig,
} from './types.js';

/**
 * SQLite Store
 * Manages persistent storage for memory, conversations, and execution history
 */
export class SQLiteStore {
  private db: Database.Database;
  private config: SQLiteConfig;
  private logger = getLogger();
  private initialized = false;

  constructor(config: SQLiteConfig) {
    this.config = config;

    // Ensure directory exists
    const dir = join(config.path, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(config.path);
    this.initialize();
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    if (this.initialized) return;

    this.db.exec(`
      -- Memory entries table
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        priority TEXT DEFAULT 'medium',
        scope TEXT NOT NULL DEFAULT 'project',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        access_count INTEGER DEFAULT 0
      );

      -- Embeddings table (for semantic search)
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        embedding BLOB,
        model TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entry_id) REFERENCES memory_entries(id)
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        summary TEXT,
        metadata TEXT,
        embedding BLOB
      );

      -- Conversation turns table
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        metadata TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      -- Executions table
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        task TEXT NOT NULL,
        result TEXT,
        duration_ms INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT
      );

      -- Patterns table (learned patterns)
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        pattern TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
        use_count INTEGER DEFAULT 0
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
      CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_priority ON memory_entries(priority);
      CREATE INDEX IF NOT EXISTS idx_conversations_start ON conversations(start_time);
      CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(agent_type);
      CREATE INDEX IF NOT EXISTS idx_executions_timestamp ON executions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
    `);

    this.migrateSchema();

    this.initialized = true;
    this.logger.debug('SQLite store initialized');
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
   * exists on disk — it will never add a column introduced after the
   * table's first release. This runs additive, idempotent `ALTER TABLE`
   * migrations for any such column, checked via `PRAGMA table_info` so it's
   * safe to call on every startup. Add future column migrations here in
   * the same shape.
   */
  private migrateSchema(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(memory_entries)`)
      .all() as { name: string }[];

    if (!columns.some((c) => c.name === 'scope')) {
      // Rows written before scoping existed were, in fact, project-scoped —
      // 'project' is the correct default, not just a safe placeholder.
      this.db.exec(
        `ALTER TABLE memory_entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`,
      );
    }
  }

  // ============================================================================
  // Memory Operations
  // ============================================================================

  /**
   * Store a memory entry
   */
  storeMemory(entry: (Omit<MemoryEntry, 'id'> & { id?: string })): MemoryEntry {
    // Respect a caller-provided id (e.g. MemoryManager.store() already
    // minted one to return to its own caller) — minting a fresh one here
    // regardless would silently desync the returned entry's id from what's
    // actually stored, making it unretrievable by that id.
    const id = entry.id ?? uuid();
    const now = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO memory_entries (id, type, content, metadata, priority, scope, created_at, updated_at, expires_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      entry.type,
      entry.content,
      JSON.stringify(entry.metadata),
      entry.priority,
      entry.scope ?? 'project',
      entry.createdAt?.toISOString() ?? now.toISOString(),
      entry.updatedAt?.toISOString() ?? now.toISOString(),
      entry.expiresAt?.toISOString() ?? null,
      entry.accessCount ?? 0
    );

    // Store embedding if provided
    if (entry.embedding && this.config.enableEmbeddings) {
      this.storeEmbedding(id, entry.embedding);
    }

    return { ...entry, id, createdAt: now, updatedAt: now };
  }

  /**
   * Retrieve a memory entry by ID
   */
  getMemory(id: string): MemoryEntry | null {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_entries WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    // Increment access count
    this.db.prepare('UPDATE memory_entries SET access_count = access_count + 1 WHERE id = ?').run(id);

    return this.rowToEntry(row);
  }

  /**
   * Query memory entries
   */
  queryMemory(query: MemoryQuery): MemorySearchResult[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.type) {
      conditions.push('type = ?');
      params.push(query.type);
    }

    if (query.scope) {
      conditions.push('scope = ?');
      params.push(query.scope);
    }

    if (query.startDate) {
      conditions.push('created_at >= ?');
      params.push(query.startDate.toISOString());
    }

    if (query.endDate) {
      conditions.push('created_at <= ?');
      params.push(query.endDate.toISOString());
    }

    if (query.minConfidence !== undefined) {
      conditions.push("json_extract(metadata, '$.confidence') >= ?");
      params.push(query.minConfidence);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = query.limit ? `LIMIT ${query.limit}` : '';
    const offsetClause = query.offset ? `OFFSET ${query.offset}` : '';

    const stmt = this.db.prepare(`
      SELECT * FROM memory_entries
      ${whereClause}
      ORDER BY priority DESC, created_at DESC
      ${limitClause}
      ${offsetClause}
    `);

    const rows = stmt.all(...params) as any[];

    // Filter by tags if provided
    let filtered = rows;
    if (query.tags && query.tags.length > 0) {
      filtered = rows.filter((row) => {
        const metadata = JSON.parse(row.metadata ?? '{}');
        return query.tags!.some((tag) => metadata.tags?.includes(tag));
      });
    }

    // Text search if provided
    if (query.text) {
      const searchText = query.text.toLowerCase();
      filtered = filtered.filter((row) =>
        row.content.toLowerCase().includes(searchText)
      );
    }

    return filtered.map((row) => ({
      entry: this.rowToEntry(row),
      score: this.calculateScore(row, query),
    }));
  }

  /**
   * Update a memory entry
   */
  updateMemory(id: string, updates: Partial<MemoryEntry>): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.expiresAt !== undefined) {
      fields.push('expires_at = ?');
      values.push(updates.expiresAt?.toISOString() ?? null);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());

    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE memory_entries
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...values);
    return result.changes > 0;
  }

  /**
   * Delete a memory entry
   */
  deleteMemory(id: string): boolean {
    // Delete embedding first
    this.db.prepare('DELETE FROM embeddings WHERE entry_id = ?').run(id);

    // Delete entry
    const result = this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ============================================================================
  // Embedding Operations
  // ============================================================================

  /**
   * Store an embedding for an entry
   */
  storeEmbedding(entryId: string, embedding: number[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (id, entry_id, embedding, model, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      uuid(),
      entryId,
      Buffer.from(new Float64Array(embedding).buffer),
      this.config.embeddingModel ?? 'default',
      new Date().toISOString()
    );
  }

  /**
   * Find similar entries by embedding
   */
  findSimilar(embedding: number[], limit: number = 10): MemorySearchResult[] {
    // Get all embeddings
    const rows = this.db.prepare(`
      SELECT e.entry_id, emb.embedding
      FROM embeddings emb
      JOIN memory_entries e ON emb.entry_id = e.id
    `).all() as any[];

    // Calculate similarities
    const similarities = rows.map((row) => {
      const storedEmbedding = Array.from(new Float64Array(row.embedding));
      const similarity = this.cosineSimilarity(embedding, storedEmbedding);
      return { id: row.entry_id, similarity };
    });

    // Sort by similarity
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Get top entries
    const topIds = similarities.slice(0, limit).map((s) => s.id);
    const entries = topIds.map((id) => this.getMemory(id)).filter((e): e is MemoryEntry => e !== null);

    return entries.map((entry, i) => ({
      entry,
      score: similarities[i].similarity,
    }));
  }

  // ============================================================================
  // Conversation Operations
  // ============================================================================

  /**
   * Store a conversation
   */
  storeConversation(record: Omit<ConversationRecord, 'id'>): ConversationRecord {
    const id = uuid();

    this.db.prepare(`
      INSERT INTO conversations (id, start_time, end_time, summary, metadata, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.startTime.toISOString(),
      record.endTime?.toISOString() ?? null,
      record.summary ?? null,
      JSON.stringify(record.metadata ?? {}),
      record.embedding ? Buffer.from(new Float64Array(record.embedding).buffer) : null
    );

    // Store turns
    for (const turn of record.turns) {
      this.storeTurn(id, turn);
    }

    return { ...record, id };
  }

  /**
   * Get a conversation by ID
   */
  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    if (!row) return null;

    const turns = this.getConversationTurns(id);
    return this.rowToConversation(row, turns);
  }

  /**
   * Get recent conversations
   */
  getRecentConversations(limit: number = 10): ConversationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversations
      ORDER BY start_time DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((row) => {
      const turns = this.getConversationTurns(row.id);
      return this.rowToConversation(row, turns);
    });
  }

  /**
   * Search conversations by content
   */
  searchConversations(query: string, limit: number = 10): ConversationRecord[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT c.* FROM conversations c
      JOIN conversation_turns t ON c.id = t.conversation_id
      WHERE t.content LIKE ?
      ORDER BY c.start_time DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as any[];

    return rows.map((row) => {
      const turns = this.getConversationTurns(row.id);
      return this.rowToConversation(row, turns);
    });
  }

  // ============================================================================
  // Execution Operations
  // ============================================================================

  /**
   * Store an execution record
   */
  storeExecution(record: Omit<ExecutionRecord, 'id'>): ExecutionRecord {
    const id = uuid();

    this.db.prepare(`
      INSERT INTO executions (id, agent_type, task, result, duration_ms, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.agentType,
      record.task,
      record.result,
      record.durationMs,
      record.timestamp.toISOString(),
      JSON.stringify(record.metadata ?? {})
    );

    return { ...record, id };
  }

  /**
   * Get executions by agent type
   */
  getExecutionsByAgent(agentType: string, limit: number = 50): ExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executions
      WHERE agent_type = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(agentType, limit) as any[];

    return rows.map(this.rowToExecution);
  }

  /**
   * Get recent executions
   */
  getRecentExecutions(limit: number = 50): ExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM executions
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(this.rowToExecution);
  }

  // ============================================================================
  // Pattern Operations
  // ============================================================================

  /**
   * Store a pattern
   */
  storePattern(pattern: Omit<PatternRecord, 'id'>): PatternRecord {
    const id = uuid();

    this.db.prepare(`
      INSERT INTO patterns (id, pattern_type, pattern, confidence, last_used, use_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      pattern.patternType,
      pattern.pattern,
      pattern.confidence,
      pattern.lastUsed.toISOString(),
      pattern.useCount
    );

    return { ...pattern, id };
  }

  /**
   * Get patterns by type
   */
  getPatternsByType(patternType: string): PatternRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM patterns
      WHERE pattern_type = ?
      ORDER BY confidence DESC
    `).all(patternType) as any[];

    return rows.map(this.rowToPattern);
  }

  /**
   * Update pattern confidence
   */
  updatePatternConfidence(id: string, confidence: number): void {
    this.db.prepare(`
      UPDATE patterns
      SET confidence = ?, last_used = CURRENT_TIMESTAMP, use_count = use_count + 1
      WHERE id = ?
    `).run(confidence, id);
  }

  // ============================================================================
  // Utility Operations
  // ============================================================================

  /**
   * Get database statistics
   */
  getStats(): {
    memoryEntries: number;
    conversations: number;
    executions: number;
    patterns: number;
    embeddings: number;
  } {
    const stats = {
      memoryEntries: (this.db.prepare('SELECT COUNT(*) as count FROM memory_entries').get() as any).count,
      conversations: (this.db.prepare('SELECT COUNT(*) as count FROM conversations').get() as any).count,
      executions: (this.db.prepare('SELECT COUNT(*) as count FROM executions').get() as any).count,
      patterns: (this.db.prepare('SELECT COUNT(*) as count FROM patterns').get() as any).count,
      embeddings: (this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as any).count,
    };

    return stats;
  }

  /**
   * Per-type memory_entries breakdown + oldest/newest timestamps — backs
   * MemoryManager.getStats() now that SQLite is the sole store for
   * MemoryEntry data (see architecture-optimal.md Phase 2 item A1).
   */
  getStatsDetailed(): {
    byType: Record<string, number>;
    oldestEntry?: Date;
    newestEntry?: Date;
  } {
    const rows = this.db
      .prepare(`SELECT type, COUNT(*) as count FROM memory_entries GROUP BY type`)
      .all() as { type: string; count: number }[];
    const byType: Record<string, number> = {};
    for (const row of rows) byType[row.type] = row.count;

    const bounds = this.db
      .prepare(
        `SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memory_entries`,
      )
      .get() as { oldest: string | null; newest: string | null };

    return {
      byType,
      oldestEntry: bounds.oldest ? new Date(bounds.oldest) : undefined,
      newestEntry: bounds.newest ? new Date(bounds.newest) : undefined,
    };
  }

  /**
   * Delete every memory_entries row (and any embeddings, now that SQLite is
   * the sole store — see architecture-optimal.md Phase 2 item A1). Does not
   * touch conversations/executions/patterns, which are separate histories.
   */
  clearAllMemory(): void {
    this.db.exec('DELETE FROM embeddings; DELETE FROM memory_entries;');
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    // expires_at is stored as a JS toISOString() string (T-separated, Z
    // suffix); bare CURRENT_TIMESTAMP is SQLite's space-separated format —
    // comparing them as raw TEXT is a lexicographic comparison of two
    // different formats and silently never matches, regardless of actual
    // chronology. datetime(...) normalizes both sides first.
    const result = this.db.prepare(`
      DELETE FROM memory_entries
      WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
    `).run();

    return result.changes;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    this.logger.debug('SQLite store closed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  storeTurn(conversationId: string, turn: ConversationTurn): void {
    this.db.prepare(`
      INSERT INTO conversation_turns (id, conversation_id, role, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      turn.id ?? uuid(),
      conversationId,
      turn.role,
      turn.content,
      turn.timestamp.toISOString(),
      JSON.stringify(turn.metadata ?? {})
    );
  }

  private getConversationTurns(conversationId: string): ConversationTurn[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_turns
      WHERE conversation_id = ?
      ORDER BY timestamp
    `).all(conversationId) as any[];

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: new Date(row.timestamp),
      metadata: JSON.parse(row.metadata ?? '{}'),
    }));
  }

  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      metadata: JSON.parse(row.metadata ?? '{}'),
      priority: row.priority as MemoryEntry['priority'],
      scope: (row.scope as MemoryEntry['scope']) ?? 'project',
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      accessCount: row.access_count,
    };
  }

  private rowToConversation(row: any, turns: ConversationTurn[]): ConversationRecord {
    return {
      id: row.id,
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : undefined,
      summary: row.summary ?? undefined,
      turns,
      embedding: row.embedding ? Array.from(new Float64Array(row.embedding)) : undefined,
      metadata: JSON.parse(row.metadata ?? '{}'),
    };
  }

  private rowToExecution(row: any): ExecutionRecord {
    return {
      id: row.id,
      agentType: row.agent_type,
      task: row.task,
      result: row.result,
      durationMs: row.duration_ms,
      timestamp: new Date(row.timestamp),
      metadata: JSON.parse(row.metadata ?? '{}'),
    };
  }

  private rowToPattern(row: any): PatternRecord {
    return {
      id: row.id,
      patternType: row.pattern_type,
      pattern: row.pattern,
      confidence: row.confidence,
      lastUsed: new Date(row.last_used),
      useCount: row.use_count,
    };
  }

  private calculateScore(row: any, query: MemoryQuery): number {
    let score = 0;

    // Priority score
    const priorityScores: Record<string, number> = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 };
    score += priorityScores[row.priority] ?? 0.5;

    // Recency score (newer is better)
    const ageDays = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 0.3 * (1 - ageDays / 30));

    // Access count (more accessed is better)
    score += Math.min(0.2, row.access_count * 0.01);

    return Math.min(1, score);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * Create a SQLiteStore instance
 */
export function createSQLiteStore(config?: Partial<SQLiteConfig>): SQLiteStore {
  const path = config?.path ?? join(process.cwd(), '.claude', 'memory.db');

  return new SQLiteStore({
    path,
    enableEmbeddings: config?.enableEmbeddings ?? true,
    embeddingModel: config?.embeddingModel ?? 'nomic-embed-text',
  });
}