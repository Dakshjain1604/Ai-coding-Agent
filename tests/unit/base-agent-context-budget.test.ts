/**
 * Regression coverage: BaseAgent.getDefaultConfig() sizes `maxTokens` (the
 * context/history BUDGET truncateMessages() uses) from SystemAnalyzer's
 * LOCAL machine load — appropriate for a local Ollama model, but a
 * category error for a cloud provider, whose real context window (128K+)
 * has nothing to do with this laptop's current memory pressure.
 *
 * Confirmed live on a real SWE-bench task: with a cloud provider serving
 * the request, on a machine SystemAnalyzer reported as "critical" status
 * (recommendedMaxTokens: 8000), conversation history repeatedly exceeded
 * 100%+ of that ceiling despite active compaction — the compaction
 * mechanism's own 50%-of-maxTokens target (4000 tokens) left far too
 * little room for a real tool-heavy investigative task's system prompt +
 * tool schemas + search results.
 *
 * Fix: BaseAgent.initializeContext() re-derives `maxTokens` from the
 * ACTUALLY-resolved provider's own getCapabilities().maxContextLength
 * once routing is known (it isn't yet at construction time, before any
 * provider has been chosen) — but only for non-"local" providers; local
 * models genuinely are constrained by this machine's real capacity.
 * Output generation length (`outputMaxTokens`, sent as the provider's
 * `max_tokens`) is a separate, fixed, sensible default — a 128K-context
 * cloud model doesn't need a proportionally huge output reservation for
 * an ordinary turn.
 */
import { describe, it, expect, afterEach } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

describe("BaseAgent — context-budget vs output-length split", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("keeps the system-load-derived maxTokens for a LOCAL provider (unchanged)", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const agent = new UniversalAgent("code") as unknown as {
      config: { maxTokens: number; outputMaxTokens?: number };
    };
    const originalMaxTokens = agent.config.maxTokens;

    await (agent as unknown as UniversalAgent).execute({
      id: "t1",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Local provider — no override should have happened.
    expect(agent.config.maxTokens).toBe(originalMaxTokens);
  });

  it("re-derives maxTokens from the resolved provider's real context window for a CLOUD provider", async () => {
    env = setupFakeAgentEnv(
      [scriptedResult("Done.")],
      [scriptedResult("Done.")],
    );
    // Force routing to the seeded "groq" fallback provider by making
    // "local" unavailable — same reflection pattern the harness itself
    // uses internally to seed provider availability.
    (
      ProviderFactory.getInstance() as unknown as {
        availability: Map<string, boolean>;
      }
    ).availability.set("local", false);

    const agent = new UniversalAgent("code") as unknown as {
      config: { maxTokens: number; outputMaxTokens?: number };
    };

    await (agent as unknown as UniversalAgent).execute({
      id: "t2",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // FakeProvider reports maxContextLength: 128000 — half of that,
    // capped at 32000, is exactly 32000.
    expect(agent.config.maxTokens).toBe(32000);
  });

  it("sends outputMaxTokens (not the context budget) as the provider's generation length", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);
    const agent = new UniversalAgent("code");

    await agent.execute({
      id: "t3",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sentOptions = env.provider.callOptions[0];
    expect(sentOptions?.maxTokens).toBe(4096);
  });
});
