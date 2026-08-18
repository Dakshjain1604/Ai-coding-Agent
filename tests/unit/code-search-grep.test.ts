/**
 * Tests for the `grep` tool (code-search.ts) — rewritten this phase from
 * a shell-string-interpolated `grep` invocation (exploitable: only `"` in
 * the pattern was escaped, not backticks/`$(...)`/`;`/`|`) to a pure-JS
 * implementation with no shell involved at all, mirroring search_content's
 * already-safe design.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCodeSearchTools } from "../../src/core/tools/code-search.js";

function getGrep() {
  const tool = createCodeSearchTools().find((t) => t.name === "grep");
  if (!tool) throw new Error("grep tool not found");
  return tool;
}

function canaryPath(dir: string, label: string): string {
  return join(dir, `PWNED_${label}_${Math.random().toString(36).slice(2)}`);
}

function injectionPayload(canary: string): string {
  return `x\`touch ${canary}\`$(touch ${canary}); touch ${canary}`;
}

describe("grep — injection resistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grep-test-"));
    writeFileSync(join(dir, "a.txt"), "hello world\nfoo bar\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in the pattern", async () => {
    const canary = canaryPath(dir, "PATTERN");
    const result = await getGrep().handler({
      pattern: injectionPayload(canary),
      path: dir,
    });
    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("never executes shell metacharacters embedded in the path", async () => {
    const canary = canaryPath(dir, "PATH");
    const result = await getGrep().handler({
      pattern: "hello",
      path: `${dir}; touch ${canary}`,
    });
    expect(result.success).toBe(true); // bogus path just doesn't exist
    expect(existsSync(canary)).toBe(false);
  });
});

describe("grep — functional correctness", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grep-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a match in a single file", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello world\nfoo bar\n");
    const result = await getGrep().handler({ pattern: "hello", path: file });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  it("reports 'No matches found' for a pattern that doesn't match", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello world\n");
    const result = await getGrep().handler({ pattern: "nomatch", path: file });
    expect(result.success).toBe(true);
    expect(result.output).toBe("No matches found");
  });

  it("returns success:true (not an error) for a nonexistent path", async () => {
    const result = await getGrep().handler({ pattern: "x", path: join(dir, "nope.txt") });
    expect(result.success).toBe(true);
    expect(result.output).toBe("No matches found");
  });

  it("searches recursively by default across a directory tree", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "deep match here\n");
    const result = await getGrep().handler({ pattern: "deep match", path: dir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("deep match here");
  });

  it("does not descend into subdirectories when recursive:false", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "target phrase\n");
    writeFileSync(join(dir, "top.txt"), "target phrase\n");
    const result = await getGrep().handler({
      pattern: "target phrase",
      path: dir,
      recursive: false,
    });
    expect(result.success).toBe(true);
    // Top-level file still matches...
    expect(result.output).toContain("top.txt");
    // ...but the nested one is never walked into.
    expect(result.output).not.toContain("nested.txt");
  });

  it("is case-insensitive by default", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "HELLO world\n");
    const result = await getGrep().handler({ pattern: "hello", path: file });
    expect(result.output).toContain("HELLO world");
  });

  it("respects caseSensitive:true", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "HELLO world\n");
    const result = await getGrep().handler({
      pattern: "hello",
      path: file,
      caseSensitive: true,
    });
    expect(result.output).toBe("No matches found");
  });

  it("includes context lines before and after a match when context is given", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "line1\nline2\nMATCH\nline4\nline5\n");
    const result = await getGrep().handler({ pattern: "MATCH", path: file, context: 1 });
    expect(result.output).toContain("line2");
    expect(result.output).toContain("MATCH");
    expect(result.output).toContain("line4");
    expect(result.output).not.toContain("line1");
    expect(result.output).not.toContain("line5");
  });

  it("skips always-excluded directories (node_modules/.git/dist/build)", async () => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.txt"), "should be skipped\n");
    const result = await getGrep().handler({ pattern: "should be skipped", path: dir });
    expect(result.output).toBe("No matches found");
  });

  it("uses the pattern as a real regex, not a literal string", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "foo123bar\n");
    const result = await getGrep().handler({ pattern: "foo\\d+bar", path: file });
    expect(result.output).toContain("foo123bar");
  });

  it("skips an unreadable/binary-ish file without crashing the whole search", async () => {
    // A directory entry that stat's as a file but isn't valid UTF-8 text
    // shouldn't abort the walk — write a file with a null byte.
    const badFile = join(dir, "binary.dat");
    writeFileSync(badFile, Buffer.from([0, 1, 2, 3, 255, 254]));
    const goodFile = join(dir, "good.txt");
    writeFileSync(goodFile, "findme\n");

    const result = await getGrep().handler({ pattern: "findme", path: dir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("findme");
  });
});
