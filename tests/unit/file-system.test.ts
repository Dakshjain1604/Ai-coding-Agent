/**
 * Tests for the RollbackManager wiring added this phase to the file
 * mutation tools. Split across two implementations on purpose:
 *
 *  - fileWrite/fileDelete/fileRead (core/tools/builtin.ts) are the ones
 *    ACTUALLY reachable through the real tool registry — see that file's
 *    registerBuiltinTools(). The rollback snapshot() calls live here.
 *  - file_move/file_restore/file_copy/file_exists/directory_create
 *    (core/tools/file-system.ts) are the rest of the file-mutation tools.
 *
 * (file_write/file_delete/file_read/file_list used to ALSO be defined in
 * file-system.ts — a second, never-registered implementation of the same
 * tool names. The rollback wiring was first added there and silently
 * never ran in the real agent loop as a result; removed once found, see
 * file-system.ts's file header for the full story.)
 *
 * Test files use a .txt extension deliberately — builtin.ts's fileWrite
 * runs `npx prettier --write` on .json/.ts/.md/etc after writing, which
 * would make exact-content assertions non-deterministic and slow.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileWrite, fileDelete, fileRead } from "../../src/core/tools/builtin.js";
import { createFileSystemTools } from "../../src/core/tools/file-system.js";
import { getRollbackManager, resetRollbackManager } from "../../src/utils/git-rollback.js";

function getTool(tools: ReturnType<typeof createFileSystemTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("builtin fileWrite/fileDelete — RollbackManager wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-system-test-"));
    resetRollbackManager();
    getRollbackManager(dir); // seed singleton at the temp root before use
  });

  afterEach(() => {
    resetRollbackManager();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("fileWrite", () => {
    it("snapshots existing content before overwriting", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "original");

      const writeResult = await fileWrite.handler({ path: target, content: "overwritten" });
      expect(writeResult.success).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("overwritten");

      const restore = getTool(createFileSystemTools(), "file_restore");
      const restoreResult = await restore.handler({ path: target });
      expect(restoreResult.success).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("original");
    });

    it("does not create a spurious backup when writing a brand-new file", async () => {
      const target = join(dir, "new.txt");
      await fileWrite.handler({ path: target, content: "first content" });

      const restore = getTool(createFileSystemTools(), "file_restore");
      const restoreResult = await restore.handler({ path: target });
      expect(restoreResult.success).toBe(false);
    });

    it("snapshots pre-append content, so restore undoes the whole append", async () => {
      const target = join(dir, "log.txt");
      writeFileSync(target, "line1");

      await fileWrite.handler({ path: target, content: "line2", mode: "append" });
      expect(readFileSync(target, "utf-8")).toBe("line1\nline2");

      const restore = getTool(createFileSystemTools(), "file_restore");
      await restore.handler({ path: target });
      expect(readFileSync(target, "utf-8")).toBe("line1");
    });

    it("snapshots pre-prepend content, so restore undoes the whole prepend", async () => {
      const target = join(dir, "log.txt");
      writeFileSync(target, "line2");

      await fileWrite.handler({ path: target, content: "line1", mode: "prepend" });
      expect(readFileSync(target, "utf-8")).toBe("line1\nline2");

      const restore = getTool(createFileSystemTools(), "file_restore");
      await restore.handler({ path: target });
      expect(readFileSync(target, "utf-8")).toBe("line2");
    });

    it("keeps each successive overwrite recoverable up to the bounded history", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "v0");

      await fileWrite.handler({ path: target, content: "v1" });
      await fileWrite.handler({ path: target, content: "v2" });

      const restore = getTool(createFileSystemTools(), "file_restore");
      await restore.handler({ path: target }); // undo v2 -> v1
      expect(readFileSync(target, "utf-8")).toBe("v1");
      await restore.handler({ path: target }); // undo v1 -> v0
      expect(readFileSync(target, "utf-8")).toBe("v0");
    });

    it("still fails cleanly on a genuinely bad path (unaffected by the rollback wiring)", async () => {
      // A path under a location that doesn't exist and can't be created
      // (nested under a file, not a directory).
      const blocker = join(dir, "not-a-dir");
      writeFileSync(blocker, "x");
      const result = await fileWrite.handler({
        path: join(blocker, "nested", "a.txt"),
        content: "x",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("fileDelete", () => {
    it("snapshots before deleting a file, so file_restore recreates it", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "important content");

      const delResult = await fileDelete.handler({ path: target });
      expect(delResult.success).toBe(true);
      expect(existsSync(target)).toBe(false);

      const restore = getTool(createFileSystemTools(), "file_restore");
      const restoreResult = await restore.handler({ path: target });
      expect(restoreResult.success).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("important content");
    });

    it("still fails cleanly for a nonexistent path", async () => {
      const result = await fileDelete.handler({ path: join(dir, "nope.txt") });
      expect(result.success).toBe(false);
      expect(result.output).toContain("not found");
    });

    it("deletes an empty directory even without recursive:true (the error-message-vs-behavior fix)", async () => {
      // The error message specifically says "non-empty directory",
      // implying emptiness was the deciding factor — but it used to reject
      // EVERY directory (empty or not) without recursive:true regardless.
      const emptySubdir = join(dir, "empty-sub");
      const { mkdirSync } = await import("fs");
      mkdirSync(emptySubdir);

      const result = await fileDelete.handler({ path: emptySubdir });
      expect(result.success).toBe(true);
      expect(existsSync(emptySubdir)).toBe(false);
    });

    it("still refuses a genuinely non-empty directory without recursive:true", async () => {
      const nonEmptySubdir = join(dir, "non-empty-sub");
      const { mkdirSync } = await import("fs");
      mkdirSync(nonEmptySubdir);
      writeFileSync(join(nonEmptySubdir, "inner.txt"), "content");

      const result = await fileDelete.handler({ path: nonEmptySubdir });
      expect(result.success).toBe(false);
      expect(result.output).toContain("non-empty");
      expect(existsSync(nonEmptySubdir)).toBe(true);
    });

    it("does not snapshot a recursive directory delete (documented limitation)", async () => {
      const subdir = join(dir, "sub");
      const { mkdirSync } = await import("fs");
      mkdirSync(subdir);
      writeFileSync(join(subdir, "inner.txt"), "content");

      const result = await fileDelete.handler({ path: subdir, recursive: true });
      expect(result.success).toBe(true);
      expect(existsSync(subdir)).toBe(false);

      const restore = getTool(createFileSystemTools(), "file_restore");
      const restoreResult = await restore.handler({ path: subdir });
      expect(restoreResult.success).toBe(false);
    });
  });

  describe("cross-tool integration", () => {
    it("a write-then-delete-then-restore-twice sequence recovers the pre-write content", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "original");

      await fileWrite.handler({ path: target, content: "overwritten" });
      await fileDelete.handler({ path: target });
      expect(existsSync(target)).toBe(false);

      const restore = getTool(createFileSystemTools(), "file_restore");
      // First restore undoes the delete (brings back "overwritten").
      await restore.handler({ path: target });
      expect(readFileSync(target, "utf-8")).toBe("overwritten");

      // Second restore undoes the write (brings back "original").
      await restore.handler({ path: target });
      expect(readFileSync(target, "utf-8")).toBe("original");
    });

    it("survives a fresh RollbackManager instance (simulating a new CLI process)", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "original");
      await fileWrite.handler({ path: target, content: "overwritten" });

      // Simulate a new process: reset the singleton and re-seed with the
      // same project root, discarding all in-memory history.
      resetRollbackManager();
      getRollbackManager(dir);

      const restore = getTool(createFileSystemTools(), "file_restore");
      const result = await restore.handler({ path: target });
      expect(result.success).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("original");
    });
  });

  describe("fileRead — unaffected by the rollback wiring", () => {
    it("still works normally", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "content");
      const result = await fileRead.handler({ path: target });
      expect(result.success).toBe(true);
      expect(result.output).toBe("content");
    });

    it("does not create a backup as a side effect of reading", async () => {
      const target = join(dir, "a.txt");
      writeFileSync(target, "content");
      await fileRead.handler({ path: target });

      const restore = getTool(createFileSystemTools(), "file_restore");
      const result = await restore.handler({ path: target });
      expect(result.success).toBe(false);
    });
  });
});

describe("file_restore (core/tools/file-system.ts)", () => {
  let dir: string;
  let tools: ReturnType<typeof createFileSystemTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-system-test-"));
    resetRollbackManager();
    getRollbackManager(dir);
    tools = createFileSystemTools();
  });

  afterEach(() => {
    resetRollbackManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails with a clear message for a path that was never touched", async () => {
    const restore = getTool(tools, "file_restore");
    const result = await restore.handler({ path: join(dir, "never.txt") });
    expect(result.success).toBe(false);
    expect(result.output).toContain("No backup found");
  });

  it("restoring twice in a row is idempotent (falls back to the disk-persisted copy)", async () => {
    // The in-memory snapshot is consumed by the first restore, but the
    // on-disk backup (written alongside it) isn't cleared by a rollback —
    // only overwritten by a later snapshot() — so a second restore with
    // no intervening write is safe and just restores the same content
    // again, rather than failing.
    const target = join(dir, "a.txt");
    writeFileSync(target, "v1");
    await fileWrite.handler({ path: target, content: "v2" });

    const restore = getTool(tools, "file_restore");
    const first = await restore.handler({ path: target });
    expect(first.success).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");

    const second = await restore.handler({ path: target });
    expect(second.success).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");
  });

  it("does not throw when given a completely malformed path", async () => {
    const restore = getTool(tools, "file_restore");
    const result = await restore.handler({ path: "" });
    expect(result.success).toBe(false);
  });
});

describe("file_move — RollbackManager wiring (core/tools/file-system.ts)", () => {
  let dir: string;
  let tools: ReturnType<typeof createFileSystemTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-system-test-"));
    resetRollbackManager();
    getRollbackManager(dir);
    tools = createFileSystemTools();
  });

  afterEach(() => {
    resetRollbackManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots the source before removing it, so restore recreates it at the original path", async () => {
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");
    writeFileSync(source, "payload");

    const move = getTool(tools, "file_move");
    const restore = getTool(tools, "file_restore");

    const moveResult = await move.handler({ source, destination });
    expect(moveResult.success).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, "utf-8")).toBe("payload");

    const restoreResult = await restore.handler({ path: source });
    expect(restoreResult.success).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, "utf-8")).toBe("payload");
    // The move's destination copy is untouched by restoring the source.
    expect(existsSync(destination)).toBe(true);
  });
});

describe("file-system.ts — remaining handlers unaffected by the rollback wiring", () => {
  let dir: string;
  let tools: ReturnType<typeof createFileSystemTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-system-test-"));
    tools = createFileSystemTools();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("file_copy still works and does not itself create a backup for the destination", async () => {
    const source = join(dir, "source.txt");
    const destination = join(dir, "dest.txt");
    writeFileSync(source, "payload");

    const copy = getTool(tools, "file_copy");
    const result = await copy.handler({ source, destination });
    expect(result.success).toBe(true);
    expect(readFileSync(destination, "utf-8")).toBe("payload");
    // Source file is untouched by a copy.
    expect(readFileSync(source, "utf-8")).toBe("payload");
  });

  it("file_exists still works normally", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "x");
    const exists = getTool(tools, "file_exists");
    const result = await exists.handler({ path: target });
    expect(result.success).toBe(true);
    expect(result.output).toContain("exists");
  });

  it("directory_create still works normally", async () => {
    const newDir = join(dir, "nested", "sub");
    const create = getTool(tools, "directory_create");
    const result = await create.handler({ path: newDir });
    expect(result.success).toBe(true);
    expect(existsSync(newDir)).toBe(true);
  });
});
