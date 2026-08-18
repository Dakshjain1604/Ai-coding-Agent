/**
 * Tests for MemoryManager (architecture-optimal.md Phase 2, items A1/A3/A4/A5).
 *
 * A1: SQLite is now the sole store for MemoryEntry data — the retired
 * markdown dual-write (ProjectMemory) silently dropped expiresAt and most
 * metadata on every reload, so store() -> retrieve() must now round-trip
 * those fields losslessly.
 *
 * A3: fixes a live bug found in this repo's own .claude/memory.db —
 * BaseAgent.initializeContext() called memory.startConversation() but
 * discarded the returned ID, so conversation_turns (fully implemented,
 * never called) stayed empty for every one of 26 real conversations.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMemoryManager } from "../../src/memory/MemoryManager.js";

function tempMemoryManager(dir: string) {
  return createMemoryManager({
    project: { rootDir: dir },
    sqlite: { path: join(dir, ".claude", "memory.db") },
  });
}

describe("MemoryManager — SQLite as sole store (A1)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips expiresAt and full metadata through store() -> retrieve()", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const stored = await manager.store(
      "pattern",
      "use dependency injection here",
      { tags: ["di", "architecture"], custom: "some-value" },
      "high",
    );

    const retrieved = await manager.retrieve(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.expiresAt).toBeInstanceOf(Date);
    expect(retrieved?.metadata.tags).toEqual(["di", "architecture"]);
    expect(retrieved?.metadata.custom).toBe("some-value");

    manager.close();
  });
});

describe("MemoryManager — session turn recording (A3, fix for the live bug)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("recordTurn actually persists turns against the conversation id from startConversation", () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const conversationId = manager.startConversation();
    manager.recordTurn(conversationId, "user", "hello");
    manager.recordTurn(conversationId, "assistant", "hi there");

    const conversation = manager.getConversation(conversationId);
    expect(conversation?.turns).toHaveLength(2);
    expect(conversation?.turns[0].content).toBe("hello");
    expect(conversation?.turns[1].role).toBe("assistant");

    manager.close();
  });
});

describe("MemoryManager — remember/forget (A4)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("remember() stores scope:user, confidence 1.0, no expiry", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const entry = await manager.remember("I prefer tabs over spaces");
    expect(entry.scope).toBe("user");
    expect(entry.metadata.confidence).toBe(1.0);
    expect(entry.expiresAt).toBeUndefined();

    manager.close();
  });

  it("forget() removes the closest text match", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    await manager.remember("I prefer tabs over spaces");
    const removed = await manager.forget("tabs over spaces");
    expect(removed).toBe(true);

    const results = await manager.query({ scope: "user" });
    expect(results).toHaveLength(0);

    manager.close();
  });
});

describe("MemoryManager — confidence/expiry defaults (A5)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("inferred entries (the default) get confidence 0.5 and a future expiry", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const entry = await manager.store("pattern", "some inferred fact");
    expect(entry.metadata.confidence).toBe(0.5);
    expect(entry.expiresAt).toBeInstanceOf(Date);
    expect(entry.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    manager.close();
  });

  it("explicit entries (via remember) get confidence 1.0 and no expiry", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const entry = await manager.remember("explicit fact");
    expect(entry.metadata.confidence).toBe(1.0);
    expect(entry.expiresAt).toBeUndefined();

    manager.close();
  });

  it("cleanup() purges an entry once its expiresAt is in the past", async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-manager-test-"));
    const manager = tempMemoryManager(dir);

    const entry = await manager.store(
      "pattern",
      "already stale",
      { expiresAt: new Date(Date.now() - 1000) },
    );
    expect(await manager.retrieve(entry.id)).not.toBeNull();

    const removedCount = await manager.cleanup();
    expect(removedCount).toBeGreaterThanOrEqual(1);
    expect(await manager.retrieve(entry.id)).toBeNull();

    manager.close();
  });
});
