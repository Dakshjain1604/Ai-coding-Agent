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
import { describe, it, expect, vi, afterEach } from "vitest";
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
import type { Task, TaskResult } from "../../src/utils/types.js";

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

  it("refuses when depth exceeds MAX_SUBAGENT_DEPTH, not just equals it", async () => {
    const orchestrator = new ParallelOrchestrator();
    const result = await orchestrator.executePipeline(
      makeTask("t4"),
      [{ mode: "code", description: "x" }],
      [],
      MAX_SUBAGENT_DEPTH + 5,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("depth limit");
  });

  it("depth-limit refusal never constructs or runs any agent (empty output, zero duration)", async () => {
    const orchestrator = new ParallelOrchestrator();
    const result = await orchestrator.executePipeline(
      makeTask("t5"),
      [
        { mode: "code", description: "a" },
        { mode: "test", description: "b" },
      ],
      [],
      MAX_SUBAGENT_DEPTH,
    );
    expect(result.durationMs).toBe(0);
    expect(result.agentType).toBe("orchestrator");
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

  it("REGRESSION: fails closed (zero tools) when parentToolNames is empty, not open (full access)", () => {
    // The previous version treated an empty parentToolNames as "skip
    // narrowing entirely", handing the child its full mode tool set —
    // silently violating "a child can never have more capability than its
    // parent granted it" the moment parent info was ever unavailable.
    const orchestrator = new ParallelOrchestrator();
    const agent = new UniversalAgent("code");

    (
      orchestrator as unknown as {
        narrowChildTools: (a: UniversalAgent, names: string[]) => void;
      }
    ).narrowChildTools(agent, []);

    expect(agent.getTools()).toEqual([]);
  });

  it("keeps the child's full mode tool set when the parent has a strict superset", () => {
    const orchestrator = new ParallelOrchestrator();
    const agent = new UniversalAgent("review"); // small, well-known tool set
    const beforeNames = agent.getTools().map((t) => t.name);

    (
      orchestrator as unknown as {
        narrowChildTools: (a: UniversalAgent, names: string[]) => void;
      }
    ).narrowChildTools(agent, [...beforeNames, "some_extra_parent_only_tool"]);

    const afterNames = agent.getTools().map((t) => t.name);
    expect(afterNames.sort()).toEqual(beforeNames.sort());
  });

  it("leaves the child with zero tools when parent and child tool sets don't overlap at all", () => {
    const orchestrator = new ParallelOrchestrator();
    const agent = new UniversalAgent("code");

    (
      orchestrator as unknown as {
        narrowChildTools: (a: UniversalAgent, names: string[]) => void;
      }
    ).narrowChildTools(agent, ["totally_unrelated_tool_name"]);

    expect(agent.getTools()).toEqual([]);
  });

  it("narrows correctly for every mode, always excluding shell_exec/spawn_subagent", () => {
    const orchestrator = new ParallelOrchestrator();
    const allToolNames = [
      "file_read",
      "file_write",
      "directory_create",
      "search_files",
      "search_content",
      "grep",
      "find_usages",
      "shell_exec",
      "git_status",
      "git_add",
      "git_commit",
      "git_diff",
      "workspace_verify",
      "spawn_subagent",
      "test_run",
      "analyze_imports",
      "analyze_exports",
    ];
    for (const mode of ["code", "debug", "test", "review", "plan"] as const) {
      const agent = new UniversalAgent(mode);
      (
        orchestrator as unknown as {
          narrowChildTools: (a: UniversalAgent, names: string[]) => void;
        }
      ).narrowChildTools(agent, allToolNames);

      const names = agent.getTools().map((t) => t.name);
      expect(names).not.toContain("shell_exec");
      expect(names).not.toContain("spawn_subagent");
    }
  });
});

describe("ParallelOrchestrator context accumulation (boundedContext)", () => {
  function getBoundedContext(orchestrator: ParallelOrchestrator, results: string[]): string {
    return (
      orchestrator as unknown as {
        boundedContext: (r: string[]) => string;
      }
    ).boundedContext(results);
  }

  it("joins short results verbatim, unchanged", () => {
    const orchestrator = new ParallelOrchestrator();
    const out = getBoundedContext(orchestrator, ["result one", "result two"]);
    expect(out).toBe("result one\n\nresult two");
  });

  it("returns an empty string for zero results", () => {
    const orchestrator = new ParallelOrchestrator();
    expect(getBoundedContext(orchestrator, [])).toBe("");
  });

  it("truncates when accumulated results exceed the cap, keeping the tail", () => {
    const orchestrator = new ParallelOrchestrator();
    const huge = "x".repeat(20000);
    const out = getBoundedContext(orchestrator, [huge]);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("truncated");
    // The tail (most recent content) must survive, not the head.
    expect(out.endsWith("x")).toBe(true);
  });

  it("does not truncate content sitting exactly at the cap", () => {
    const orchestrator = new ParallelOrchestrator();
    const exact = "y".repeat(16000);
    const out = getBoundedContext(orchestrator, [exact]);
    expect(out).toBe(exact);
  });
});

describe("ParallelOrchestrator subtask metadata — mode-leak regression", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubExecuteCapturingMode(): { resolvedModes: string[] } {
    const captured: { resolvedModes: string[] } = { resolvedModes: [] };
    vi.spyOn(UniversalAgent.prototype, "execute").mockImplementation(
      async function (
        this: UniversalAgent & {
          currentMode: string;
          modeExplicitlySet: boolean;
        },
        task: Task,
      ): Promise<TaskResult> {
        // Mirrors execute()'s real mode-resolution logic exactly, without
        // needing a live LLM call — the point is to observe which mode a
        // subtask actually resolves to.
        let mode = this.currentMode;
        if (task.metadata?.mode && task.metadata.mode !== "auto") {
          mode = task.metadata.mode as string;
        } else if (!this.modeExplicitlySet) {
          mode = this.detectMode(task.description);
        }
        captured.resolvedModes.push(mode);
        return {
          taskId: task.id,
          success: true,
          output: "stub",
          durationMs: 0,
          agentType: "code",
        };
      },
    );
    return captured;
  }

  it("REGRESSION: a subtask's plan.mode is not overridden by the parent task's own metadata.mode", async () => {
    const captured = stubExecuteCapturingMode();
    const orchestrator = new ParallelOrchestrator();
    const parentTask: Task = {
      ...makeTask("parent"),
      metadata: { mode: "code" }, // simulates a parent run with --mode=code
    };

    await orchestrator.executePipeline(
      parentTask,
      [{ mode: "test", description: "run the test suite" }],
      [],
      0,
    );

    expect(captured.resolvedModes).toEqual(["test"]);
  });

  it("does not leak the parent's mode across multiple subtasks with different intended modes", async () => {
    const captured = stubExecuteCapturingMode();
    const orchestrator = new ParallelOrchestrator();
    const parentTask: Task = {
      ...makeTask("parent"),
      metadata: { mode: "review" },
    };

    await orchestrator.executePipeline(
      parentTask,
      [
        { mode: "code", description: "implement" },
        { mode: "test", description: "verify" },
        { mode: "review", description: "review" },
      ],
      [],
      0,
    );

    expect(captured.resolvedModes).toEqual(["code", "test", "review"]);
  });

  it("does not misfire when the parent's metadata.mode is 'auto' (already excluded either way)", async () => {
    const captured = stubExecuteCapturingMode();
    const orchestrator = new ParallelOrchestrator();
    const parentTask: Task = {
      ...makeTask("parent"),
      metadata: { mode: "auto" },
    };

    await orchestrator.executePipeline(
      parentTask,
      [{ mode: "debug", description: "diagnose" }],
      [],
      0,
    );

    expect(captured.resolvedModes).toEqual(["debug"]);
  });

  it("still resolves the intended mode when the parent task has no metadata at all", async () => {
    const captured = stubExecuteCapturingMode();
    const orchestrator = new ParallelOrchestrator();
    const parentTask: Task = { ...makeTask("parent"), metadata: undefined };

    await orchestrator.executePipeline(
      parentTask,
      [{ mode: "plan", description: "plan the work" }],
      [],
      0,
    );

    expect(captured.resolvedModes).toEqual(["plan"]);
  });

  it("preserves other parent metadata fields (only mode is excluded from the spread)", async () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    vi.spyOn(UniversalAgent.prototype, "execute").mockImplementation(
      async (task: Task): Promise<TaskResult> => {
        capturedMetadata = task.metadata;
        return { taskId: task.id, success: true, output: "stub", durationMs: 0, agentType: "code" };
      },
    );

    const orchestrator = new ParallelOrchestrator();
    const parentTask: Task = {
      ...makeTask("parent"),
      metadata: { mode: "code", noConfirm: true, forcedModel: "some-model" },
    };

    await orchestrator.executePipeline(
      parentTask,
      [{ mode: "test", description: "verify" }],
      [],
      0,
    );

    expect(capturedMetadata?.mode).toBeUndefined();
    expect(capturedMetadata?.noConfirm).toBe(true);
    expect(capturedMetadata?.forcedModel).toBe("some-model");
    expect(capturedMetadata?.subagentDepth).toBe(1);
  });

  it("increments subagentDepth correctly across the pipeline regardless of caller depth", async () => {
    let capturedDepth: unknown;
    vi.spyOn(UniversalAgent.prototype, "execute").mockImplementation(
      async (task: Task): Promise<TaskResult> => {
        capturedDepth = task.metadata?.subagentDepth;
        return { taskId: task.id, success: true, output: "stub", durationMs: 0, agentType: "code" };
      },
    );

    const orchestrator = new ParallelOrchestrator();
    await orchestrator.executePipeline(
      makeTask("parent"),
      [{ mode: "code", description: "x" }],
      [],
      1, // caller is already at depth 1
    );

    expect(capturedDepth).toBe(2);
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
