/**
 * Project Memory - File-based memory storage in .claude/memory/
 * Human-readable markdown files for architecture, patterns, preferences
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, basename, dirname } from "path";
import { getLogger } from "../utils/logger.js";
import type {
  MemoryEntry,
  MemoryType,
  MemoryQuery,
  MemorySearchResult,
  ProjectMemoryConfig,
  MemoryFile,
  DecisionRecord,
  PatternRecord,
} from "./types.js";
import { v4 as uuid } from "uuid";

/**
 * Default memory file names
 */
const MEMORY_FILES = {
  patterns: "patterns.md",
  architecture: "architecture.md",
  preferences: "preferences.md",
  decisions: "decisions.md",
  learnings: "learnings.md",
} as const;

/**
 * Project Memory Manager
 * Handles file-based memory storage in the .claude/memory/ directory
 */
export class ProjectMemory {
  private config: ProjectMemoryConfig;
  private cache: Map<string, MemoryEntry> = new Map();
  private logger = getLogger();

  constructor(config: ProjectMemoryConfig) {
    this.config = config;
    this.ensureDirectory();
  }

  /**
   * Store a memory entry
   */
  async store(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "accessCount">,
  ): Promise<MemoryEntry> {
    const id = uuid();
    const now = new Date();

    const fullEntry: MemoryEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    // Write to appropriate file based on type
    const filePath = this.getFilePath(entry.type);
    this.appendToFile(filePath, fullEntry);

    // Update cache
    this.cache.set(id, fullEntry);

    this.logger.memoryStore(entry.type);
    return fullEntry;
  }

  /**
   * Retrieve a memory entry by ID
   */
  async retrieve(id: string): Promise<MemoryEntry | null> {
    // Check cache first
    if (this.cache.has(id)) {
      const entry = this.cache.get(id)!;
      entry.accessCount++;
      this.logger.memoryRetrieve(id);
      return entry;
    }

    // Search all files
    const entry = await this.searchFilesForId(id);
    if (entry) {
      entry.accessCount++;
      this.cache.set(id, entry);
      this.logger.memoryRetrieve(id);
    }

    return entry;
  }

  /**
   * Query memory entries
   */
  async query(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const entries = await this.loadAllEntries();
    let filtered = entries;

    // Apply filters
    if (query.type) {
      filtered = filtered.filter((e) => e.type === query.type);
    }

    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter((e) =>
        query.tags!.some((tag) => e.metadata.tags?.includes(tag)),
      );
    }

    if (query.startDate) {
      filtered = filtered.filter((e) => e.createdAt >= query.startDate!);
    }

    if (query.endDate) {
      filtered = filtered.filter((e) => e.createdAt <= query.endDate!);
    }

    if (query.minConfidence !== undefined) {
      filtered = filtered.filter(
        (e) => (e.metadata.confidence ?? 0) >= query.minConfidence!,
      );
    }

    // Text search if provided
    if (query.text) {
      const searchText = query.text.toLowerCase();
      filtered = filtered.filter((e) =>
        e.content.toLowerCase().includes(searchText),
      );
    }

    // Sort by relevance/recent
    filtered.sort((a, b) => {
      // Prefer higher priority
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.priority] ?? 2;
      const bPriority = priorityOrder[b.priority] ?? 2;
      if (aPriority !== bPriority) return bPriority - aPriority;

      // Then by recency
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const paginated = filtered.slice(offset, offset + limit);

    return paginated.map((entry) => ({
      entry,
      score: this.calculateRelevanceScore(entry, query),
    }));
  }

  /**
   * Update an existing entry
   */
  async update(
    id: string,
    updates: Partial<MemoryEntry>,
  ): Promise<MemoryEntry | null> {
    const entry = await this.retrieve(id);
    if (!entry) return null;

    const updated: MemoryEntry = {
      ...entry,
      ...updates,
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: new Date(),
    };

    // Rewrite the file with updated entry
    this.updateInFile(entry.type, id, updated);

    this.cache.set(id, updated);
    return updated;
  }

  /**
   * Delete an entry
   */
  async delete(id: string): Promise<boolean> {
    const entry = await this.retrieve(id);
    if (!entry) return false;

    this.removeFromFile(entry.type, id);
    this.cache.delete(id);
    return true;
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalEntries: number;
    byType: Record<MemoryType, number>;
    oldestEntry?: Date;
    newestEntry?: Date;
  }> {
    const entries = await this.loadAllEntries();

    const byType: Record<MemoryType, number> = {
      pattern: 0,
      decision: 0,
      preference: 0,
      conversation: 0,
      execution: 0,
      plan: 0,
    };

    for (const entry of entries) {
      byType[entry.type]++;
    }

    const sorted = entries.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return {
      totalEntries: entries.length,
      byType,
      oldestEntry: sorted[0]?.createdAt,
      newestEntry: sorted[sorted.length - 1]?.createdAt,
    };
  }

