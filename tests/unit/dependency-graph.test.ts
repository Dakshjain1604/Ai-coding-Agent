/**
 * Tests for DependencyGraph (utils/dependency-graph.ts) — previously
 * only exercised by one shallow test running against this repo's own
 * real src/ tree (non-deterministic input, no isolation). Rewritten
 * against a controlled temp-directory fixture.
 *
 * Centerpiece regression: getDependentFiles() only builds the graph
 * once, lazily, when this.nodes is empty — it never rebuilds on its
 * own. builtin.ts's file_write handler calls it after every write to
 * flag dependent files for audit, so without an explicit invalidate()
 * call, every write after the first in a session silently reported
 * dependents from a pre-edit snapshot of the tree, missing whatever
 * changed. Added invalidate() and wired it into file_write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DependencyGraph } from "../../src/utils/dependency-graph.js";

let root: string;
let srcDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dep-graph-"));
  srcDir = join(root, "src");
  mkdirSync(srcDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = join(srcDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("DependencyGraph — buildGraph()/getDependentFiles() basics", () => {
  it("finds a direct dependent via a relative ES import", () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "import { a } from './a';\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).toContain(join(srcDir, "b.ts"));
  });

  it("finds transitive dependents (b imports a, c imports b)", () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "import { a } from './a';\n");
    write("c.ts", "import { a } from './b';\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).toContain(join(srcDir, "b.ts"));
    expect(dependents).toContain(join(srcDir, "c.ts"));
  });

  it("does not report a file that doesn't import the target", () => {
    write("a.ts", "export const a = 1;\n");
    write("unrelated.ts", "export const x = 1;\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).not.toContain(join(srcDir, "unrelated.ts"));
  });

  it("returns an empty array for a file with no dependents", () => {
    write("lonely.ts", "export const x = 1;\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    expect(graph.getDependentFiles(join(srcDir, "lonely.ts"))).toEqual([]);
  });

  it("ignores non-relative (bare package) imports", () => {
    write("a.ts", "import chalk from 'chalk';\nexport const a = 1;\n");
    const graph = new DependencyGraph(root);
    expect(() => graph.buildGraph()).not.toThrow();
  });

  it("recognizes require() calls in addition to ES imports", () => {
    write("a.ts", "module.exports = { a: 1 };\n");
    write("b.js", "const { a } = require('./a');\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    expect(graph.getDependentFiles(join(srcDir, "a.ts"))).toContain(join(srcDir, "b.js"));
  });

  it("resolves an import to an index file in a directory", () => {
    mkdirSync(join(srcDir, "lib"));
    write("lib/index.ts", "export const libFn = 1;\n");
    write("user.ts", "import { libFn } from './lib';\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    expect(graph.getDependentFiles(join(srcDir, "lib", "index.ts"))).toContain(
      join(srcDir, "user.ts"),
    );
  });

  it("auto-lazily builds the graph on first getDependentFiles() call if never built", () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "import { a } from './a';\n");
    const graph = new DependencyGraph(root);
    // No explicit buildGraph() call.
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).toContain(join(srcDir, "b.ts"));
  });

  it("does not throw when the target src directory doesn't exist", () => {
    const graph = new DependencyGraph(join(root, "does-not-exist"));
    expect(() => graph.buildGraph()).not.toThrow();
  });

  it("skips node_modules and dotfile directories during the scan", () => {
    mkdirSync(join(srcDir, "node_modules"));
    write("node_modules/pkg.ts", "export const x = 1;\n");
    write("real.ts", "export const y = 1;\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    // No throw and real.ts is present as an empty-dependents node — a weak
    // but sufficient signal the scan completed and didn't choke on the
    // skipped directory.
    expect(graph.getDependentFiles(join(srcDir, "real.ts"))).toEqual([]);
  });
});

describe("DependencyGraph — invalidate() (the staleness fix)", () => {
  it("reflects a newly-added dependent after invalidate() + rebuild, not the old snapshot", () => {
    write("a.ts", "export const a = 1;\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    expect(graph.getDependentFiles(join(srcDir, "a.ts"))).toEqual([]);

    // Simulate a later write that adds a new dependent, without ever
    // calling buildGraph() again directly.
    write("new-dependent.ts", "import { a } from './a';\n");
    graph.invalidate();
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).toContain(join(srcDir, "new-dependent.ts"));
  });

  it("without invalidate(), getDependentFiles() keeps returning the stale pre-edit snapshot", () => {
    write("a.ts", "export const a = 1;\n");
    const graph = new DependencyGraph(root);
    graph.buildGraph();
    write("new-dependent.ts", "import { a } from './a';\n");
    // No invalidate() call — this locks in the documented (not
    // necessarily desirable on its own, which is why callers like
    // file_write must invalidate) lazy-build-once behavior.
    const dependents = graph.getDependentFiles(join(srcDir, "a.ts"));
    expect(dependents).toEqual([]);
  });

  it("invalidate() on a never-built graph is a safe no-op", () => {
    const graph = new DependencyGraph(root);
    expect(() => graph.invalidate()).not.toThrow();
  });
});

describe("getDependencyGraph() singleton", () => {
  it("returns the same instance across calls", async () => {
    const { getDependencyGraph } = await import("../../src/utils/dependency-graph.js");
    expect(getDependencyGraph()).toBe(getDependencyGraph());
  });
});
