/**
 * Tests for the code-search.ts toolset beyond `grep` (which already has
 * its own dedicated coverage in code-search-grep.test.ts): search_files,
 * search_content, find_usages, analyze_imports, analyze_exports,
 * count_lines. All six had zero test coverage before this.
 *
 * Centerpiece regression: every one of these tools' walk() helper called
 * statSync() on each directory entry with no try/catch. A broken symlink
 * (or a permission-denied entry) anywhere under the search root makes
 * statSync() throw ENOENT/EACCES, which propagated all the way up through
 * the tool's own top-level try/catch and turned into success:false for
 * the ENTIRE search — discarding every real match already found
 * elsewhere in the tree over one unrelated dangling symlink. Confirmed
 * live before fixing: a directory with one broken symlink and one file
 * containing a real match returned `{success:false, output:"Error...
 * ENOENT..."}` from grep, with the real match never surfaced. Fixed by
 * skipping (not crashing on) any entry statSync can't stat, in all four
 * walk() functions (searchFiles/searchContent/grepSearch/countLines).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCodeSearchTools } from "../../src/core/tools/code-search.js";

function getTool(name: string) {
  const tool = createCodeSearchTools().find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "code-search-tools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("broken-symlink robustness fix (shared across all walk()s)", () => {
  function setupWithBrokenSymlink() {
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "real.ts"), "const hello = 1;\n");
    symlinkSync(join(dir, "does-not-exist"), join(dir, "subdir", "broken-link"));
  }

  it("search_files still finds real matches past a broken symlink", async () => {
    setupWithBrokenSymlink();
    const result = await getTool("search_files").handler({
      directory: dir,
      pattern: "*.ts",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("real.ts");
  });

  it("search_content still finds real matches past a broken symlink", async () => {
    setupWithBrokenSymlink();
    const result = await getTool("search_content").handler({
      directory: dir,
      pattern: "hello",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("real.ts");
  });

  it("count_lines still counts real files past a broken symlink", async () => {
    setupWithBrokenSymlink();
    const result = await getTool("count_lines").handler({ directory: dir });
    expect(result.success).toBe(true);
    expect(result.metadata?.files).toBe(1);
  });

  it("find_usages (built on searchContent) still finds real matches past a broken symlink", async () => {
    setupWithBrokenSymlink();
    const result = await getTool("find_usages").handler({
      symbol: "hello",
      directory: dir,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("real.ts");
  });
});

describe("search_files", () => {
  it("finds files matching a glob-ish pattern", async () => {
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.js"), "");
    const result = await getTool("search_files").handler({ directory: dir, pattern: "*.ts" });
    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("b.js");
  });

  it("reports 'No files found' when nothing matches", async () => {
    const result = await getTool("search_files").handler({ directory: dir, pattern: "*.nomatch" });
    expect(result.output).toBe("No files found");
    expect(result.metadata?.count).toBe(0);
  });

  it("searches recursively into subdirectories", async () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.ts"), "");
    const result = await getTool("search_files").handler({ directory: dir, pattern: "*.ts" });
    expect(result.output).toContain("deep.ts");
  });

  it("always skips node_modules/.git/dist/build regardless of the exclude list", async () => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.ts"), "");
    const result = await getTool("search_files").handler({ directory: dir, pattern: "*.ts" });
    expect(result.output).not.toContain("pkg.ts");
  });

  it("honors an additional custom exclude pattern", async () => {
    mkdirSync(join(dir, "generated"));
    writeFileSync(join(dir, "generated", "gen.ts"), "");
    writeFileSync(join(dir, "keep.ts"), "");
    const result = await getTool("search_files").handler({
      directory: dir,
      pattern: "*.ts",
      exclude: ["generated"],
    });
    expect(result.output).toContain("keep.ts");
    expect(result.output).not.toContain("gen.ts");
  });

  it("returns success:false with an error message when the search throws", async () => {
    const result = await getTool("search_files").handler({ directory: dir, pattern: "[" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error searching files");
  });

  it("defaults directory to '.' when omitted", async () => {
    const result = await getTool("search_files").handler({ pattern: "*.nonexistent-ext-xyz" });
    expect(result.success).toBe(true);
  });
});

describe("search_content", () => {
  it("finds a matching line and reports file:line:content", async () => {
    writeFileSync(join(dir, "f.ts"), "line one\nfind me here\nline three\n");
    const result = await getTool("search_content").handler({ directory: dir, pattern: "find me" });
    expect(result.output).toContain("f.ts:2: find me here");
  });

  it("is case-insensitive by default", async () => {
    writeFileSync(join(dir, "f.ts"), "FIND ME\n");
    const result = await getTool("search_content").handler({ directory: dir, pattern: "find me" });
    expect(result.output).toContain("FIND ME");
  });

  it("finds matches on EVERY matching line of a file, not just the first (the global-regex lastIndex fix)", async () => {
    // Before the fix: reusing one `g`-flagged RegExp across .test() calls
    // on successive lines left lastIndex pointing past the end of a
    // later, shorter line after an earlier match, causing a silent
    // false-negative on that line. Confirmed live: this exact file
    // returned only 1 match instead of 2 before the fix.
    writeFileSync(join(dir, "f.ts"), "function myFunc() {}\nmyFunc();\n");
    const result = await getTool("search_content").handler({ directory: dir, pattern: "myFunc" });
    expect(result.metadata?.count).toBe(2);
  });

  it("respects caseSensitive:true", async () => {
    writeFileSync(join(dir, "f.ts"), "FIND ME\n");
    const result = await getTool("search_content").handler({
      directory: dir,
      pattern: "find me",
      caseSensitive: true,
    });
    expect(result.metadata?.count).toBe(0);
  });

  it("filters by filePattern", async () => {
    writeFileSync(join(dir, "a.ts"), "target\n");
    writeFileSync(join(dir, "b.md"), "target\n");
    const result = await getTool("search_content").handler({
      directory: dir,
      pattern: "target",
      filePattern: "*.ts",
    });
    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("b.md");
  });

  it("caps results at maxResults", async () => {
    writeFileSync(join(dir, "f.ts"), Array.from({ length: 10 }, () => "match").join("\n"));
    const result = await getTool("search_content").handler({
      directory: dir,
      pattern: "match",
      maxResults: 3,
    });
    expect(result.metadata?.count).toBe(3);
  });

  it("skips a permission-denied file without failing the whole search", async () => {
    const denied = join(dir, "denied.ts");
    writeFileSync(denied, "target\n");
    chmodSync(denied, 0o000);
    writeFileSync(join(dir, "readable.ts"), "target\n");
    try {
      const result = await getTool("search_content").handler({ directory: dir, pattern: "target" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("readable.ts");
    } finally {
      chmodSync(denied, 0o644);
    }
  });

  it("returns success:false with an error message when the pattern is an invalid regex", async () => {
    const result = await getTool("search_content").handler({ directory: dir, pattern: "(" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error searching content");
  });
});

describe("find_usages", () => {
  it("finds a 'definition'-type usage (class/interface/function/const/let/var symbol)", async () => {
    writeFileSync(join(dir, "f.ts"), "function myFunc() {}\nmyFunc();\n");
    const result = await getTool("find_usages").handler({
      symbol: "myFunc",
      directory: dir,
      type: "definition",
    });
    expect(result.output).toContain("function myFunc");
    expect((result.output.match(/f\.ts/g) ?? []).length).toBe(1);
  });

  it("finds 'reference'-type usages (word-boundary-ish match)", async () => {
    writeFileSync(join(dir, "f.ts"), "myFunc();\nconst myFuncName = 1;\n");
    const result = await getTool("find_usages").handler({
      symbol: "myFunc",
      directory: dir,
      type: "reference",
    });
    expect(result.output).toContain("myFunc();");
  });

  it("defaults to type:'all', matching every occurrence of the raw symbol", async () => {
    writeFileSync(join(dir, "f.ts"), "function myFunc() {}\nmyFunc();\n");
    const result = await getTool("find_usages").handler({ symbol: "myFunc", directory: dir });
    expect(result.metadata?.count).toBe(2);
  });

  it("returns an empty result (not an error) when the symbol doesn't appear anywhere", async () => {
    writeFileSync(join(dir, "f.ts"), "nothing here\n");
    const result = await getTool("find_usages").handler({ symbol: "neverExists", directory: dir });
    expect(result.success).toBe(true);
    expect(result.metadata?.count).toBe(0);
  });
});

describe("analyze_imports", () => {
  it("detects ES import statements and their module paths", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, `import { foo } from "./foo";\nimport bar from "bar-pkg";\n`);
    const result = await getTool("analyze_imports").handler({ file });
    expect(result.output).toContain("import: ./foo");
    expect(result.output).toContain("import: bar-pkg");
  });

  it("detects CommonJS require() calls", async () => {
    const file = join(dir, "f.js");
    writeFileSync(file, `const x = require("some-module");\n`);
    const result = await getTool("analyze_imports").handler({ file });
    expect(result.output).toContain("require: some-module");
  });

  it("returns success:false for a nonexistent file", async () => {
    const result = await getTool("analyze_imports").handler({ file: join(dir, "missing.ts") });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("returns an empty import list (not an error) for a file with no imports", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, "const x = 1;\n");
    const result = await getTool("analyze_imports").handler({ file });
    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });
});

describe("analyze_exports", () => {
  it("detects named exports (const/let/var/function/class)", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, `export const foo = 1;\nexport function bar() {}\n`);
    const result = await getTool("analyze_exports").handler({ file });
    expect(result.output).toContain("named: foo");
    expect(result.output).toContain("named: bar");
  });

  it("detects a default export", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, `export default function() {}\n`);
    const result = await getTool("analyze_exports").handler({ file });
    expect(result.output).toContain("default: default");
  });

  it("detects a re-export-all statement and reports the source module as its name", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, `export * from "./other";\n`);
    const result = await getTool("analyze_exports").handler({ file });
    expect(result.output).toContain("all: ./other");
  });

  it("returns success:false for a nonexistent file", async () => {
    const result = await getTool("analyze_exports").handler({ file: join(dir, "missing.ts") });
    expect(result.success).toBe(false);
  });
});

describe("count_lines", () => {
  it("counts total lines and files across matching extensions", async () => {
    writeFileSync(join(dir, "a.ts"), "line1\nline2\n");
    writeFileSync(join(dir, "b.js"), "line1\n");
    writeFileSync(join(dir, "c.md"), "not counted by default\n");
    const result = await getTool("count_lines").handler({ directory: dir });
    expect(result.metadata?.files).toBe(2);
    expect(result.output).toContain("Files: 2");
  });

  it("respects a custom extensions list", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    writeFileSync(join(dir, "b.md"), "x\ny\n");
    const result = await getTool("count_lines").handler({ directory: dir, extensions: [".md"] });
    expect(result.metadata?.files).toBe(1);
    // content.split("\n").length counts the trailing empty segment after a
    // final newline, so "x\ny\n" is 3, not 2 — matches this tool's existing
    // line-counting convention everywhere else, not something to "fix" here.
    expect((result.metadata as { byExtension: Record<string, number> }).byExtension[".md"]).toBe(3);
  });

  it("excludes node_modules/dist/.git by default", async () => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "pkg.ts"), "x\n");
    writeFileSync(join(dir, "real.ts"), "x\n");
    const result = await getTool("count_lines").handler({ directory: dir });
    expect(result.metadata?.files).toBe(1);
  });

  it("respects a custom exclude list in addition to the extension filter", async () => {
    mkdirSync(join(dir, "vendor"));
    writeFileSync(join(dir, "vendor", "lib.ts"), "x\n");
    writeFileSync(join(dir, "real.ts"), "x\n");
    const result = await getTool("count_lines").handler({ directory: dir, exclude: ["vendor"] });
    expect(result.metadata?.files).toBe(1);
  });

  it("skips a permission-denied file without failing the whole count", async () => {
    const denied = join(dir, "denied.ts");
    writeFileSync(denied, "x\ny\nz\n");
    chmodSync(denied, 0o000);
    writeFileSync(join(dir, "real.ts"), "x\ny\n");
    try {
      const result = await getTool("count_lines").handler({ directory: dir });
      expect(result.success).toBe(true);
      expect(result.metadata?.files).toBe(1);
    } finally {
      chmodSync(denied, 0o644);
    }
  });
});