  /**
   * Clear all memory (with backup)
   */
  async clear(): Promise<void> {
    const backupDir = join(
      this.config.memoryDir,
      "backup",
      new Date().toISOString(),
    );
    mkdirSync(backupDir, { recursive: true });

    // Backup existing files
    for (const file of Object.values(MEMORY_FILES)) {
      const srcPath = join(this.config.memoryDir, file);
      if (existsSync(srcPath)) {
        const destPath = join(backupDir, file);
        writeFileSync(destPath, readFileSync(srcPath));
      }
    }

    // Clear files
    this.cache.clear();
    this.logger.info("Memory cleared and backed up to " + backupDir);
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  private ensureDirectory(): void {
    if (!existsSync(this.config.memoryDir)) {
      mkdirSync(this.config.memoryDir, { recursive: true });
    }

    // Ensure all memory files exist
    for (const file of Object.values(MEMORY_FILES)) {
      const filePath = join(this.config.memoryDir, file);
      if (!existsSync(filePath)) {
        this.initializeFile(filePath, file);
      }
    }
  }

  private initializeFile(filePath: string, type: string): void {
    const headers: Record<string, string> = {
      [MEMORY_FILES.patterns]:
        "# Learned Patterns\n\nThis file stores patterns learned from interactions.\n\n",
      [MEMORY_FILES.architecture]:
        "# Architecture Decisions\n\nThis file stores architectural decisions and their rationale.\n\n",
      [MEMORY_FILES.preferences]:
        "# User Preferences\n\nThis file stores user preferences and configurations.\n\n",
      [MEMORY_FILES.decisions]:
        "# Decisions\n\nThis file stores important decisions made during development.\n\n",
      [MEMORY_FILES.learnings]:
        "# Learnings\n\nThis file stores learnings and insights from coding sessions.\n\n",
    };

    writeFileSync(filePath, headers[type] ?? "");
  }

  private getFilePath(type: MemoryType): string {
    const fileMap: Record<MemoryType, string> = {
      pattern: MEMORY_FILES.patterns,
      decision: MEMORY_FILES.decisions,
      preference: MEMORY_FILES.preferences,
      conversation: MEMORY_FILES.learnings,
      execution: MEMORY_FILES.learnings,
      plan: MEMORY_FILES.learnings,
    };

    return join(this.config.memoryDir, fileMap[type]);
  }

  private appendToFile(filePath: string, entry: MemoryEntry): void {
    const timestamp = entry.createdAt.toISOString();
    const tags = entry.metadata.tags?.join(", ") ?? "";
    const content = `
## Entry: ${entry.id}
**Type:** ${entry.type}
**Priority:** ${entry.priority}
**Timestamp:** ${timestamp}
${tags ? `**Tags:** ${tags}` : ""}
${entry.metadata.confidence ? `**Confidence:** ${entry.metadata.confidence}` : ""}

${entry.content}

---
`;

    const current = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    writeFileSync(filePath, current + content);
  }

  private updateInFile(type: MemoryType, id: string, entry: MemoryEntry): void {
    const filePath = this.getFilePath(type);
    if (!existsSync(filePath)) return;

    const content = readFileSync(filePath, "utf-8");
    const entryPattern = new RegExp(`## Entry: ${id}[\\s\\S]*?---`, "g");

    if (entryPattern.test(content)) {
      const newEntry = this.formatEntry(entry);
      const updated = content.replace(entryPattern, newEntry);
      writeFileSync(filePath, updated);
    }
  }

  private removeFromFile(type: MemoryType, id: string): void {
    const filePath = this.getFilePath(type);
    if (!existsSync(filePath)) return;

    const content = readFileSync(filePath, "utf-8");
    const entryPattern = new RegExp(`## Entry: ${id}[\\s\\S]*?---\\n?`, "g");

    const updated = content.replace(entryPattern, "");
    writeFileSync(filePath, updated);
  }

  private formatEntry(entry: MemoryEntry): string {
    const timestamp = entry.updatedAt.toISOString();
    const tags = entry.metadata.tags?.join(", ") ?? "";
    const confidence = entry.metadata.confidence
      ? `**Confidence:** ${entry.metadata.confidence}`
      : "";

    return `
## Entry: ${entry.id}
**Type:** ${entry.type}
**Priority:** ${entry.priority}
**Timestamp:** ${timestamp}
${tags ? `**Tags:** ${tags}` : ""}
${confidence}

${entry.content}

---
`;
  }

  private async loadAllEntries(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];

    for (const file of Object.values(MEMORY_FILES)) {
      const filePath = join(this.config.memoryDir, file);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, "utf-8");
      const parsed = this.parseEntries(content);
      entries.push(...parsed);
    }

