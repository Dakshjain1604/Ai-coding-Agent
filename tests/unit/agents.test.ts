import { describe, it, expect, afterEach } from "vitest";
import {
  UniversalAgent,
  buildTaskSystemPrompt,
} from "../../src/core/agents/UniversalAgent.js";
import { TOOL_SETS } from "../../src/core/agents/tool-sets.js";
import type { Task } from "../../src/utils/types.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

function makeTask(metadata?: Record<string, unknown>): Task {
  return {
    id: "t1",
    description: "do a thing",
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata,
  };
}

describe("UniversalAgent & Mode Management", () => {
  it("should auto-detect debug mode from task prompt", () => {
    const agent = new UniversalAgent();
    const mode = agent.detectMode("Fix breaking exception in database connection");
    expect(mode).toBe("debug");
  });

  it("should auto-detect test mode from task prompt", () => {
    const agent = new UniversalAgent();
    const mode = agent.detectMode("Run unit test suite and check coverage");
    expect(mode).toBe("test");
  });

  it("should register workspace_verify across all tool sets", () => {
    for (const [mode, tools] of Object.entries(TOOL_SETS)) {
      expect(tools).toContain("workspace_verify");
    }
  });

  // Regression test for the Wiring Audit's fix #3: skills were matched but
  // their instructions never reached the LLM — interactive.ts only printed
  // a console message. Verifies the instructions now actually land in the
  // system prompt built for the task.
  describe("skill instruction injection (fix #3)", () => {
    it("appends matched skill instructions to the system prompt", () => {
      const task = makeTask({
        skillName: "commit",
        skillInstructions: "1. Stage changes\n2. Write a commit message",
      });

      const prompt = buildTaskSystemPrompt("code", task);

      expect(prompt).toContain('matched the "commit" skill');
      expect(prompt).toContain("1. Stage changes");
      expect(prompt).toContain("2. Write a commit message");
    });

    it("does not mention skills when none matched", () => {
      const task = makeTask();
      const prompt = buildTaskSystemPrompt("code", task);
      expect(prompt).not.toContain("matched the");
    });
  });

  // Regression test found by actually running the CLI end-to-end: a "say
  // hello" task logged "Spawning plan agent" (from TaskAnalyzer's guess)
  // but ran with getTaskCategory() still returning "code" and code's
  // iteration/timeout/cost budget — because UniversalAgent's constructor
  // always called `super("code", {})`, and setMode() never updated
  // `this.type` or recomputed `this.config` for the real mode. Per-mode
  // config (plan: 6 iterations/$0.5 vs code: 12 iterations/$1.0) and
  // model-routing category (plan -> "reasoning" vs code -> "code") were
  // silently dead for every agent, regardless of which mode it actually ran in.
  describe("setMode keeps type/config/routing in sync (mode-desync bug)", () => {
    it("updates getType() to match the mode, not just the tool set", () => {
      const agent = new UniversalAgent("code");
      agent.setMode("plan");
      expect(agent.getType()).toBe("plan");
    });

    it("updates the iteration/cost budget to the new mode's defaults", () => {
      const agent = new UniversalAgent("code");
      agent.setMode("plan");

      const planConfig = (
        agent as unknown as {
          config: { maxIterations: number; maxCost: number };
        }
      ).config;
      // From BaseAgent.getDefaultConfig: plan = 6 iterations / $0.5,
      // code = 12 iterations / $1.0 — must actually differ per mode now.
      expect(planConfig.maxIterations).toBe(6);
      expect(planConfig.maxCost).toBe(0.5);
    });

    it("changes getTaskCategory()'s routing category with the mode", () => {
      const agent = new UniversalAgent("code") as unknown as {
        getTaskCategory: () => string;
      };
      const codeCategory = agent.getTaskCategory();
      expect(codeCategory).toBe("code");

      (agent as unknown as { setMode: (m: string) => void }).setMode("debug");
      const debugCategory = agent.getTaskCategory();
      expect(debugCategory).toBe("reasoning");
    });
  });

  // Regression test for architecture-optimal.md Phase 2 item C3:
  // redactToolArgs() only ever protected the telemetry payload — a tool's
  // own output flowed straight into the conversation unscrubbed. Verifies
  // executeTool() now scrubs secret-shaped values out of a tool's result.
  describe("secret scrubbing in executeTool (fix C3)", () => {
    it("redacts a secret-shaped value in a tool's output before returning it", async () => {
      const agent = new UniversalAgent("code");
      agent.registerTool({
        name: "file_read",
        description: "mock",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          success: true,
          output: "AWS_SECRET_ACCESS_KEY=abcdEFGH12345678ijkl",
        }),
      });

      const result = (await (agent as unknown as {
        executeTool: (
          name: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
      }).executeTool("file_read", { path: ".env" })) as {
        success: boolean;
        output: string;
      };

      expect(result.success).toBe(true);
      expect(result.output).toContain("AWS_SECRET_ACCESS_KEY=***REDACTED***");
      expect(result.output).not.toContain("abcdEFGH12345678ijkl");
    });
  });

  // Regression tests for the invalid-task.metadata.mode crash fix: a bare
  // `task.metadata.mode as AgentMode` cast used to reach setMode() with an
  // unvalidated string, crashing with "toolNames is not iterable" the
  // moment TOOL_SETS[mode] came back undefined. execute() now validates
  // via isValidAgentMode() before ever calling setMode(), and falls back
  // to auto-detection (or the agent's constructed mode, if one was pinned)
  // instead. These drive the REAL execute() loop through the FakeProvider
  // harness (not a hand-mocked internal call) so the fix is verified on
  // the actual production path, matching the discipline used throughout
  // tests/e2e/agent-loop.test.ts.
  describe("execute() mode validation (invalid task.metadata.mode crash fix)", () => {
    let env: FakeAgentEnv;

    afterEach(() => {
      env?.cleanup();
    });

    function makeModeTask(description: string, mode?: unknown): Task {
      return {
        id: "t-mode",
        description,
        complexity: "simple",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { mode },
      };
    }

    it("does not crash on an invalid mode string and falls back to auto-detection", async () => {
      env = setupFakeAgentEnv([scriptedResult("Fixed it.")]);
      const agent = new UniversalAgent(); // no explicit mode pinned
      const result = await agent.execute(
        makeModeTask("Fix breaking exception in database connection", "not-a-real-mode"),
      );

      expect(result.success).toBe(true);
      // detectMode() would resolve this description to "debug" — proves
      // the invalid mode was ignored and auto-detection ran instead of
      // crashing setMode().
      expect(result.agentType).toBe("debug");
    });

    it("uses a valid explicit mode correctly, overriding the constructed default", async () => {
      env = setupFakeAgentEnv([scriptedResult("Reviewed.")]);
      const agent = new UniversalAgent("code");
      const result = await agent.execute(makeModeTask("look at this code", "review"));

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("review");
    });

    it("treats 'auto' as no explicit override and falls back to auto-detection", async () => {
      env = setupFakeAgentEnv([scriptedResult("Test run complete.")]);
      const agent = new UniversalAgent();
      const result = await agent.execute(
        makeModeTask("Run unit test suite and check coverage", "auto"),
      );

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("test");
    });

    it("does not crash when task.metadata.mode is a number, and falls back to auto-detection", async () => {
      env = setupFakeAgentEnv([scriptedResult("Planned.")]);
      const agent = new UniversalAgent();
      const result = await agent.execute(makeModeTask("plan the next steps", 42));

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("plan");
    });

    it("does not crash when task.metadata.mode is a plain object, and falls back to auto-detection", async () => {
      env = setupFakeAgentEnv([scriptedResult("Reviewed.")]);
      const agent = new UniversalAgent();
      const result = await agent.execute(
        makeModeTask("review and refactor this", { nested: "review" }),
      );

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("review");
    });

    it("does not crash when task.metadata.mode is null, and falls back to auto-detection", async () => {
      env = setupFakeAgentEnv([scriptedResult("Fixed.")]);
      const agent = new UniversalAgent();
      const result = await agent.execute(makeModeTask("debug this crash", null));

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("debug");
    });

    it("keeps the agent's explicitly-constructed mode when task.metadata.mode is invalid, instead of auto-detecting", async () => {
      env = setupFakeAgentEnv([scriptedResult("Handled in plan mode.")]);
      // Constructed with an explicit mode ("plan") — modeExplicitlySet is
      // true, so an invalid task mode must NOT fall through to
      // detectMode(); it should keep the pinned "plan" mode even though
      // the description would otherwise auto-detect as "debug".
      const agent = new UniversalAgent("plan");
      const result = await agent.execute(
        makeModeTask("fix this breaking exception", "still-not-real"),
      );

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("plan");
    });

    it("keeps the agent's explicitly-constructed mode when task.metadata has no mode key at all", async () => {
      env = setupFakeAgentEnv([scriptedResult("Handled in review mode.")]);
      const agent = new UniversalAgent("review");
      const result = await agent.execute({
        id: "t-no-meta",
        description: "fix this breaking exception",
        complexity: "simple",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(result.success).toBe(true);
      expect(result.agentType).toBe("review");
    });
  });
});
