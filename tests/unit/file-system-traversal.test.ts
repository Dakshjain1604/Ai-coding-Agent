/**
 * Tests for the path-traversal fix in file-system.ts's resolveOutputPath()
 * — used by file_copy/file_move (destination) and directory_create.
 *
 * Confirmed exploitable pre-fix with a live PoC: directory_create({path:
 * "../../../../tmp/ESCAPED_SANDBOX_DIR"}) created a real directory
 * directly in the user's home folder, outside the intended sandboxed
 * output directory entirely — `join(outputDir, relativePath)` normalizes
 * `..` segments syntactically but never clamps the result to stay inside
 * outputDir.
 *
 * Every "escapes the sandbox" test below asserts the ACTUAL side effect
 * (a directory/file appearing somewhere it shouldn't) doesn't happen —
 * not just that the tool call "looks" rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createFileSystemTools } from "../../src/core/tools/file-system.js";
import { getConfigManager, createConfigManager } from "../../src/utils/config.js";
import { resetTaskManager } from "../../src/utils/task-manager.js";

/**
 * getOutputDir() (file-system.ts) reads getTaskManager().getTaskOutputDir(),
 * which is derived from ConfigManager's defaults.outputDir, resolved
 * relative to process.cwd() at TaskManager construction time. To test
 * traversal against a KNOWN, disposable sandbox root (never the real
 * project directory), chdir into a temp dir and reset both singletons so
 * they re-derive from that temp cwd. Awaits `fn()` before restoring cwd —
 * getting that ordering wrong would let the real file I/O inside `fn()`
 * run against the ORIGINAL cwd instead of the sandboxed one.
 */
async function withSandbox<T>(
  dir: string,
  outputDirName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(dir);
  createConfigManager(dir);
  getConfigManager().setConfigValue("defaults.outputDir", outputDirName);
  resetTaskManager();
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("resolveOutputPath — path traversal (via directory_create)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
    mkdirSync(join(dir, "sandbox-output"));
  });

  afterEach(() => {
    resetTaskManager();
    rmSync(dir, { recursive: true, force: true });
  });

  function directoryCreate() {
    return createFileSystemTools().find((t) => t.name === "directory_create")!;
  }

  it("blocks a simple ../ escape", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({ path: "../escaped" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("traversal");
      expect(existsSync(join(dir, "escaped"))).toBe(false);
    });
  });

  it("blocks a deep multi-segment escape reaching far outside the sandbox", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const escapeTarget = join(dir, "..", "..", "..", "ESCAPED_FAR");
      const result = await directoryCreate().handler({
        path: "../../../../../../../../ESCAPED_FAR",
      });
      expect(result.success).toBe(false);
      expect(existsSync(escapeTarget)).toBe(false);
    });
  });

  it("blocks an escape disguised with a legitimate-looking prefix segment", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({
        path: "legit-looking-subdir/../../escaped",
      });
      expect(result.success).toBe(false);
      expect(existsSync(join(dir, "escaped"))).toBe(false);
    });
  });

  it("blocks a leading ./ escape combined with ..", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({ path: "./../escaped" });
      expect(result.success).toBe(false);
      expect(existsSync(join(dir, "escaped"))).toBe(false);
    });
  });

  it("allows a normal nested relative path inside the sandbox", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({ path: "nested/sub/dir" });
      expect(result.success).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "nested", "sub", "dir"))).toBe(true);
    });
  });

  it("allows a bare top-level relative path inside the sandbox", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({ path: "top-level" });
      expect(result.success).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "top-level"))).toBe(true);
    });
  });

  it("allows a path that legitimately traverses back in but stays inside the sandbox net", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      // a/../b is legal and stays inside the sandbox (nets out to just "b").
      const result = await directoryCreate().handler({ path: "a/../b" });
      expect(result.success).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "b"))).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "a"))).toBe(false);
    });
  });

  it("does not treat a sibling directory sharing a string prefix as already inside the sandbox", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      // Old bug: `"sandbox-output-evil/x".startsWith("sandbox-output")` is
      // true (raw string prefix), so this used to be returned AS-IS
      // (relative to cwd, i.e. escaping the actual sandbox dir) instead of
      // being joined under the real sandbox.
      const result = await directoryCreate().handler({ path: "sandbox-output-evil/x" });
      expect(result.success).toBe(true);
      // Must land INSIDE the real sandbox dir, not at cwd-relative
      // "sandbox-output-evil/x".
      expect(existsSync(join(dir, "sandbox-output", "sandbox-output-evil", "x"))).toBe(true);
      expect(existsSync(join(dir, "sandbox-output-evil"))).toBe(false);
    });
  });

  it("still allows an absolute path unchanged (existing, intentional behavior)", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const absoluteTarget = join(dir, "absolute-target");
      const result = await directoryCreate().handler({ path: absoluteTarget });
      expect(result.success).toBe(true);
      expect(existsSync(absoluteTarget)).toBe(true);
    });
  });

  it("blocks an escape attempt even when disguised inside an otherwise-absolute-looking segment mix", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const result = await directoryCreate().handler({ path: "a/b/c/../../../../../ESCAPED" });
      expect(result.success).toBe(false);
      expect(existsSync(join(dir, "ESCAPED"))).toBe(false);
      expect(existsSync(resolve(dir, "..", "ESCAPED"))).toBe(false);
    });
  });
});

describe("resolveOutputPath — path traversal (via file_copy destination)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
    mkdirSync(join(dir, "sandbox-output"));
  });

  afterEach(() => {
    resetTaskManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks copying to a destination that escapes the sandbox", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const source = join(dir, "source.txt");
      writeFileSync(source, "content");

      const copy = createFileSystemTools().find((t) => t.name === "file_copy")!;
      const result = await copy.handler({
        source,
        destination: "../../escaped-copy.txt",
      });
      expect(result.success).toBe(false);
      expect(existsSync(join(dir, "escaped-copy.txt"))).toBe(false);
    });
  });

  it("still allows copying to a legitimate relative destination", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const source = join(dir, "source.txt");
      writeFileSync(source, "content");

      const copy = createFileSystemTools().find((t) => t.name === "file_copy")!;
      const result = await copy.handler({ source, destination: "copied.txt" });
      expect(result.success).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "copied.txt"))).toBe(true);
    });
  });
});

describe("resolveOutputPath — path traversal (via file_move destination)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traversal-test-"));
    mkdirSync(join(dir, "sandbox-output"));
  });

  afterEach(() => {
    resetTaskManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks moving to a destination that escapes the sandbox, and leaves the source untouched", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const source = join(dir, "source.txt");
      writeFileSync(source, "content");

      const move = createFileSystemTools().find((t) => t.name === "file_move")!;
      const result = await move.handler({
        source,
        destination: "../../escaped-move.txt",
      });
      expect(result.success).toBe(false);
      expect(existsSync(join(dir, "escaped-move.txt"))).toBe(false);
      // Source must still exist — a blocked move must not have deleted it.
      expect(existsSync(source)).toBe(true);
    });
  });

  it("still allows moving to a legitimate relative destination", () => {
    return withSandbox(dir, "sandbox-output", async () => {
      const source = join(dir, "source.txt");
      writeFileSync(source, "content");

      const move = createFileSystemTools().find((t) => t.name === "file_move")!;
      const result = await move.handler({ source, destination: "moved.txt" });
      expect(result.success).toBe(true);
      expect(existsSync(join(dir, "sandbox-output", "moved.txt"))).toBe(true);
      expect(existsSync(source)).toBe(false);
    });
  });
});
