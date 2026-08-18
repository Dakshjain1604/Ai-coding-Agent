/**
 * Tests for spawnSubagentTool's own input validation (core/tools/subagent-tool.ts)
 * — distinct from tests/unit/subagent.test.ts, which tests the
 * ParallelOrchestrator engine underneath. This is the outer boundary a
 * model's raw tool-call params actually hit first.
 *
 * Found and fixed while writing these: a malformed subtasks entry (null,
 * a bare string, a missing description) used to surface as a raw JS
 * TypeError message ("Cannot read properties of null (reading 'mode')")
 * that gave the model no way to tell which entry was wrong or how to fix
 * it — and an unbounded subtasks array risked unbounded context growth
 * for later subtasks in the same pipeline.
 */
import { describe, it, expect } from "vitest";
import { spawnSubagentTool } from "../../src/core/tools/subagent-tool.js";
import {
  pushSubagentContext,
  popSubagentContext,
} from "../../src/core/agents/subagent-context.js";
import type { Task } from "../../src/utils/types.js";

function makeTask(id: string): Task {
  return {
    id,
    description: "parent task",
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function callHandler(params: Record<string, unknown>) {
  return spawnSubagentTool.handler(params) as Promise<{
    success: boolean;
    output: string;
  }>;
}

describe("spawnSubagentTool — subtasks array validation", () => {
  it("rejects a missing subtasks param", async () => {
    const result = await callHandler({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("non-empty");
  });

  it("rejects a non-array subtasks param", async () => {
    const result = await callHandler({ subtasks: "not an array" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("non-empty");
  });

  it("rejects an empty subtasks array", async () => {
    const result = await callHandler({ subtasks: [] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("non-empty");
  });

  it("rejects null as the subtasks param", async () => {
    const result = await callHandler({ subtasks: null });
    expect(result.success).toBe(false);
  });

  it("rejects a subtasks array with more entries than the pipeline cap", async () => {
    const subtasks = Array.from({ length: 11 }, (_, i) => ({
      mode: "code",
      description: `subtask ${i}`,
    }));
    const result = await callHandler({ subtasks });
    expect(result.success).toBe(false);
    expect(result.output).toContain("capped at");
  });

  it("accepts exactly the pipeline cap without rejecting for length", async () => {
    const subtasks = Array.from({ length: 10 }, (_, i) => ({
      mode: "code",
      description: `subtask ${i}`,
    }));
    // Push a context so it gets past the "no active task" check too, then
    // it will fail downstream trying to reach a real provider — that's
    // fine, we're only asserting it wasn't rejected for length.
    pushSubagentContext({ parentTask: makeTask("p1"), parentToolNames: [] });
    try {
      const result = await callHandler({ subtasks });
      expect(result.output).not.toContain("capped at");
    } finally {
      popSubagentContext();
    }
  });
});

describe("spawnSubagentTool — malformed subtask entries", () => {
  it("gives a clear, actionable message for a null entry (not a raw JS TypeError)", async () => {
    const result = await callHandler({
      subtasks: [null, { mode: "code", description: "ok" }],
    });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("Cannot read properties");
    expect(result.output).toContain("index 0");
  });

  it("gives a clear message for a bare string entry", async () => {
    const result = await callHandler({
      subtasks: ["just a string", { mode: "code", description: "ok" }],
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("index 0");
  });

  it("gives a clear message for a bare number entry", async () => {
    const result = await callHandler({ subtasks: [42, { mode: "code", description: "ok" }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("index 0");
  });

  it("gives a clear message for a bare array entry", async () => {
    const result = await callHandler({ subtasks: [[1, 2, 3]] });
    expect(result.success).toBe(false);
  });

  it("rejects an entry with a missing description", async () => {
    const result = await callHandler({ subtasks: [{ mode: "code" }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("description");
  });

  it("rejects an entry with an empty-string description", async () => {
    const result = await callHandler({ subtasks: [{ mode: "code", description: "" }] });
    expect(result.success).toBe(false);
  });

  it("rejects an entry with a whitespace-only description", async () => {
    const result = await callHandler({ subtasks: [{ mode: "code", description: "   " }] });
    expect(result.success).toBe(false);
  });

  it("lists every malformed index, not just the first, when several entries are bad", async () => {
    const result = await callHandler({
      subtasks: [
        { mode: "code", description: "ok" },
        null,
        { mode: "code" }, // missing description
        { mode: "code", description: "also ok" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("index 1, 2");
  });

  it("uses the generic 'all malformed' message when every entry is bad", async () => {
    const result = await callHandler({ subtasks: [null, {}] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("every entry");
  });
});

describe("spawnSubagentTool — mode defaulting and validation", () => {
  for (const mode of ["code", "debug", "test", "review", "plan"]) {
    it(`preserves an explicit valid mode "${mode}"`, async () => {
      pushSubagentContext({ parentTask: makeTask("p"), parentToolNames: [] });
      try {
        // We can't observe the resolved subtask mode without a real/mocked
        // ParallelOrchestrator run, but we CAN confirm it doesn't get
        // rejected as malformed — the mode-preservation itself is covered
        // at the ParallelOrchestrator level in subagent.test.ts.
        const result = await callHandler({ subtasks: [{ mode, description: "x" }] });
        expect(result.output).not.toContain("malformed");
      } finally {
        popSubagentContext();
      }
    });
  }

  it("defaults an invalid mode string to 'code' rather than rejecting the subtask", async () => {
    pushSubagentContext({ parentTask: makeTask("p"), parentToolNames: [] });
    try {
      const result = await callHandler({
        subtasks: [{ mode: "not-a-real-mode", description: "x" }],
      });
      // Not rejected for the mode itself (only description validity and
      // count are hard-rejected) — invalid mode silently defaults to code.
      expect(result.output).not.toContain("malformed");
    } finally {
      popSubagentContext();
    }
  });

  it("defaults a missing mode field to 'code'", async () => {
    pushSubagentContext({ parentTask: makeTask("p"), parentToolNames: [] });
    try {
      const result = await callHandler({ subtasks: [{ description: "x" }] });
      expect(result.output).not.toContain("malformed");
    } finally {
      popSubagentContext();
    }
  });
});

describe("spawnSubagentTool — active context requirement", () => {
  it("rejects being called with no active agent context on the stack", async () => {
    const result = await callHandler({ subtasks: [{ mode: "code", description: "x" }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("outside of an active agent task");
  });
});