    return entries;
  }

  private parseEntries(content: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const entryPattern = /## Entry: ([^\n]+)[\s\S]*?---/g;

    let match;
    while ((match = entryPattern.exec(content)) !== null) {
      const entry = this.parseEntry(match[0]);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private parseEntry(content: string): MemoryEntry | null {
    try {
      const idMatch = content.match(/## Entry: ([^\n]+)/);
      const typeMatch = content.match(/\*\*Type:\*\* (\w+)/);
      const priorityMatch = content.match(/\*\*Priority:\*\* (\w+)/);
      const timestampMatch = content.match(/\*\*Timestamp:\*\* ([^\n]+)/);
      const tagsMatch = content.match(/\*\*Tags:\*\* ([^\n]+)/);
      const confidenceMatch = content.match(/\*\*Confidence:\*\* ([\d.]+)/);

      // Extract main content (between metadata and ---)
      const contentMatch = content.match(
        /\*\*[^*]+\*\*[^\n]*\n+([\s\S]*?)\n---/,
      );

      if (!idMatch || !typeMatch || !timestampMatch) {
        return null;
      }

      const mainContent = contentMatch?.[1]?.trim() ?? "";

      return {
        id: idMatch[1],
        type: typeMatch[1] as MemoryType,
        priority: (priorityMatch?.[1] as MemoryEntry["priority"]) ?? "medium",
        content: mainContent,
        metadata: {
          tags: tagsMatch?.[1]?.split(", ").filter(Boolean),
          confidence: confidenceMatch
            ? parseFloat(confidenceMatch[1])
            : undefined,
        },
        createdAt: new Date(timestampMatch[1]),
        updatedAt: new Date(timestampMatch[1]),
        accessCount: 0,
      };
    } catch {
      return null;
    }
  }

  private async searchFilesForId(id: string): Promise<MemoryEntry | null> {
    const entries = await this.loadAllEntries();
    return entries.find((e) => e.id === id) ?? null;
  }

  private calculateRelevanceScore(
    entry: MemoryEntry,
    query: MemoryQuery,
  ): number {
    let score = 0;

    // Type match
    if (query.type && entry.type === query.type) {
      score += 0.3;
    }

    // Tag match
    if (query.tags && query.tags.length > 0) {
      const matchingTags = query.tags.filter((t) =>
        entry.metadata.tags?.includes(t),
      );
      score += (matchingTags.length / query.tags.length) * 0.2;
    }

    // Text match
    if (query.text) {
      const text = query.text.toLowerCase();
      if (entry.content.toLowerCase().includes(text)) {
        score += 0.3;
      }
    }

    // Priority boost
    const priorityScores = {
      critical: 0.2,
      high: 0.15,
      medium: 0.1,
      low: 0.05,
    };
    score += priorityScores[entry.priority] ?? 0.1;

    // Recency boost
    const ageDays =
      (Date.now() - entry.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 0.1 * (1 - ageDays / 30)); // Decay over 30 days

    return Math.min(1, score);
  }

  async loadAll(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const memoryDir = this.config.memoryDir;

    if (!existsSync(memoryDir)) return entries;

    const files = readdirSync(memoryDir).filter(
      (f) => f.endsWith(".md") || f.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const filePath = join(memoryDir, file);
        const raw = readFileSync(filePath, "utf-8");
        if (file.endsWith(".json")) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item.content) {
                entries.push({
                  id: item.id ?? uuid(),
                  type: item.type ?? "execution",
                  content: item.content,
                  metadata: item.metadata ?? {},
                  createdAt: item.createdAt
                    ? new Date(item.createdAt)
                    : new Date(),
                  updatedAt: item.updatedAt
                    ? new Date(item.updatedAt)
                    : new Date(),
                  accessCount: item.accessCount ?? 0,
                  priority: item.priority ?? "medium",
                });
              }
            }
          }
        } else {
          const parsed = this.parseEntries(raw);
          entries.push(...parsed);
        }
      } catch {
        // Skip corrupt files
      }
    }
    return entries;
  }

  async batchWrite(entries: MemoryEntry[]): Promise<void> {
    const byType = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const group = byType.get(entry.type) ?? [];
      group.push(entry);
      byType.set(entry.type, group);
    }
    for (const [type, typeEntries] of byType) {
      const filePath = this.getFilePath(type as MemoryType);
      const existing = existsSync(filePath)
        ? readFileSync(filePath, "utf-8")
        : "";
      let newContent = existing;
      for (const entry of typeEntries) {
        newContent += `\n## Entry: ${entry.id}\n**Type:** ${entry.type}\n**Priority:** ${entry.priority}\n**Timestamp:** ${entry.createdAt.toISOString()}\n\n${entry.content}\n\n---\n`;
      }
      writeFileSync(filePath, newContent);
    }
  }
}

/**
 * Create a ProjectMemory instance
 */
export function createProjectMemory(
  config?: Partial<ProjectMemoryConfig>,
): ProjectMemory {
  const rootDir = config?.rootDir ?? process.cwd();
  const memoryDir = config?.memoryDir ?? join(rootDir, ".claude", "memory");

  return new ProjectMemory({
    rootDir,
    memoryDir,
    maxFileSize: config?.maxFileSize ?? 10 * 1024 * 1024, // 10MB
    autoSave: config?.autoSave ?? true,
  });
}
