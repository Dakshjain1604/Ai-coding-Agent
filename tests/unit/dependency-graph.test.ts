import { describe, it, expect, beforeEach } from "vitest";
import { DependencyGraph } from "../../src/utils/dependency-graph.js";
import { join } from "path";

describe("DependencyGraph", () => {
  let graph: DependencyGraph;

  beforeEach(() => {
    graph = new DependencyGraph(process.cwd());
  });

  it("should initialize and build dependency graph", () => {
    graph.buildGraph();
    const dependents = graph.getDependentFiles(
      join(process.cwd(), "src", "utils", "types.ts"),
    );
    expect(Array.isArray(dependents)).toBe(true);
    expect(dependents.length).toBeGreaterThan(0);
  });
});
