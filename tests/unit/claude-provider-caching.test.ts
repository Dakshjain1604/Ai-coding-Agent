/**
 * Verifies ClaudeProvider actually attaches Anthropic prompt-caching
 * breakpoints (cache_control) — previously no provider did this at all
 * (confirmed via `grep cache_control` across src/providers/* returning
 * nothing). Only exercises the pure message-building methods; never
 * touches the network (constructing a ClaudeProvider doesn't call the API).
 */
import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../../src/providers/ClaudeProvider.js";

function makeProvider(): ClaudeProvider {
  return new ClaudeProvider({ apiKey: "test-key-not-real" });
}

describe("ClaudeProvider prompt caching", () => {
  it("marks the system prompt as cacheable", () => {
    const provider = makeProvider() as unknown as {
      buildSystemParam: (text?: string) => unknown;
    };
    const result = provider.buildSystemParam("You are a coding agent.");
    expect(Array.isArray(result)).toBe(true);
    const block = (result as Array<Record<string, unknown>>)[0];
    expect(block.text).toBe("You are a coding agent.");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns undefined for an empty/missing system prompt", () => {
    const provider = makeProvider() as unknown as {
      buildSystemParam: (text?: string) => unknown;
    };
    expect(provider.buildSystemParam(undefined)).toBeUndefined();
  });

  it("marks only the last message with a cache breakpoint, not earlier ones", () => {
    const provider = makeProvider() as unknown as {
      convertMessages: (
        messages: Array<{ role: string; content: string }>,
        options?: { cacheLastMessage?: boolean },
      ) => Array<{ content: unknown }>;
    };

    const converted = provider.convertMessages(
      [
        { role: "user", content: "first turn" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second turn" },
      ],
      { cacheLastMessage: true },
    );

    // First two messages: plain string content, no cache_control at all.
    expect(converted[0].content).toBe("first turn");
    expect(converted[1].content).toBe("reply");

    // Last message: converted to block form with a cache breakpoint.
    expect(Array.isArray(converted[2].content)).toBe(true);
    const lastBlock = (converted[2].content as Array<Record<string, unknown>>)[0];
    expect(lastBlock.text).toBe("second turn");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mark anything cacheable when cacheLastMessage is not set", () => {
    const provider = makeProvider() as unknown as {
      convertMessages: (
        messages: Array<{ role: string; content: string }>,
        options?: { cacheLastMessage?: boolean },
      ) => Array<{ content: unknown }>;
    };

    const converted = provider.convertMessages([
      { role: "user", content: "only turn" },
    ]);
    expect(converted[0].content).toBe("only turn");
  });

  it("marks the last block (not the first) when the last message has multiple content blocks", () => {
    const provider = makeProvider() as unknown as {
      convertMessages: (
        messages: Array<{
          role: string;
          content: Array<{ type: string; text?: string }>;
        }>,
        options?: { cacheLastMessage?: boolean },
      ) => Array<{ content: unknown }>;
    };

    const converted = provider.convertMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      ],
      { cacheLastMessage: true },
    );

    const blocks = converted[0].content as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
