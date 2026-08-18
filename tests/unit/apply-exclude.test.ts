/**
 * Tests for shouldExclude() (cli/commands/apply.ts) — the fix for
 * `--exclude`, which is documented as accepting a glob pattern (e.g.
 * "*.test.ts") but was implemented as `diff.path.match(new
 * RegExp(flags.exclude))`. Any pattern starting with `*` — the single
 * most natural glob a user would type — throws a SyntaxError
 * ("Nothing to repeat") when passed straight to `new RegExp()`,
 * crashing the entire `apply` command. Confirmed live with
 * `new RegExp("*.test.ts")` before fixing. Now uses minimatch, which is
 * what "glob pattern" actually means.
 */
import { describe, it, expect } from "vitest";
import { shouldExclude } from "../../src/cli/commands/apply.js";

describe("shouldExclude — the *.ext crash fix", () => {
  it("does not throw for a leading-* glob pattern that would have crashed new RegExp()", () => {
    expect(() => shouldExclude("src/foo.test.ts", "*.test.ts")).not.toThrow();
  });

  it("matches a file against a simple *.ext glob", () => {
    expect(shouldExclude("foo.test.ts", "*.test.ts")).toBe(true);
    expect(shouldExclude("foo.ts", "*.test.ts")).toBe(false);
  });

  it("matches nested paths with a ** glob", () => {
    expect(shouldExclude("src/deep/nested/foo.test.ts", "**/*.test.ts")).toBe(true);
    expect(shouldExclude("src/deep/nested/foo.ts", "**/*.test.ts")).toBe(false);
  });

  it("matches a directory-prefix glob", () => {
    expect(shouldExclude("node_modules/pkg/index.js", "node_modules/**")).toBe(true);
    expect(shouldExclude("src/index.js", "node_modules/**")).toBe(false);
  });
});

describe("shouldExclude — pattern absence", () => {
  it("returns false when no exclude pattern is given (undefined)", () => {
    expect(shouldExclude("anything.ts", undefined)).toBe(false);
  });

  it("returns false for an empty-string exclude pattern", () => {
    expect(shouldExclude("anything.ts", "")).toBe(false);
  });
});

describe("shouldExclude — general glob semantics", () => {
  it("does an exact match when the pattern has no wildcards", () => {
    expect(shouldExclude("exact/path.ts", "exact/path.ts")).toBe(true);
    expect(shouldExclude("other/path.ts", "exact/path.ts")).toBe(false);
  });

  it("? matches exactly one character", () => {
    expect(shouldExclude("a.ts", "?.ts")).toBe(true);
    expect(shouldExclude("ab.ts", "?.ts")).toBe(false);
  });

  it("is case-sensitive by default (matching minimatch's default behavior)", () => {
    expect(shouldExclude("FOO.TS", "*.ts")).toBe(false);
  });
});
