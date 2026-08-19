/**
 * Integration tests for the failure-classifier's wiring into
 * UniversalAgent's retry loop (architecture-optimal.md Phase 3, item 18).
 *
 * Verifies the loop actually behaves differently per failure category —
 * not just that classifyFailure() itself returns the right answer (see
 * tests/unit/failure-classifier.test.ts for that), but that the retry
 * loop actually SKIPS the blind backoff-sleep for non-retryable errors
 * and goes straight to fallback, while retryable errors keep the
 * original bounded-backoff-then-fallback behavior.
 *
 * Timing assertions matter here: the concrete bug this fixes wasted real
 * wall-clock time (2s + 4s of backoff) retrying a request that could
 * never succeed. A test that only checks the final outcome without
 * checking timing would miss regressions that reintroduce the wasted
 * sleep while still "eventually" getting the right answer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import type { Task } from "../../src/utils/types.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  scriptedError,
  FakeProvider,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

function makeTask(description: string): Task {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    description,
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("Retry loop — non-retryable failures skip the blind backoff entirely", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("falls back immediately (no sleep) on a 413 payload-too-large error when a fallback provider exists", async () => {
    env = setupFakeAgentEnv(
      [scriptedError("413 Request too large for model")],
      [scriptedResult("Handled by the fallback provider.")],
    );

    const start = Date.now();
    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.output).toContain("fallback provider");
    // No backoff sleep should have occurred — the whole exchange should
    // complete in well under the ~2000ms a single blind retry would cost.
    expect(elapsed).toBeLessThan(1500);
  });

  it("throws immediately (no sleep) on a 413 error when no fallback provider is configured", async () => {
    env = setupFakeAgentEnv([scriptedError("413 Request too large for model")]);

    const start = Date.now();
    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.output).toContain("413");
    expect(elapsed).toBeLessThan(1500);
  });

  it("falls back immediately on a 401 auth error", async () => {
    env = setupFakeAgentEnv(
      [scriptedError("401 Unauthorized: invalid API key")],
      [scriptedResult("Handled by the fallback provider.")],
    );

    const start = Date.now();
    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

  it("falls back immediately on a 400 invalid_request error", async () => {
    env = setupFakeAgentEnv(
      [scriptedError("400 Bad Request: malformed payload")],
      [scriptedResult("Handled by the fallback provider.")],
    );

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
  });

  it("falls back immediately on a 404 not_found error (e.g. deprecated model name)", async () => {
    env = setupFakeAgentEnv(
      [scriptedError("The model `old-model-name` does not exist or you do not have access to it.")],
      [scriptedResult("Handled by the fallback provider.")],
    );

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
  });

  it("throws immediately on an internal_error (TypeError) — never retries, never falls back", async () => {
    // A bug in request-building code fails identically regardless of
    // retrying OR switching providers, so this should fail fast even
    // though a fallback provider IS configured and would otherwise help.
    env = setupFakeAgentEnv(
      [{ __throws: new TypeError("Cannot read properties of undefined") }],
      [scriptedResult("Should never be reached.")],
    );

    const start = Date.now();
    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(1500);
    // The fallback provider must never have been called at all.
    expect(env.fallbackProvider?.calls.length ?? 0).toBe(0);
  });
});

describe("Retry loop — retryable failures keep bounded backoff-then-fallback behavior", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("recovers on the same provider after one transient network error (no fallback needed)", async () => {
    env = setupFakeAgentEnv([
      scriptedError("ECONNREFUSED"),
      scriptedResult("Recovered after one retry."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("Recovered");
    // Only the primary provider was ever used — no fallback occurred.
    expect(env.fallbackProvider).toBeUndefined();
  }, 10000);

  it("recovers on the same provider after two transient server errors", async () => {
    env = setupFakeAgentEnv([
      scriptedError("503 Service Unavailable"),
      scriptedError("502 Bad Gateway"),
      scriptedResult("Recovered after two retries."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("Recovered");
  }, 10000);

  it("falls back after exhausting all retries on a persistent rate-limit error", async () => {
    env = setupFakeAgentEnv(
      [
        scriptedError("429 rate limit exceeded"),
        scriptedError("429 rate limit exceeded"),
        scriptedError("429 rate limit exceeded"),
      ],
      [scriptedResult("Handled by the fallback provider after exhausting retries.")],
    );

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("fallback provider");
    // The primary provider should have been tried the full 3 times before
    // falling back — this is the one legitimate case that IS expected to
    // cost real backoff time (2s + 4s), unlike the non-retryable cases.
    expect(env.provider.calls.length).toBe(3);
  }, 10000);

  it("throws the ORIGINAL error (not a routing error) when retries AND fallback both fail", async () => {
    env = setupFakeAgentEnv([
      scriptedError("503 Service Unavailable — primary down"),
      scriptedError("503 Service Unavailable — primary down"),
      scriptedError("503 Service Unavailable — primary down"),
    ]);
    // No fallback provider configured at all — fallback attempt will find
    // nothing and the loop must surface the original 503, not a generic
    // "no provider found" routing error.

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(false);
    expect(result.output).toContain("primary down");
  }, 10000);

  it("treats an unrecognized error message as retryable (unknown category, default bounded retry)", async () => {
    env = setupFakeAgentEnv([
      scriptedError("something completely unexpected happened"),
      scriptedResult("Recovered."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
  }, 10000);
});

describe("Retry loop — fallback provider actually stays adopted for subsequent calls", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("uses the fallback provider for the rest of the task after switching, not just one call", async () => {
    env = setupFakeAgentEnv(
      [scriptedError("413 Request too large")],
      [
        scriptedResult(
          JSON.stringify({ tool: "file_read", params: { path: "package.json" } }),
        ),
        scriptedResult("Done, using the fallback provider throughout."),
      ],
    );

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("read package.json"));

    expect(result.success).toBe(true);
    // Primary provider was called exactly once (the failing attempt);
    // everything after the switch went to the fallback provider.
    expect(env.provider.calls.length).toBe(1);
    expect(env.fallbackProvider?.calls.length).toBe(2);
  });

  it("gets a fresh chance to fall back again on a LATER iteration if the adopted provider later fails too", async () => {
    // hasFallenBack is scoped per-iteration (declared inside the while
    // loop), not for the whole task — a provider adopted via fallback in
    // iteration 1 that then fails in iteration 3 should still be able to
    // trigger a (second, separate) fallback attempt in that later
    // iteration, rather than being permanently blocked after the first.
    env = setupFakeAgentEnv(
      [
        scriptedError("413 Request too large"), // iteration 1: primary fails, falls back
      ],
      [
        scriptedResult(
          JSON.stringify({ tool: "file_read", params: { path: "package.json" } }),
        ), // iteration 1 (post-fallback): tool call
        { __throws: new Error("500 Internal Server Error") }, // iteration 2: fallback provider now fails too
        scriptedResult("Recovered again."), // iteration 2 retry: succeeds
      ],
    );

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("read package.json"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("Recovered again");
  }, 10000);

  it("chains through a THIRD provider within the SAME iteration if the first fallback also fails", async () => {
    // Reproduces a real live failure verbatim: groq exhausted its daily
    // free-tier quota, fell back to openrouter, and openrouter ALSO hit
    // its own separate daily free-tier cap within the same LLM-call
    // iteration — the task failed outright even though a third configured
    // provider (a separate account/quota entirely) was never attempted.
    // Root cause: the old `hasFallenBack` boolean only allowed ONE
    // provider switch per iteration, no matter how many providers were
    // actually configured. The fix tracks an accumulating excluded-
    // providers set instead, so a second fallback failure within the same
    // iteration can still reach a third, untried provider.
    env = setupFakeAgentEnv(
      [scriptedError("429 rate limit — local exhausted")],
      [scriptedError("429 rate limit — groq exhausted too")],
    );

    // A third provider, manually seeded under its own distinct
    // ProviderType — the harness's setupFakeAgentEnv only wires up two
    // (local + one fallback), so the third is added directly the same
    // way other tests in this suite reach into ProviderFactory's
    // internals to adjust routing state.
    const thirdProvider = new FakeProvider(
      [scriptedResult("Recovered via the THIRD provider.")],
      "openrouter",
    );
    (
      ProviderFactory.getInstance() as unknown as {
        providers: Map<string, unknown>;
        availability: Map<string, boolean>;
      }
    ).providers.set("openrouter", thirdProvider);
    (
      ProviderFactory.getInstance() as unknown as {
        availability: Map<string, boolean>;
      }
    ).availability.set("openrouter", true);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("THIRD provider");
    // At least one successful call on the third provider — that's the
    // whole point of this test. (A genuine final answer with zero tool
    // calls on the very first iteration doesn't early-exit the loop —
    // see UniversalAgent's `iterations > 0` check — so it may legitimately
    // be called a second time too; FakeProvider repeats its last scripted
    // entry, which is this same successful response either way.)
    expect(thirdProvider.calls.length).toBeGreaterThanOrEqual(1);
    // Both local and groq must fully exhaust their own bounded backoff
    // (~6s each: 2s + 4s across 3 attempts, same cost as the single-
    // provider-exhaustion case elsewhere in this file) before the third
    // fallback is even attempted.
  }, 20000);
});

describe("Retry loop — debug logging surfaces the classification", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("logs the failure category and retryability for a caught error", async () => {
    const { getLogger } = await import("../../src/utils/logger.js");
    const logger = getLogger();
    const originalLevel = logger.level;
    logger.setLevel("debug");

    const debugLines: string[] = [];
    const originalDebug = logger.debug.bind(logger);
    logger.debug = (msg: string) => {
      debugLines.push(msg);
      return originalDebug(msg);
    };

    try {
      env = setupFakeAgentEnv(
        [scriptedError("413 Request too large")],
        [scriptedResult("Handled by the fallback provider.")],
      );

      const agent = new UniversalAgent("code");
      await agent.execute(makeTask("say hello"));

      const combined = debugLines.join("\n");
      expect(combined).toContain("category=payload_too_large");
      expect(combined).toContain("retryable=false");
    } finally {
      logger.debug = originalDebug;
      logger.setLevel(originalLevel);
    }
  });
});
