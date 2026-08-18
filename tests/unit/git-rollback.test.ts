/**
 * Tests for RollbackManager (utils/git-rollback.ts) — the snapshot-before-
 * write safety net wired into file_write/file_delete/file_move this phase.
 * Found while auditing: this class already existed fully built but had
 * ZERO call sites anywhere in src/ — file-mutating tools operated directly
 * on the real project tree (buildTaskSystemPrompt falls back to
 * process.cwd() as the output dir at every real call site) with no undo
 * path at all. These tests cover both the in-memory (same-process) undo
 * path and the on-disk (cross-process) fallback that makes it actually
 * useful for the CLI's dominant usage pattern: a single short-lived
 * `coding-agent run ...` process per invocation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RollbackManager,
  getRollbackManager,
  resetRollbackManager,
} from "../../src/utils/git-rollback.js";

describe("RollbackManager — snapshot/rollback (in-memory)", () => {
  let dir: string;
  let rb: RollbackManager;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rollback-test-"));
    rb = new RollbackManager(dir);
    target = join(dir, "file.txt");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when snapshotting a file that doesn't exist yet", () => {
    rb.snapshot(target);
    expect(rb.hasBackup(target)).toBe(false);
  });

  it("captures the current content before it's overwritten", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target);
    writeFileSync(target, "v2 — bad write");

    expect(readFileSync(target, "utf-8")).toBe("v2 — bad write");
    const restored = rb.rollback(target);
    expect(restored).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");
  });

  it("returns false rolling back a file that was never snapshotted", () => {
    writeFileSync(target, "untouched");
    expect(rb.rollback(target)).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("untouched");
  });

  it("returns false rolling back a path that was never even written", () => {
    expect(rb.rollback(join(dir, "never-existed.txt"))).toBe(false);
  });

  it("pops snapshots in LIFO order across repeated rollbacks", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target); // captures v1
    writeFileSync(target, "v2");
    rb.snapshot(target); // captures v2
    writeFileSync(target, "v3");

    expect(rb.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v2");

    expect(rb.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");
  });

  it("bounds in-memory history to the last 5 snapshots per file", () => {
    // Snapshot 7 times in a row (v0..v6 each captured before the next
    // write), so the oldest 2 (v0, v1) must be evicted from memory —
    // only v2..v6 stay poppable via in-memory rollback.
    writeFileSync(target, "v0");
    for (let i = 1; i <= 7; i++) {
      rb.snapshot(target); // captures v(i-1)
      writeFileSync(target, `v${i}`);
    }
    // Disk now holds v6 (5 memory), file content is v7.

    const restoredInMemory: string[] = [];
    for (let i = 0; i < 5; i++) {
      rb.rollback(target);
      restoredInMemory.push(readFileSync(target, "utf-8"));
    }
    // In-memory history pops LIFO: v6, v5, v4, v3, v2 — v1 and v0 were
    // evicted and must NOT appear here.
    expect(restoredInMemory).toEqual(["v6", "v5", "v4", "v3", "v2"]);
  });

  it("tracks multiple distinct files independently", () => {
    const other = join(dir, "other.txt");
    writeFileSync(target, "a1");
    writeFileSync(other, "b1");
    rb.snapshot(target);
    rb.snapshot(other);
    writeFileSync(target, "a2");
    writeFileSync(other, "b2");

    expect(rb.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("a1");
    // other's own rollback hasn't been called yet — untouched by target's
    // rollback, so it still holds whatever was last written to it.
    expect(readFileSync(other, "utf-8")).toBe("b2");

    expect(rb.rollback(other)).toBe(true);
    expect(readFileSync(other, "utf-8")).toBe("b1");
  });

  it("preserves the snapshot for a retry if the write-back itself fails", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target);
    writeFileSync(target, "v2");

    // Delete the parent directory out from under the target so
    // writeFileSync inside rollback() throws — the entry must not be
    // popped/lost as a result.
    rmSync(dir, { recursive: true, force: true });

    expect(rb.rollback(target)).toBe(false);
  });
});

describe("RollbackManager — disk-backed fallback across process boundaries", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rollback-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores from disk when a fresh instance has no in-memory history", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "original");
    const rb1 = new RollbackManager(dir);
    rb1.snapshot(target);
    writeFileSync(target, "corrupted");

    // A brand-new instance, as a later CLI invocation would construct —
    // no in-memory history at all.
    const rb2 = new RollbackManager(dir);
    expect(rb2.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  it("hasBackup() is true via disk even with no in-memory history", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "original");
    new RollbackManager(dir).snapshot(target);

    const rb2 = new RollbackManager(dir);
    expect(rb2.hasBackup(target)).toBe(true);
  });

  it("only persists the single most recent snapshot per file to disk", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    const rb1 = new RollbackManager(dir);
    rb1.snapshot(target); // disk: v1
    writeFileSync(target, "v2");
    rb1.snapshot(target); // disk: v2 (overwrites)
    writeFileSync(target, "v3");

    const rb2 = new RollbackManager(dir);
    expect(rb2.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v2");
  });

  it("creates the backup directory on first use, not eagerly at construction", () => {
    const backupDir = join(dir, ".claude", "rollback-backups");
    const rb = new RollbackManager(dir);
    expect(existsSync(backupDir)).toBe(false);

    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    rb.snapshot(target);
    expect(existsSync(backupDir)).toBe(true);
  });

  it("gracefully skips a corrupted on-disk backup file in listBackedUpFiles()", () => {
    const backupDir = join(dir, ".claude", "rollback-backups");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "garbage.json"), "{not valid json");

    const rb = new RollbackManager(dir);
    expect(() => rb.listBackedUpFiles()).not.toThrow();
    expect(rb.listBackedUpFiles()).toEqual([]);
  });

  it("silently no-ops (does not throw) when the backup dir can't be created", () => {
    // Point the "project root" at a path that doesn't exist and can't be
    // created (nested under a file, not a directory) — persistToDisk must
    // swallow the failure rather than propagate it out of snapshot().
    const blockerFile = join(dir, "not-a-directory");
    writeFileSync(blockerFile, "x");
    const rb = new RollbackManager(join(blockerFile, "nested"));

    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    expect(() => rb.snapshot(target)).not.toThrow();
    // In-memory history still works even though disk persistence failed.
    writeFileSync(target, "v2");
    expect(rb.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");
  });
});

describe("RollbackManager — peekBackup()", () => {
  let dir: string;
  let rb: RollbackManager;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rollback-test-"));
    rb = new RollbackManager(dir);
    target = join(dir, "file.txt");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the content a rollback would restore, without performing it", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target);
    writeFileSync(target, "v2");

    const peeked = rb.peekBackup(target);
    expect(peeked?.content).toBe("v1");
    // File on disk is untouched — peek must not mutate anything.
    expect(readFileSync(target, "utf-8")).toBe("v2");
  });

  it("is idempotent — calling it twice returns the same thing", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target);
    expect(rb.peekBackup(target)?.content).toBe("v1");
    expect(rb.peekBackup(target)?.content).toBe("v1");
  });

  it("does not consume the snapshot — rollback still works after peeking", () => {
    writeFileSync(target, "v1");
    rb.snapshot(target);
    writeFileSync(target, "v2");
    rb.peekBackup(target);

    expect(rb.rollback(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("v1");
  });

  it("falls back to disk like rollback() does when memory is empty", () => {
    writeFileSync(target, "v1");
    new RollbackManager(dir).snapshot(target);

    const rb2 = new RollbackManager(dir);
    expect(rb2.peekBackup(target)?.content).toBe("v1");
  });

  it("returns undefined when there's no backup at all", () => {
    expect(rb.peekBackup(target)).toBeUndefined();
  });
});

describe("RollbackManager — listBackedUpFiles()", () => {
  let dir: string;
  let rb: RollbackManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rollback-test-"));
    rb = new RollbackManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is empty when nothing has been snapshotted", () => {
    expect(rb.listBackedUpFiles()).toEqual([]);
  });

  it("lists a file after it's snapshotted", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    rb.snapshot(target);
    expect(rb.listBackedUpFiles()).toEqual([target]);
  });

  it("lists multiple distinct files, sorted", () => {
    const a = join(dir, "b-file.txt");
    const b = join(dir, "a-file.txt");
    writeFileSync(a, "1");
    writeFileSync(b, "2");
    rb.snapshot(a);
    rb.snapshot(b);
    expect(rb.listBackedUpFiles()).toEqual([b, a].sort());
  });

  it("does not list a path once its in-memory AND disk backups are both exhausted", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    rb.snapshot(target);
    expect(rb.listBackedUpFiles()).toContain(target);

    // Rolling back pops the sole in-memory snapshot, but the on-disk copy
    // (written by the same snapshot() call) is untouched by rollback(), so
    // the file must still be listed as recoverable afterward.
    rb.rollback(target);
    expect(rb.listBackedUpFiles()).toContain(target);
  });

  it("deduplicates a path present in both memory and disk", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    rb.snapshot(target);
    const listing = rb.listBackedUpFiles();
    expect(listing.filter((p) => p === target).length).toBe(1);
  });

  it("reflects disk-only entries visible from a completely fresh instance", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "v1");
    new RollbackManager(dir).snapshot(target);

    const rb2 = new RollbackManager(dir);
    expect(rb2.listBackedUpFiles()).toEqual([target]);
  });
});

describe("RollbackManager — generateDiffPreview()", () => {
  const rb = new RollbackManager(mkdtempSync(join(tmpdir(), "rollback-preview-")));

  it("shows removed and added lines for changed content", () => {
    const preview = rb.generateDiffPreview("f.txt", "line1\nline2", "line1\nCHANGED");
    expect(preview).toContain("- line2");
    expect(preview).toContain("+ CHANGED");
    expect(preview).not.toContain("- line1"); // unchanged line not shown
  });

  it("shows no diff lines when content is identical", () => {
    const preview = rb.generateDiffPreview("f.txt", "same\ncontent", "same\ncontent");
    expect(preview).not.toMatch(/^[+-] /m);
  });

  it("includes the new content as an addition when going from empty to non-empty", () => {
    // The line-by-line algorithm treats "".split("\n") as one empty-string
    // line, so it also emits a (contentless) "- " line for that empty old
    // line — documented existing behavior, not something this phase changes.
    const preview = rb.generateDiffPreview("f.txt", "", "new content");
    expect(preview).toContain("+ new content");
  });

  it("shows only deletions when going from non-empty to empty", () => {
    const preview = rb.generateDiffPreview("f.txt", "old content", "");
    expect(preview).toContain("- old content");
  });

  it("handles unicode content without throwing", () => {
    expect(() => rb.generateDiffPreview("f.txt", "héllo", "wörld 🎉")).not.toThrow();
  });

  it("includes the filename in the header", () => {
    const preview = rb.generateDiffPreview("src/app.ts", "a", "b");
    expect(preview).toContain("src/app.ts");
  });
});

describe("getRollbackManager() / resetRollbackManager() singleton", () => {
  afterEach(() => {
    resetRollbackManager();
  });

  it("returns the same instance across calls", () => {
    const a = getRollbackManager();
    const b = getRollbackManager();
    expect(a).toBe(b);
  });

  it("only applies projectRoot on first construction (seed-before-first-use)", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "rollback-seed1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "rollback-seed2-"));
    try {
      const first = getRollbackManager(dir1);
      const second = getRollbackManager(dir2); // ignored — instance already exists
      expect(first).toBe(second);

      // Prove dir1 (not dir2) is actually the backing root: snapshot via
      // the singleton, then confirm the backup landed under dir1.
      const target = join(dir1, "f.txt");
      writeFileSync(target, "v1");
      first.snapshot(target);
      expect(existsSync(join(dir1, ".claude", "rollback-backups"))).toBe(true);
      expect(existsSync(join(dir2, ".claude", "rollback-backups"))).toBe(false);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("resetRollbackManager() allows re-seeding with a different projectRoot", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "rollback-reset1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "rollback-reset2-"));
    try {
      const first = getRollbackManager(dir1);
      resetRollbackManager();
      const second = getRollbackManager(dir2);
      expect(first).not.toBe(second);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
