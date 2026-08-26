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
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import type { ProviderType } from "../../src/utils/types.js";
import type { Task } from "../../src/utils/types.js";

const ALL_PROVIDER_TYPES: ProviderType[] = [
  "ollama",
  "claude",
  "openai",
  "gemini",
  "local",
  "groq",
  "openrouter",
  "huggingface",
  "ollama-cloud",
];

/** Forces every provider genuinely unavailable so a downstream execute()
 * fails immediately instead of reaching a real provider. Without this, the
 * "pipeline cap" test below actually reached the real local Ollama server
 * running on this machine, whose failed completion call retried with
 * exponential backoff past this suite's 5s test timeout — the abandoned
 * async work then popped/pushed the shared subagent-context stack in the
 * background after the test had already "finished," corrupting the depth
 * seen by whichever test ran next (confirmed live: caused the unrelated
 * "no active context" test below to see a stale depth of 2 and report
 * "Sub-agent depth limit reached" instead of "outside of an active agent
 * task"). */
function seedNoProviders(): void {
  ProviderFactory.reset();
  const factory = ProviderFactory.getInstance({ preferLocal: false });
  const availability = (factory as unknown as { availability: Map<ProviderType, boolean> })
    .availability;
  for (const type of ALL_PROVIDER_TYPES) {
    availability.set(type, false);
  }
}

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
    // it will fail downstream since no provider is available — that's
    // fine, we're only asserting it wasn't rejected for length. Provider
    // availability is forced off so this fails fast and deterministically
    // instead of reaching a real provider (see seedNoProviders() above).
    seedNoProviders();
    pushSubagentContext({ parentTask: makeTask("p1"), parentToolNames: [] });
    try {
      const result = await callHandler({ subtasks });
      expect(result.output).not.toContain("capped at");
    } finally {
      popSubagentContext();
      ProviderFactory.reset();
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
