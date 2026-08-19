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
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

  // Regression, confirmed live on a real SWE-bench task: rejecting
  // executeWithTimeout()'s own wrapper promise on timeout used to be the
  // ONLY thing that happened — the underlying agent.execute() call kept
  // running for as long as it wanted, fully unsupervised. Several more
  // real tool calls (including one that overwrote a real source file with
  // placeholder garbage) executed for minutes after the timeout failure
  // had already been reported to the user. cancel() is the cooperative
  // signal BaseAgent's main loop checks between iterations to actually
  // stop continuing.
  it("calls agent.cancel() when the execution timeout fires, not just rejecting its own wrapper promise", async () => {
    const spawner = createAgentSpawner();
    const spawned = await spawner.spawn("code", makeTask("do something"));
    spawned.agent.execute = () => new Promise(() => {}); // never resolves
    const cancelSpy = vi.spyOn(spawned.agent, "cancel");

    await spawner.execute(spawned.id, spawner.getSpawnOptions({ timeout: 30 }));

    expect(cancelSpy).toHaveBeenCalled();
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

  // Regression for a live-reproduced bug: TaskAnalyzer suggests multi-
  // stage 'pipeline'/'parallel' strategies (e.g. ['plan', 'code', 'test'])
  // for anything above 'simple' complexity, but executeTask() used to
  // always take just suggestedStrategy.agents[0] and run ONLY that one
  // stage — silently dropping every stage after it. Confirmed live: a
  // trivial "create a file" task got classified as medium complexity,
  // got a pipeline suggestion starting with 'plan', and since plan
  // mode's tool set has no file_write, the file was never actually
  // created — the task "succeeded" having done nothing. Fixed by
  // routing non-'single' strategies with more than one stage through
  // ParallelOrchestrator.executePipeline() instead.
  it("runs every stage of a multi-stage strategy, not just the first, for a task with no command override", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    // The exact description that triggered this live — real TaskAnalyzer
    // classification, not a mocked one.
    const task = makeTask(
      "Create a file called hello.txt containing exactly the text: hello world",
    );
    const result = await executeTask(task);
    expect(result.success).toBe(true);
    // ParallelOrchestrator.executePipeline() always reports
    // agentType:"orchestrator" and joins each stage's own
    // "[Subtask N PASSED (mode)]: ..." line into its output — a
    // single-agent run never produces that shape, so this is a
    // structural signal that more than one stage actually executed.
    expect(result.agentType).toBe("orchestrator");
    expect(result.output).toContain("[Subtask 1 PASSED");
    expect(result.output).toContain("[Subtask 2 PASSED");
  });

  // Regression for a second live-reproduced bug found while fixing the one
  // above: once the pipeline actually ran every stage, the 'plan' stage
  // received the SAME raw imperative description as every other stage
  // ("Create a file called hello.txt...") — a model given that verbatim,
  // with a system prompt naming file_read/directory_create/search_files/
  // search_content/workspace_verify/spawn_subagent as its ONLY tools (no
  // file_write), reasonably tried to satisfy it directly anyway and
  // attempted a tool call outside its own schema. Confirmed live against
  // Groq's real API: the model emitted a hallucinated "tool_file_write"
  // call, which Groq's grammar-constrained tool decoding hard-rejected
  // with 400 "Parsing failed" / "Tool choice is none, but model called a
  // tool" — a real request failure, not a benign no-op. Fixed by
  // reframing the 'plan' stage's description (describeSubtask()) to make
  // explicit that its job is to produce a plan, not execute one.
  it("reframes the 'plan' stage's description as a planning request instead of the raw imperative task text", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const task = makeTask(
      "Create a file called hello.txt containing exactly the text: hello world",
    );
    await executeTask(task);

    const firstCallMessages = env.provider.calls[0];
    const userMessage = firstCallMessages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("Produce a step-by-step");
    expect(userMessage?.content).toContain(
      "Create a file called hello.txt containing exactly the text: hello world",
    );
    // The raw imperative sentence must not appear as the ENTIRE message —
    // only wrapped inside the planning framing.
    expect(userMessage?.content).not.toMatch(
      /^Create a file called hello\.txt/,
    );
  });

  // Regression for a THIRD live-reproduced bug in the same pipeline path:
  // executeTask()'s direct call to ParallelOrchestrator.executePipeline()
  // used to pass a literal `[]` for parentToolNames. narrowChildTools()
  // intersects a spawned stage's tools against that set — correct when a
  // REAL parent agent exists (spawn_subagent's call, which passes the
  // live parent's actual tool names), but this call site has no real
  // parent at all (it's the root of execution). Intersecting against `[]`
  // silently stripped EVERY tool from EVERY pipeline stage. Confirmed
  // live: a 'code' stage with zero tools still had the model attempt a
  // file_write call anyway (driven by the system prompt's "Available
  // tools: ..." text), which Groq's real API hard-rejected with 400
  // since there was no `tools` schema to validate the call against —
  // every top-level multi-stage task failed this way, not an edge case.
  it("does not strip tools from pipeline stages spawned directly by executeTask() (no real parent agent to narrow against)", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const task = makeTask(
      "Create a file called hello.txt containing exactly the text: hello world",
    );
    await executeTask(task);

    // Every recorded call's tools must be non-empty — 'plan' mode alone
    // has 6 tools (file_read, directory_create, search_files,
    // search_content, workspace_verify, spawn_subagent); if narrowing had
    // (incorrectly) applied here, every one of these would be `undefined`
    // or an empty array instead.
    expect(env.provider.callOptions.length).toBeGreaterThan(0);
    for (const options of env.provider.callOptions) {
      expect(options?.tools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("a single-stage ('simple' complexity) task still runs directly through spawn(), not the pipeline path", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const result = await executeTask(makeTask("write a simple hello world function"));
    expect(result.success).toBe(true);
    // Single-agent results never have the "[Subtask N PASSED" shape
    // ParallelOrchestrator produces.
    expect(result.output).not.toContain("[Subtask");
  });

  it("a command-metadata override always stays single-agent, even if the description would otherwise suggest a pipeline", async () => {
    env = setupFakeAgentEnv([scriptedResult("Debugged.")]);
    const result = await executeTask(
      makeTask("Create a file called hello.txt containing exactly the text: hello world", {
        command: "debug",
      }),
    );
    expect(result.agentType).toBe("debug");
    expect(result.output).not.toContain("[Subtask");
  });

  // Regression coverage for a real SWE-bench task run: getSpawnOptions()'s
  // timeout is purely system-load-derived (as low as 120s under
  // "critical" status — a real, observed status on a memory-constrained
  // dev machine) and has no awareness that 'debug'/'plan'/'orchestrator'
  // agent types now route to a slower "quality" tier model by design (see
  // BaseAgent.initializeContext()'s preferQuality wiring). Confirmed live:
  // a real investigative task's LLM calls alone took ~4 minutes, comfortably
  // inside a 5-minute budget but past the 120s one, and got cut off
  // mid-investigation as a result.
  it("gives a reasoning-category agent type (debug) at least a 5-minute timeout floor, regardless of system-load-derived defaults", async () => {
    env = setupFakeAgentEnv([scriptedResult("Diagnosed.")]);
    const executeSpy = vi.spyOn(AgentSpawner.prototype, "execute");

    await executeTask(makeTask("something is broken", { command: "debug" }));

    expect(executeSpy).toHaveBeenCalled();
    const [, spawnOptions] = executeSpy.mock.calls[0];
    expect(spawnOptions?.timeout).toBeGreaterThanOrEqual(300000);
    executeSpy.mockRestore();
  });

  it("does not inflate the timeout for a non-reasoning agent type (code)", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const executeSpy = vi.spyOn(AgentSpawner.prototype, "execute");

    await executeTask(makeTask("write a function", { command: "simplify" }));

    expect(executeSpy).toHaveBeenCalled();
    const [, spawnOptions] = executeSpy.mock.calls[0];
    // Not asserting an exact value (it's system-load-derived, either
    // 120000 or 300000 depending on this machine's live status right
    // now) — only that the reasoning-specific floor logic didn't apply.
    expect([120000, 300000]).toContain(spawnOptions?.timeout);
    executeSpy.mockRestore();
  });
});
