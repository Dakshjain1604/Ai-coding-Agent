/**
 * Tests for BaseAgent.executeTool()'s toolCallCount budget tracking —
 * previously had zero coverage at all.
 *
 * Centerpiece regression: toolCallCount only incremented in the success
 * path (after tool.execute() resolved), so a tool call that THREW never
 * counted against maxToolCalls at all. A single LLM turn can contain
 * many tool calls (UniversalAgent's loop processes them in a plain
 * sequential for-of, not one call per iteration), so the separate
 * maxIterations bound doesn't reliably cap total tool-call attempts
 * either — an agent stuck repeatedly failing the same call could make
 * far more actual attempts than maxToolCalls implies while the budget
 * counter stayed at 0. Fixed by counting every attempt, not just
 * successes.
 */
import { describe, it, expect } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import type { AgentTool } from "../../src/core/agents/BaseAgent.js";

type ExposedAgent = {
  executeTool(name: string, params: Record<string, unknown>): Promise<unknown>;
  toolCallCount: number;
  registerTool(tool: AgentTool): void;
};

function makeAgent(): ExposedAgent {
  return new UniversalAgent("code") as unknown as ExposedAgent;
}

// Named with a "test_" prefix so permission-system.ts's default rule
// table (pattern /^test_/ -> level "allow") lets these through without
// a permission prompt — an unrecognized tool name is denied outright by
// checkPermission() before ever reaching the handler, which would
// mask what this test is actually trying to exercise.
function alwaysFailingTool(): AgentTool {
  return {
    name: "test_always_fails",
    description: "test tool that always throws",
    parameters: {},
    execute: async () => {
      throw new Error("simulated failure");
    },
  };
}

function alwaysSucceedingTool(): AgentTool {
  return {
    name: "test_always_succeeds",
    description: "test tool that always succeeds",
    parameters: {},
    execute: async () => ({ success: true, output: "ok" }),
  };
}

describe("BaseAgent.executeTool() — toolCallCount counts every attempt", () => {
  it("increments toolCallCount even when the tool call throws", async () => {
    const agent = makeAgent();
    agent.registerTool(alwaysFailingTool());
    expect(agent.toolCallCount).toBe(0);

    await expect(agent.executeTool("test_always_fails", {})).rejects.toThrow("simulated failure");
    expect(agent.toolCallCount).toBe(1);

    await expect(agent.executeTool("test_always_fails", {})).rejects.toThrow("simulated failure");
    expect(agent.toolCallCount).toBe(2);
  });

  it("increments toolCallCount on a successful call (unchanged behavior)", async () => {
    const agent = makeAgent();
    agent.registerTool(alwaysSucceedingTool());
    expect(agent.toolCallCount).toBe(0);

    await agent.executeTool("test_always_succeeds", {});
    expect(agent.toolCallCount).toBe(1);
  });

  it("mixed success/failure calls both count toward the same budget", async () => {
    const agent = makeAgent();
    agent.registerTool(alwaysFailingTool());
    agent.registerTool(alwaysSucceedingTool());

    await agent.executeTool("test_always_succeeds", {});
    await expect(agent.executeTool("test_always_fails", {})).rejects.toThrow();
    await agent.executeTool("test_always_succeeds", {});

    expect(agent.toolCallCount).toBe(3);
  });
});
