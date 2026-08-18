/**
 * Tests for SQLiteStore (architecture-optimal.md Phase 2, items A1/A2).
 * This module had zero test coverage before this pass. The migration test
 * is the important one: `CREATE TABLE IF NOT EXISTS` is a no-op against a
 * table that already exists on disk, so adding the `scope` column requires
 * an explicit `ALTER TABLE` migration — this repo's own `.claude/memory.db`
 * predates the column, so this isn't a hypothetical concern.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SQLiteStore } from "../../src/memory/SQLiteStore.js";

describe("SQLiteStore schema migration", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds the scope column to a pre-existing db without the column, defaulting existing rows to 'project'", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-migration-test-"));
    const dbPath = join(dir, "memory.db");

    // Build a db with the OLD schema (no scope column) and one pre-existing
    // row, simulating a real project's .claude/memory.db from before this
    // migration existed.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        priority TEXT DEFAULT 'medium',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        access_count INTEGER DEFAULT 0
      );
    `);
    raw.prepare(
      `INSERT INTO memory_entries (id, type, content, metadata, priority) VALUES (?, ?, ?, ?, ?)`,
    ).run("pre-existing-1", "pattern", "old row", "{}", "medium");
    raw.close();

    // Constructing SQLiteStore against the same file must not throw, and
    // must migrate the pre-existing row to scope:'project'.
    const store = new SQLiteStore({ path: dbPath, enableEmbeddings: false });
    const entry = store.getMemory("pre-existing-1");

    expect(entry).not.toBeNull();
    expect(entry?.scope).toBe("project");
    store.close();
  });

  it("is idempotent — running initialize twice against the same file does not throw", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-migration-test-"));
    const dbPath = join(dir, "memory.db");

    const first = new SQLiteStore({ path: dbPath, enableEmbeddings: false });
    first.close();

    expect(() => {
      const second = new SQLiteStore({ path: dbPath, enableEmbeddings: false });
      second.close();
    }).not.toThrow();
  });
});

describe("SQLiteStore scope-filtered queries", () => {
  let dir: string;
  let store: SQLiteStore;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("filters queryMemory by scope", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-scope-test-"));
    store = new SQLiteStore({
      path: join(dir, "memory.db"),
      enableEmbeddings: false,
    });

    store.storeMemory({
      type: "preference",
      content: "user likes tabs",
      metadata: {},
      priority: "high",
      scope: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      accessCount: 0,
    });
    store.storeMemory({
      type: "pattern",
      content: "project uses vitest",
      metadata: {},
      priority: "medium",
      scope: "project",
      createdAt: new Date(),
      updatedAt: new Date(),
      accessCount: 0,
    });

    const userResults = store.queryMemory({ scope: "user" });
    expect(userResults).toHaveLength(1);
    expect(userResults[0].entry.content).toBe("user likes tabs");

    const projectResults = store.queryMemory({ scope: "project" });
    expect(projectResults).toHaveLength(1);
    expect(projectResults[0].entry.content).toBe("project uses vitest");
  });
});
