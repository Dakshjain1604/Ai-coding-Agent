/**
 * Tests for the sub-agent-as-child-session mechanism (Wiring Audit fix #6 /
 * Best-of-Four piece F): ParallelOrchestrator.executePipeline() repurposed
 * as the engine behind the `spawn_subagent` tool, with depth limiting and
 * tool-set narrowing.
 *
 * Deliberately does NOT exercise a real agent.execute() call (that requires
 * a live LLM provider) — depth limiting short-circuits before any agent is
 * spawned, and tool narrowing is tested directly against a constructed
 * UniversalAgent instance without running it.
 */
import { describe, it, expect } from "vitest";
import {
  ParallelOrchestrator,
  MAX_SUBAGENT_DEPTH,
} from "../../src/core/orchestrator/ParallelOrchestrator.js";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import {
  pushSubagentContext,
  popSubagentContext,
  getCurrentSubagentContext,
  getSubagentDepth,
} from "../../src/core/agents/subagent-context.js";
import type { Task } from "../../src/utils/types.js";

function makeTask(id: string): Task {
  return {
    id,
    description: "test task",
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("ParallelOrchestrator depth limiting", () => {
  it("refuses to spawn once MAX_SUBAGENT_DEPTH is reached", async () => {
    const orchestrator = new ParallelOrchestrator();
    const result = await orchestrator.executePipeline(
      makeTask("t1"),
      [{ mode: "code", description: "do something" }],
      [],
      MAX_SUBAGENT_DEPTH,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("depth limit");
  });

  it("allows spawning below the depth limit (depth defaults to 0)", async () => {
    // depth=MAX-1 should pass the depth check itself (it may still fail
    // later trying to reach a real LLM provider, which is fine — we're
    // only asserting it wasn't rejected for depth reasons).
    const orchestrator = new ParallelOrchestrator();
    const result = await orchestrator.executePipeline(
      makeTask("t2"),
      [],
      [],
      MAX_SUBAGENT_DEPTH - 1,
    );
    // Empty subtasks list: loop never runs, succeeds trivially — proves we
    // got past the depth guard.
    expect(result.success).toBe(true);
  });
});

describe("ParallelOrchestrator child tool narrowing", () => {
  it("strips shell_exec and spawn_subagent regardless of parent's tools", () => {
    const orchestrator = new ParallelOrchestrator();
    const agent = new UniversalAgent("code"); // code mode includes shell_exec + spawn_subagent

    (
      orchestrator as unknown as {
        narrowChildTools: (a: UniversalAgent, names: string[]) => void;
      }
    ).narrowChildTools(agent, [
      "file_read",
      "file_write",
      "shell_exec",
      "spawn_subagent",
    ]);

    const names = agent.getTools().map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).not.toContain("shell_exec");
    expect(names).not.toContain("spawn_subagent");
  });

  it("restricts the child to the intersection with the parent's tool list", () => {
    const orchestrator = new ParallelOrchestrator();
    const agent = new UniversalAgent("code");

    // Parent only had file_read — child (code mode) also has file_write,
    // git_status, etc. by default; narrowing should strip anything the
    // parent didn't have.
    (
      orchestrator as unknown as {
        narrowChildTools: (a: UniversalAgent, names: string[]) => void;
      }
    ).narrowChildTools(agent, ["file_read"]);

    const names = agent.getTools().map((t) => t.name);
    expect(names).toEqual(["file_read"]);
  });
});

describe("subagent-context stack", () => {
  it("tracks nesting depth via push/pop", () => {
    expect(getSubagentDepth()).toBe(0);

    const task = makeTask("outer");
    pushSubagentContext({ parentTask: task, parentToolNames: ["file_read"] });
    expect(getSubagentDepth()).toBe(1);
    expect(getCurrentSubagentContext()?.parentTask.id).toBe("outer");

    const innerTask = makeTask("inner");
    pushSubagentContext({ parentTask: innerTask, parentToolNames: [] });
    expect(getSubagentDepth()).toBe(2);
    expect(getCurrentSubagentContext()?.parentTask.id).toBe("inner");

    popSubagentContext();
    expect(getSubagentDepth()).toBe(1);
    expect(getCurrentSubagentContext()?.parentTask.id).toBe("outer");

    popSubagentContext();
    expect(getSubagentDepth()).toBe(0);
    expect(getCurrentSubagentContext()).toBeUndefined();
  });
});
