/**
 * Compactor is genuinely new functionality — no LLM-based summarization
 * existed anywhere in this codebase before (confirmed during the Wiring
 * Audit: both prior "compaction" paths were pure heuristic truncation).
 * These tests cover the cache-preserving request shape, response
 * validation, and graceful-failure behavior.
 */
import { describe, it, expect } from "vitest";
import {
  buildCompactionRequest,
  parseCompactionResponse,
  compactMessages,
  renderSummaryMessage,
} from "../../src/core/agents/Compactor.js";
import type {
  ChatMessage,
  BaseProvider,
  CompletionResult,
} from "../../src/providers/ProviderInterface.js";

function fakeProvider(
  respond: (messages: ChatMessage[]) => CompletionResult | Promise<CompletionResult>,
): BaseProvider {
  return {
    complete: async (messages: ChatMessage[]) => respond(messages),
  } as unknown as BaseProvider;
}

const VALID_SUMMARY = `## Objective
Implement OAuth login

## Important Details
Uses PKCE

## Work State
- Completed: provider integration
- Active: callback handling
- Blocked: none

## Next Move
Add refresh token rotation

## Relevant Files
src/auth/oauth.ts`;

describe("buildCompactionRequest", () => {
  it("replays system + old messages verbatim and appends the instruction last", () => {
    const system: ChatMessage[] = [{ role: "system", content: "You are an agent." }];
    const old: ChatMessage[] = [
      { role: "user", content: "do thing A" },
      { role: "assistant", content: "did thing A" },
    ];

    const request = buildCompactionRequest(system, old);

    expect(request[0]).toEqual(system[0]);
    expect(request[1]).toEqual(old[0]);
    expect(request[2]).toEqual(old[1]);
    expect(request[3].role).toBe("user");
    expect(request[3].content).toContain("Summarize the conversation above");
    expect(request.length).toBe(4);
  });

  it("does not mutate or reorder the messages being compacted", () => {
    const old: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];
    const request = buildCompactionRequest([], old);
    expect(request.slice(0, 3).map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("instructs the model to merge with an existing summary when one is provided", () => {
    const request = buildCompactionRequest([], [{ role: "user", content: "x" }], "OLD SUMMARY TEXT");
    const instruction = request[request.length - 1].content as string;
    expect(instruction).toContain("existing summary");
    expect(instruction).toContain("OLD SUMMARY TEXT");
    expect(instruction).toContain("more recent and wins");
  });
});

describe("parseCompactionResponse", () => {
  it("accepts a well-formed template response", () => {
    expect(parseCompactionResponse(VALID_SUMMARY)).toBe(VALID_SUMMARY);
  });

  it("rejects an empty response", () => {
    expect(parseCompactionResponse("   ")).toBeNull();
  });

  it("rejects a response missing the Objective section", () => {
    expect(parseCompactionResponse("I refuse to summarize this.")).toBeNull();
  });
});

describe("compactMessages", () => {
  const systemMessages: ChatMessage[] = [{ role: "system", content: "sys" }];
  const toCompact: ChatMessage[] = [{ role: "user", content: "old content" }];

  it("returns the parsed summary on a well-formed response", async () => {
    const provider = fakeProvider(() => ({
      content: VALID_SUMMARY,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      model: "test-model",
      finishReason: "stop",
    }));

    const result = await compactMessages(toCompact, {
      provider,
      model: "test-model",
      systemMessages,
    });

    expect(result?.summary).toBe(VALID_SUMMARY);
  });

  it("returns null (never throws) when the provider call rejects", async () => {
    const provider = fakeProvider(() => {
      throw new Error("provider unavailable");
    });

    const result = await compactMessages(toCompact, {
      provider,
      model: "test-model",
      systemMessages,
    });

    expect(result).toBeNull();
  });

  it("returns null when the response doesn't match the expected template", async () => {
    const provider = fakeProvider(() => ({
      content: "Sorry, I can't do that.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
    }));

    const result = await compactMessages(toCompact, {
      provider,
      model: "test-model",
      systemMessages,
    });

    expect(result).toBeNull();
  });

  it("returns null when the call exceeds timeoutMs", async () => {
    const provider = fakeProvider(
      () =>
        new Promise<CompletionResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: VALID_SUMMARY,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                model: "test-model",
                finishReason: "stop",
              }),
            200,
          ),
        ),
    );

    const start = Date.now();
    const result = await compactMessages(toCompact, {
      provider,
      model: "test-model",
      systemMessages,
      timeoutMs: 20,
    });

    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(150);
  });

  it("returns null immediately for an empty message list, without calling the provider", async () => {
    let called = false;
    const provider = fakeProvider(() => {
      called = true;
      return {
        content: VALID_SUMMARY,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    });

    const result = await compactMessages([], {
      provider,
      model: "test-model",
      systemMessages,
    });

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("renderSummaryMessage", () => {
  it("wraps the summary as a labeled system message", () => {
    const msg = renderSummaryMessage(VALID_SUMMARY);
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("Conversation Summary");
    expect(msg.content).toContain(VALID_SUMMARY);
  });
});
