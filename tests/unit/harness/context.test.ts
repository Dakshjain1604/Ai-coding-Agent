import { describe, expect, it } from "vitest";
import { compact, estimateTokens, needsCompaction, outputTokenBudget, tailStartIndex } from "../../../src/harness/context.js";
import type { ChatModel, Message } from "../../../src/harness/types.js";

const sys: Message = { role: "system", content: "S" };
const task: Message = { role: "user", content: "T" };
const assistantCall = (id: string, size = 0): Message => ({
  role: "assistant",
  content: "a".repeat(size),
  toolCalls: [{ id, name: "bash", arguments: "{}" }],
});
const toolResult = (id: string, size = 0): Message => ({ role: "tool", toolCallId: id, name: "bash", content: "r".repeat(size) });

function modelReturning(content: string | Error, seen: { maxOutputTokens?: number } = {}): ChatModel {
  return {
    id: "fake",
    limits: async () => ({ contextWindow: 1000, maxOutputTokens: 100 }),
    complete: async (_messages, _tools, options) => {
      seen.maxOutputTokens = options.maxOutputTokens;
      if (content instanceof Error) throw content;
      return {
        message: { role: "assistant", content, toolCalls: [] },
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        servedBy: "fake",
        latencyMs: 0,
        firstChunkMs: 0,
        attempts: 1,
      };
    },
  };
}

describe("estimateTokens", () => {
  it("counts content and tool-call arguments", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(35) }])).toBe(10);
    expect(estimateTokens([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "bash", arguments: "y".repeat(31) }] }])).toBe(10);
  });
});

describe("needsCompaction", () => {
  const budget = { contextWindow: 100_000, maxOutputTokens: 10_000 };
  it("triggers when prompt plus output room exceeds 80% of the window", () => {
    expect(needsCompaction(69_000, budget)).toBe(false);
    expect(needsCompaction(71_000, budget)).toBe(true);
  });
});

describe("tailStartIndex", () => {
  const budget = { contextWindow: 1_000, maxOutputTokens: 100 }; // tail budget: 300 tokens ≈ 1050 chars

  it("never starts the tail on a tool result", () => {
    const messages = [sys, task, assistantCall("1", 3000), toolResult("1", 3000), assistantCall("2", 10), toolResult("2", 900)];
    const start = tailStartIndex(messages, budget, 2)!;
    expect(messages[start].role).not.toBe("tool");
    expect(start).toBe(4);
  });

  it("keeps the latest complete turn even when it alone exceeds the tail budget", () => {
    const messages = [sys, task, assistantCall("1", 10), toolResult("1", 10), assistantCall("2", 10), toolResult("2", 50_000)];
    expect(tailStartIndex(messages, budget, 2)).toBe(4);
  });

  it("returns undefined when there is nothing between head and tail", () => {
    expect(tailStartIndex([sys, task, assistantCall("1", 10), toolResult("1", 10)], budget, 2)).toBeUndefined();
  });
});

describe("compact", () => {
  const budget = { contextWindow: 1_000, maxOutputTokens: 100 };
  const history = [sys, task, assistantCall("1", 3000), toolResult("1", 3000), assistantCall("2", 10), toolResult("2", 10)];

  it("replaces the middle with the model's notes, keeping head and tail verbatim", async () => {
    const result = (await compact(history, modelReturning("## Done so far\nstuff"), budget, Date.now() + 60_000))!;
    expect(result.outcome).toBe("summarized");
    expect(result.removedMessages).toBe(2);
    expect(result.messages[0]).toBe(sys);
    expect(result.messages[1]).toBe(task);
    expect(result.messages[2]).toMatchObject({ role: "user", content: expect.stringContaining("## Done so far") });
    expect(result.messages.slice(3)).toEqual(history.slice(4));
  });

  it("still frees context when summarization fails, with an explicit note", async () => {
    const result = (await compact(history, modelReturning(new Error("boom")), budget, Date.now() + 60_000))!;
    expect(result.outcome).toBe("summary_failed_dropped");
    expect(result.messages[2].content).toContain("could not be produced");
    expect(result.messages).toHaveLength(5); // head (2) + note + tail (2)
  });

  it("treats an empty summary as a failure", async () => {
    const result = (await compact(history, modelReturning("   "), budget, Date.now() + 60_000))!;
    expect(result.outcome).toBe("summary_failed_dropped");
  });

  it("refuses when the removable history is too small to free meaningful space", async () => {
    const smallMiddle = [sys, task, assistantCall("1", 10), toolResult("1", 10), assistantCall("2", 10), toolResult("2", 50_000)];
    expect(await compact(smallMiddle, modelReturning("x"), budget, Date.now() + 60_000)).toBeUndefined();
  });

  it("returns undefined when there is nothing to compact", async () => {
    expect(await compact([sys, task], modelReturning("x"), budget, Date.now() + 60_000)).toBeUndefined();
  });
});

describe("outputTokenBudget", () => {
  it("keeps the requested cap when the window is large", () => {
    expect(outputTokenBudget(1_000_000, 16_384)).toBe(16_384);
  });

  it("limits the reservation to a quarter of a small window", () => {
    expect(outputTokenBudget(32_000, 16_384)).toBe(8_000);
  });

  it("never goes below 256", () => {
    expect(outputTokenBudget(500, 16_384)).toBe(256);
  });
});

describe("compaction on small windows (no thrashing)", () => {
  it("sizes the summary request to the window", async () => {
    const seen: { maxOutputTokens?: number } = {};
    const budget = { contextWindow: 8_000, maxOutputTokens: outputTokenBudget(8_000, 16_384) };
    const history = [sys, task, assistantCall("1", 20_000), toolResult("1", 20_000), assistantCall("2", 10), toolResult("2", 10)];
    await compact(history, modelReturning("notes", seen), budget, Date.now() + 60_000);
    expect(seen.maxOutputTokens).toBe(800);
  });

  it("truncates a summary that ignores its token budget", async () => {
    const budget = { contextWindow: 8_000, maxOutputTokens: 2_000 };
    const history = [sys, task, assistantCall("1", 20_000), toolResult("1", 20_000), assistantCall("2", 10), toolResult("2", 10)];
    const result = (await compact(history, modelReturning("z".repeat(50_000)), budget, Date.now() + 60_000))!;
    expect(result.messages[2].content).toContain("[summary truncated]");
    expect(estimateTokens([result.messages[2]])).toBeLessThanOrEqual(850);
  });

  it.each([8_000, 32_000, 128_000, 1_000_000])("a compacted transcript fits below the trigger (window %i)", async (contextWindow) => {
    const budget = { contextWindow, maxOutputTokens: outputTokenBudget(contextWindow, 16_384) };
    const turnChars = Math.floor(contextWindow * 0.15 * 3.5); // each turn ~15% of the window
    const history: Message[] = [sys, task];
    for (let i = 0; i < 8; i++) history.push(assistantCall(String(i), turnChars / 2), toolResult(String(i), turnChars / 2));
    const result = (await compact(history, modelReturning("n".repeat(1_000_000)), budget, Date.now() + 60_000))!;
    expect(needsCompaction(estimateTokens(result.messages), budget)).toBe(false);
  });
});
