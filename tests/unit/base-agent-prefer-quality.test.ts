/**
 * Regression coverage: ModelRouter.route()'s `preferQuality` option (->
 * ProviderRegistry's "quality" tier, e.g. Groq's openai/gpt-oss-120b
 * instead of the default -20b) was fully implemented but had zero real
 * callers anywhere in the codebase — BaseAgent.initializeContext() always
 * called route() with no options, so every task got the fast/small
 * default-tier model regardless of category.
 *
 * Confirmed live on a real SWE-bench task: the small default model both
 * (a) answered a genuine bug report conversationally from its own
 * pretrained knowledge instead of investigating with its tools, giving a
 * confidently WRONG explanation, and (b) in a follow-up run, correctly
 * found the right file but then returned a blank response with 0
 * completion tokens. "reasoning" (debug/plan) and "complex"
 * (orchestrator) task categories are exactly the investigative,
 * multi-step work most exposed to that kind of failure.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelRouter } from "../../src/providers/ModelRouter.js";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

describe("BaseAgent.initializeContext() — preferQuality wiring", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
    vi.restoreAllMocks();
  });

  it("requests the quality tier for a 'reasoning'-category mode (debug)", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const routeSpy = vi.spyOn(ModelRouter.prototype, "route");

    const agent = new UniversalAgent("debug");
    await agent.execute({
      id: "t1",
      description: "diagnose this",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(routeSpy).toHaveBeenCalled();
    const [category, , options] = routeSpy.mock.calls[0];
    expect(category).toBe("reasoning");
    expect(options?.preferQuality).toBe(true);
  });

  it("does NOT request the quality tier for a 'code'-category mode (mechanical edits)", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const routeSpy = vi.spyOn(ModelRouter.prototype, "route");

    const agent = new UniversalAgent("code");
    await agent.execute({
      id: "t2",
      description: "write this",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(routeSpy).toHaveBeenCalled();
    const [category, , options] = routeSpy.mock.calls[0];
    expect(category).toBe("code");
    expect(options?.preferQuality).toBeFalsy();
  });
});
