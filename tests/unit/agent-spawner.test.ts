/**
 * Tests for AgentSpawner.ts (core/orchestrator/AgentSpawner.ts) —
 * previously ZERO test coverage despite being the actual execution engine
 * behind every CLI command (`run`/`debug`/`test`/`review`/`simplify` all
 * go through executeTask(), interactive mode goes through spawn()+
 * execute() directly) and the interactive-mode REPL loop.
 *
 * The centerpiece regression here: registerAgentFactories() used to
 * construct `new UniversalAgent()` (no mode arg) and call `.setMode(mode)`
 * afterward — but only the CONSTRUCTOR sets modeExplicitlySet = true.
 * Confirmed live: spawning a "debug" agent via AgentSpawner, then
 * executing a task worded like a review request (no debug-specific
 * keywords), silently ran in "review" mode instead — UniversalAgent.
 * execute() treats an agent with modeExplicitlySet=false as never having
 * been pinned, and re-detects the mode from task.description the moment
 * task.metadata.mode isn't set (which none of run/debug/test/review/
 * simplify ever set). This defeated the entire purpose of having
 * dedicated `debug`/`test`/`review` commands — they weren't reliably
 * running in the mode they were explicitly invoked for.
 *
 * Also covers: the unbounded-growth memory leak in the `agents` map
 * (interactive mode spawns one agent per turn through this singleton and
 * never calls destroy()) and the getSpawnOptions() wiring (previously
 * computed but never actually passed to execute() anywhere).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  AgentSpawner,
  createAgentSpawner,
  executeTask,
} from "../../src/core/orchestrator/AgentSpawner.js";
import type { Task } from "../../src/utils/types.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

function makeTask(description: string, metadata?: Record<string, unknown>): Task {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    description,
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata,
  };
}

describe("AgentSpawner — mode-pinning regression (the core bug)", () => {
  let spawner: AgentSpawner;

  beforeEach(() => {
    spawner = createAgentSpawner();
  });

  it("pins code mode explicitly (modeExplicitlySet=true), not just currentMode", async () => {
    const spawned = await spawner.spawn("code", makeTask("anything"));
    const agent = spawned.agent as unknown as {
      currentMode: string;
      modeExplicitlySet: boolean;
    };
    expect(agent.currentMode).toBe("code");
    expect(agent.modeExplicitlySet).toBe(true);
  });

  for (const type of ["debug", "test", "review", "plan"] as const) {
    it(`pins ${type} mode explicitly`, async () => {
      const spawned = await spawner.spawn(type, makeTask("anything"));
      const agent = spawned.agent as unknown as {
        currentMode: string;
        modeExplicitlySet: boolean;
      };
      expect(agent.currentMode).toBe(type);
      expect(agent.modeExplicitlySet).toBe(true);
    });
  }

  it("maps 'orchestrator' type to a plan-mode agent, still explicitly pinned", async () => {
    const spawned = await spawner.spawn("orchestrator", makeTask("anything"));
    const agent = spawned.agent as unknown as {
      currentMode: string;
      modeExplicitlySet: boolean;
    };
    expect(agent.currentMode).toBe("plan");
    expect(agent.modeExplicitlySet).toBe(true);
  });

  it("stays pinned to debug mode even when the description is worded like a review request", async () => {
    // No debug-specific keywords (fix/bug/error/crash/broken/issue/
    // exception) anywhere — this description alone would auto-detect as
    // "review" if modeExplicitlySet weren't correctly set.
    const spawned = await spawner.spawn(
      "debug",
      makeTask("please analyze code quality and suggest improvements"),
    );
    const agent = spawned.agent as unknown as { modeExplicitlySet: boolean };
    expect(agent.modeExplicitlySet).toBe(true);
  });

  it("stays pinned to review mode even when the description is worded like a debug request", async () => {
    const spawned = await spawner.spawn(
      "review",
      makeTask("fix this broken exception in the database connection"),
    );
    const agent = spawned.agent as unknown as { modeExplicitlySet: boolean };
    expect(agent.modeExplicitlySet).toBe(true);
  });
});

describe("AgentSpawner — mode-pinning, real end-to-end through execute()", () => {
  let spawner: AgentSpawner;
  let env: FakeAgentEnv;

  beforeEach(() => {
    spawner = createAgentSpawner();
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("a spawned 'debug' agent's result stays agentType 'debug' despite review-worded description", async () => {
    env = setupFakeAgentEnv([scriptedResult("Analysis complete.")]);

    const spawned = await spawner.spawn(
      "debug",
      makeTask("please analyze code quality and suggest improvements"),
    );
    const result = await spawner.execute(spawned.id);

    expect(result.success).toBe(true);
    expect(result.agentType).toBe("debug");
  });

  it("a spawned 'test' agent's result stays agentType 'test' despite plan-worded description", async () => {
    env = setupFakeAgentEnv([scriptedResult("Tests planned.")]);

    const spawned = await spawner.spawn(
      "test",
      makeTask("break this down into clear architectural steps"),
    );
    const result = await spawner.execute(spawned.id);

    expect(result.success).toBe(true);
    expect(result.agentType).toBe("test");
  });
});

describe("AgentSpawner — spawn() capacity limiting", () => {
  it("throws once the number of RUNNING agents reaches maxParallel", async () => {
    const spawner = createAgentSpawner(1);
    const spawned = await spawner.spawn("code", makeTask("first"));
    (spawned as unknown as { status: string }).status = "running";

    await expect(spawner.spawn("code", makeTask("second"))).rejects.toThrow(/capacity/i);
  });

  it("does not count pending agents against capacity", async () => {
    const spawner = createAgentSpawner(1);
    await spawner.spawn("code", makeTask("first")); // stays "pending", never executed

    await expect(spawner.spawn("code", makeTask("second"))).resolves.toBeDefined();
  });

  it("does not count completed/failed agents against capacity", async () => {
    const spawner = createAgentSpawner(1);
    const spawned = await spawner.spawn("code", makeTask("first"));
    (spawned as unknown as { status: string }).status = "completed";

    await expect(spawner.spawn("code", makeTask("second"))).resolves.toBeDefined();
  });
});

describe("AgentSpawner — finished-agent pruning (memory leak fix)", () => {
  let spawner: AgentSpawner;
  let env: FakeAgentEnv;

  beforeEach(() => {
    spawner = createAgentSpawner();
  });

  afterEach(() => {
    env?.cleanup();
  });

  async function spawnAndFinish(n: number): Promise<void> {
    env = setupFakeAgentEnv(Array.from({ length: n }, () => scriptedResult("done")));
    for (let i = 0; i < n; i++) {
      const spawned = await spawner.spawn("code", makeTask(`task ${i}`));
      await spawner.execute(spawned.id);
    }
  }

  it("retains all finished agents when under the cap", async () => {
    await spawnAndFinish(5);
    expect(spawner.getAllSpawned().length).toBe(5);
  }, 15000);

  it("caps total retained finished agents at 20 regardless of how many ran", async () => {
    await spawnAndFinish(25);
    expect(spawner.getAllSpawned().length).toBe(20);
  }, 30000);

  it("evicts the OLDEST finished agents first, keeping the most recent", async () => {
    env = setupFakeAgentEnv(Array.from({ length: 22 }, () => scriptedResult("done")));
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const spawned = await spawner.spawn("code", makeTask(`task ${i}`));
      ids.push(spawned.id);
      await spawner.execute(spawned.id);
    }

    // The first two spawned (oldest) must have been evicted.
    expect(spawner.getSpawned(ids[0])).toBeUndefined();
    expect(spawner.getSpawned(ids[1])).toBeUndefined();
    // The most recent one must still be there.
    expect(spawner.getSpawned(ids[ids.length - 1])).toBeDefined();
  }, 30000);

  it("never evicts a running or pending agent, even when finished agents exceed the cap", async () => {
    await spawnAndFinish(25);
    const stillPending = await spawner.spawn("code", makeTask("pending one"));

    expect(spawner.getSpawned(stillPending.id)).toBeDefined();
    // Still capped at 20 finished + this 1 pending = 21 total.
    expect(spawner.getAllSpawned().length).toBe(21);
  }, 30000);
});

describe("AgentSpawner — execute() error handling and callbacks", () => {
  let spawner: AgentSpawner;
  let env: FakeAgentEnv;

  beforeEach(() => {
    spawner = createAgentSpawner();
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("throws for an unknown spawnedId", async () => {
    await expect(spawner.execute("does-not-exist")).rejects.toThrow(/not found/i);
  });

  it("marks status 'completed' and calls onComplete on success", async () => {
    env = setupFakeAgentEnv([scriptedResult("done")]);
    const spawned = await spawner.spawn("code", makeTask("do something"));

    let completedWith: unknown;
    await spawner.execute(spawned.id, {
      onComplete: (id, result) => {
        completedWith = { id, result };
      },
    });

    expect(spawned.status).toBe("completed");
    expect((completedWith as { id: string }).id).toBe(spawned.id);
  });

  it("catches a throwing agent.execute() and returns a failed TaskResult instead of rejecting", async () => {
    const spawner2 = createAgentSpawner();
    const spawned = await spawner2.spawn("code", makeTask("do something"));
    spawned.agent.execute = async () => {
      throw new Error("boom");
    };

    const result = await spawner2.execute(spawned.id);
    expect(result.success).toBe(false);
    expect(result.output).toContain("boom");
    expect(spawned.status).toBe("failed");
  });

  it("calls onError (not onComplete) when the agent throws", async () => {
    const spawner2 = createAgentSpawner();
    const spawned = await spawner2.spawn("code", makeTask("do something"));
    spawned.agent.execute = async () => {
      throw new Error("boom");
    };

    let errorCalled = false;
    let completeCalled = false;
    await spawner2.execute(spawned.id, {
      onError: () => {
        errorCalled = true;
      },
      onComplete: () => {
        completeCalled = true;
      },
    });

    expect(errorCalled).toBe(true);
    expect(completeCalled).toBe(false);
  });

  it("times out an agent that takes longer than the configured timeout", async () => {
    const spawner2 = createAgentSpawner();
    const spawned = await spawner2.spawn("code", makeTask("do something"));
    spawned.agent.execute = () => new Promise(() => {}); // never resolves

    const result = await spawner2.execute(spawned.id, { timeout: 50 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
  });

  it("still prunes finished agents even after a failure", async () => {
    const spawner2 = createAgentSpawner();
    const spawned = await spawner2.spawn("code", makeTask("do something"));
    spawned.agent.execute = async () => {
      throw new Error("boom");
    };
    await spawner2.execute(spawned.id);

    expect(spawner2.getAllSpawned().length).toBe(1); // well under the cap, just confirms no crash in the finally path
  });
});

describe("AgentSpawner — createAgent() / factory errors", () => {
  it("throws a clear error for an unregistered agent type", async () => {
    const spawner = createAgentSpawner();
    await expect(
      spawner.spawn("nonexistent" as never, makeTask("x")),
    ).rejects.toThrow(/unknown agent type/i);
  });
});

describe("AgentSpawner — spawn() id generation", () => {
  it("generates a unique id per spawned agent, even for the same type", async () => {
    const spawner = createAgentSpawner();
    const a = await spawner.spawn("code", makeTask("a"));
    const b = await spawner.spawn("code", makeTask("b"));
    expect(a.id).not.toBe(b.id);
  });

  it("prefixes the id with the agent type", async () => {
    const spawner = createAgentSpawner();
    const spawned = await spawner.spawn("debug", makeTask("a"));
    expect(spawned.id.startsWith("debug_")).toBe(true);
  });

  it("sets status 'pending' and records a startTime immediately after spawn", async () => {
    const spawner = createAgentSpawner();
    const before = Date.now();
    const spawned = await spawner.spawn("code", makeTask("a"));
    expect(spawned.status).toBe("pending");
    expect(spawned.startTime.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("attaches the exact task object passed in, unchanged", async () => {
    const spawner = createAgentSpawner();
    const task = makeTask("a specific description");
    const spawned = await spawner.spawn("code", task);
    expect(spawned.task).toBe(task);
  });
});

describe("AgentSpawner — getSpawned/getAllSpawned/getSpawnedByStatus/destroy", () => {
  let spawner: AgentSpawner;

  beforeEach(() => {
    spawner = createAgentSpawner();
  });

  it("getSpawned returns the spawned agent by id", async () => {
    const spawned = await spawner.spawn("code", makeTask("x"));
    expect(spawner.getSpawned(spawned.id)).toBe(spawned);
  });

  it("getSpawned returns undefined for an unknown id", () => {
    expect(spawner.getSpawned("nope")).toBeUndefined();
  });

  it("getAllSpawned returns every spawned agent", async () => {
    await spawner.spawn("code", makeTask("a"));
    await spawner.spawn("debug", makeTask("b"));
    expect(spawner.getAllSpawned().length).toBe(2);
  });

  it("getSpawnedByStatus filters correctly", async () => {
    const a = await spawner.spawn("code", makeTask("a"));
    await spawner.spawn("debug", makeTask("b"));
    (a as unknown as { status: string }).status = "running";

    expect(spawner.getSpawnedByStatus("running").map((s) => s.id)).toEqual([a.id]);
    expect(spawner.getSpawnedByStatus("pending").length).toBe(1);
  });

  it("destroy() removes a specific agent", async () => {
    const spawned = await spawner.spawn("code", makeTask("x"));
    spawner.destroy(spawned.id);
    expect(spawner.getSpawned(spawned.id)).toBeUndefined();
  });

  it("destroyAll() clears every agent", async () => {
    await spawner.spawn("code", makeTask("a"));
    await spawner.spawn("debug", makeTask("b"));
    spawner.destroyAll();
    expect(spawner.getAllSpawned()).toEqual([]);
  });
});

describe("AgentSpawner — getSpawnOptions()", () => {
  it("provides a default timeout without overrides", () => {
    const spawner = createAgentSpawner();
    const options = spawner.getSpawnOptions();
    expect(typeof options.timeout).toBe("number");
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("an explicit timeout override wins over the computed default", () => {
    const spawner = createAgentSpawner();
    const options = spawner.getSpawnOptions({ timeout: 999 });
    expect(options.timeout).toBe(999);
  });

  it("clamps maxParallel to the spawner's own constructed maxParallel", () => {
    const spawner = createAgentSpawner(1);
    const options = spawner.getSpawnOptions({ maxParallel: 999 });
    // Math.min(999, this.maxParallel=1, config.defaults.maxParallelAgents)
    // — must never exceed what THIS spawner was constructed with.
    expect(options.maxParallel).toBeLessThanOrEqual(1);
  });

  it("passes through onProgress/onComplete/onError callbacks unchanged", () => {
    const spawner = createAgentSpawner();
    const onProgress = () => {};
    const onComplete = () => {};
    const onError = () => {};
    const options = spawner.getSpawnOptions({ onProgress, onComplete, onError });
    expect(options.onProgress).toBe(onProgress);
    expect(options.onComplete).toBe(onComplete);
    expect(options.onError).toBe(onError);
  });

  it("execute() actually uses getSpawnOptions()'s timeout when passed through", async () => {
    const spawner = createAgentSpawner();
    const spawned = await spawner.spawn("code", makeTask("do something"));
    spawned.agent.execute = () => new Promise(() => {}); // never resolves

    const result = await spawner.execute(spawned.id, spawner.getSpawnOptions({ timeout: 30 }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
  });
});

describe("executeTask() — convenience function integration", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("routes a task with metadata.command='debug' to a debug-mode agent", async () => {
    env = setupFakeAgentEnv([scriptedResult("Debugged.")]);
    const result = await executeTask(makeTask("fix this thing", { command: "debug" }));
    expect(result.agentType).toBe("debug");
  });

  it("routes a task with metadata.command='test' to a test-mode agent", async () => {
    env = setupFakeAgentEnv([scriptedResult("Tested.")]);
    const result = await executeTask(makeTask("write tests", { command: "test" }));
    expect(result.agentType).toBe("test");
  });

  it("routes a task with metadata.command='review' to a review-mode agent", async () => {
    env = setupFakeAgentEnv([scriptedResult("Reviewed.")]);
    const result = await executeTask(makeTask("check quality", { command: "review" }));
    expect(result.agentType).toBe("review");
  });

  it("routes a task with metadata.command='simplify' to a code-mode agent", async () => {
    env = setupFakeAgentEnv([scriptedResult("Simplified.")]);
    const result = await executeTask(makeTask("simplify this", { command: "simplify" }));
    expect(result.agentType).toBe("code");
  });

  it("stays pinned to the command-routed mode even when the description suggests a different one", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    // A "review"-command task worded like a debug request.
    const result = await executeTask(
      makeTask("fix this broken exception", { command: "review" }),
    );
    expect(result.agentType).toBe("review");
  });

  it("populates task.risk from TaskAnalyzer", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const task = makeTask("delete the production database");
    await executeTask(task);
    expect(task.risk).toBeDefined();
  });

  it("populates task.metadata.riskFactors from TaskAnalyzer", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const task = makeTask("delete the production database");
    await executeTask(task);
    expect(task.metadata?.riskFactors).toBeDefined();
  });

  it("preserves other metadata fields already on the task alongside riskFactors", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const task = makeTask("do something", { command: "debug", targetFile: "a.ts" });
    await executeTask(task);
    expect(task.metadata?.targetFile).toBe("a.ts");
    expect(task.metadata?.command).toBe("debug");
  });

  it("falls back to TaskAnalyzer's suggested agent when no command is set in metadata", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    // No metadata.command at all — this is the `run` command's shape.
    const result = await executeTask(makeTask("write a simple hello world function"));
    // Whatever TaskAnalyzer suggests, it must be a real, valid agent type
    // that actually executed (not an error/undefined fallback).
    expect(result.success).toBe(true);
    expect(["code", "debug", "test", "review", "plan", "orchestrator"]).toContain(
      result.agentType,
    );
  });

  it("defaults to 'code' when metadata.command is set but unrecognized", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const result = await executeTask(makeTask("do something", { command: "not-a-real-command" }));
    expect(result.agentType).toBe("code");
  });
});
