/**
 * Tests for diff-merge.ts — generateUnifiedDiff/applyDiff (the `apply`
 * command's core pipeline) and generateSimpleDiff.
 *
 * applyDiff() is the focus of the rollback-wiring fix this phase: it
 * overwrites the real source tree in bulk, across every changed file in
 * one shot, and previously had zero backup path — exactly the kind of
 * high-blast-radius write the RollbackManager safety net (wired into
 * file_write/file_delete/file_move two phases ago) exists for, but this
 * separate write path never went through it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  generateUnifiedDiff,
  applyDiff,
  generateSimpleDiff,
} from "../../src/utils/diff-merge.js";
import { createFileSystemTools } from "../../src/core/tools/file-system.js";
import { getRollbackManager, resetRollbackManager } from "../../src/utils/git-rollback.js";

describe("generateUnifiedDiff", () => {
  let outputDir: string;
  let sourceDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "diff-merge-output-"));
    sourceDir = mkdtempSync(join(tmpdir(), "diff-merge-source-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("returns no diffs when output and source are identical", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "same content");
    writeFileSync(join(outputDir, "a.txt"), "same content");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs).toEqual([]);
  });

  it("detects a modified file", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "old content");
    writeFileSync(join(outputDir, "a.txt"), "new content");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0].path).toBe("a.txt");
    expect(diffs[0].isNew).toBe(false);
    expect(diffs[0].additions).toBeGreaterThan(0);
    expect(diffs[0].deletions).toBeGreaterThan(0);
  });

  it("marks a brand-new file (no source counterpart) as isNew", async () => {
    writeFileSync(join(outputDir, "new.txt"), "brand new content");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0].isNew).toBe(true);
    expect(diffs[0].additions).toBeGreaterThan(0);
    expect(diffs[0].deletions).toBe(0);
  });

  it("detects multiple changed files at once", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "a-old");
    writeFileSync(join(outputDir, "a.txt"), "a-new");
    writeFileSync(join(outputDir, "b.txt"), "b-new-file");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs.length).toBe(2);
    expect(diffs.map((d) => d.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("skips .tasks/ metadata files", async () => {
    mkdirSync(join(outputDir, ".tasks"));
    writeFileSync(join(outputDir, ".tasks", "meta.json"), "{}");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs).toEqual([]);
  });

  it("skips *.task.json files", async () => {
    writeFileSync(join(outputDir, "abc.task.json"), "{}");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs).toEqual([]);
  });

  it("detects a file present in nested subdirectories", async () => {
    mkdirSync(join(outputDir, "src", "nested"), { recursive: true });
    writeFileSync(join(outputDir, "src", "nested", "deep.txt"), "deep content");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0].path).toBe(join("src", "nested", "deep.txt"));
  });

  it("produces a valid unified diff string", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "line1\nline2\n");
    writeFileSync(join(outputDir, "a.txt"), "line1\nCHANGED\n");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs[0].unified).toContain("-line2");
    expect(diffs[0].unified).toContain("+CHANGED");
  });

  it("sets outputPath/sourcePath to the correct absolute paths", async () => {
    writeFileSync(join(outputDir, "a.txt"), "content");
    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diffs[0].outputPath).toBe(join(outputDir, "a.txt"));
    expect(diffs[0].sourcePath).toBe(join(sourceDir, "a.txt"));
  });
});

describe("applyDiff — RollbackManager wiring", () => {
  let outputDir: string;
  let sourceDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "diff-merge-output-"));
    sourceDir = mkdtempSync(join(tmpdir(), "diff-merge-source-"));
    resetRollbackManager();
    getRollbackManager(sourceDir);
  });

  afterEach(() => {
    resetRollbackManager();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("overwrites the source file with the output content", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "original");
    writeFileSync(join(outputDir, "a.txt"), "updated");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    await applyDiff(diff, sourceDir);

    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe("updated");
  });

  it("snapshots the pre-apply content, so file_restore can undo the apply", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "original");
    writeFileSync(join(outputDir, "a.txt"), "updated");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    await applyDiff(diff, sourceDir);
    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe("updated");

    const restore = createFileSystemTools().find((t) => t.name === "file_restore")!;
    const result = await restore.handler({ path: join(sourceDir, "a.txt") });
    expect(result.success).toBe(true);
    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe("original");
  });

  it("does not create a spurious backup for a brand-new file", async () => {
    writeFileSync(join(outputDir, "new.txt"), "brand new");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    expect(diff.isNew).toBe(true);
    await applyDiff(diff, sourceDir);

    const restore = createFileSystemTools().find((t) => t.name === "file_restore")!;
    const result = await restore.handler({ path: join(sourceDir, "new.txt") });
    expect(result.success).toBe(false);
  });

  it("creates parent directories for a nested new file", async () => {
    mkdirSync(join(outputDir, "deep", "nested"), { recursive: true });
    writeFileSync(join(outputDir, "deep", "nested", "file.txt"), "content");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    await applyDiff(diff, sourceDir);

    expect(existsSync(join(sourceDir, "deep", "nested", "file.txt"))).toBe(true);
  });

  it("applying multiple diffs in sequence backs up each one independently", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "a-original");
    writeFileSync(join(sourceDir, "b.txt"), "b-original");
    writeFileSync(join(outputDir, "a.txt"), "a-updated");
    writeFileSync(join(outputDir, "b.txt"), "b-updated");

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);
    for (const diff of diffs) {
      await applyDiff(diff, sourceDir);
    }

    const restore = createFileSystemTools().find((t) => t.name === "file_restore")!;
    await restore.handler({ path: join(sourceDir, "a.txt") });
    await restore.handler({ path: join(sourceDir, "b.txt") });

    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe("a-original");
    expect(readFileSync(join(sourceDir, "b.txt"), "utf-8")).toBe("b-original");
  });

  it("full round trip: generate -> apply -> restore returns to the exact original content", async () => {
    const original = "line1\nline2\nline3\n";
    writeFileSync(join(sourceDir, "a.txt"), original);
    writeFileSync(join(outputDir, "a.txt"), "completely different content\n");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    await applyDiff(diff, sourceDir);
    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).not.toBe(original);

    const restore = createFileSystemTools().find((t) => t.name === "file_restore")!;
    await restore.handler({ path: join(sourceDir, "a.txt") });
    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe(original);
  });

  it("survives a fresh RollbackManager instance (simulating a new CLI process running `rollback` later)", async () => {
    writeFileSync(join(sourceDir, "a.txt"), "original");
    writeFileSync(join(outputDir, "a.txt"), "updated");

    const [diff] = await generateUnifiedDiff(outputDir, sourceDir);
    await applyDiff(diff, sourceDir);

    resetRollbackManager();
    getRollbackManager(sourceDir);

    const restore = createFileSystemTools().find((t) => t.name === "file_restore")!;
    const result = await restore.handler({ path: join(sourceDir, "a.txt") });
    expect(result.success).toBe(true);
    expect(readFileSync(join(sourceDir, "a.txt"), "utf-8")).toBe("original");
  });
});

describe("generateSimpleDiff", () => {
  it("counts additions and deletions", () => {
    const result = generateSimpleDiff("line1\nline2\n", "line1\nCHANGED\n", "a.txt");
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBeGreaterThan(0);
  });

  it("counts zero changes for identical content", () => {
    const result = generateSimpleDiff("same\n", "same\n", "a.txt");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it("produces a unified diff string containing the filename", () => {
    const result = generateSimpleDiff("old\n", "new\n", "src/app.ts");
    expect(result.diff).toContain("src/app.ts");
  });

  it("counts only additions when going from empty to non-empty", () => {
    const result = generateSimpleDiff("", "new content\n", "a.txt");
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBe(0);
  });
});
