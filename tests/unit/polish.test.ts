import { describe, it, expect } from "vitest";
import { getRollbackManager } from "../../src/utils/git-rollback.js";
import { formatFile } from "../../src/utils/formatter.js";
import { getParallelOrchestrator } from "../../src/core/orchestrator/ParallelOrchestrator.js";

describe("Next-Level Polish Features", () => {
  it("RollbackManager generates colored diff preview", () => {
    const rollback = getRollbackManager();
    const diff = rollback.generateDiffPreview("test.ts", "const a = 1;", "const a = 2;");
    expect(diff).toContain("- const a = 1;");
    expect(diff).toContain("+ const a = 2;");
  });

  it("formatFile handles non-existent file gracefully", async () => {
    const res = await formatFile("non-existent-file-12345.ts");
    expect(res).toBe(false);
  });

  it("ParallelOrchestrator initializes properly", () => {
    const orchestrator = getParallelOrchestrator();
    expect(orchestrator).toBeDefined();
  });
});
