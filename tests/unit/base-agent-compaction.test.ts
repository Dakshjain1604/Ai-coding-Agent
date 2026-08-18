/**
 * Integration test for BaseAgent.truncateMessages()'s incremental
 * compaction bookkeeping — the subtle part of this feature: a second
 * compaction must only send NEW-since-last-time messages to the
 * summarizer, merged with the existing summary, never re-sending content
 * that's already folded in (which would defeat the point of having a
 * running summary at all).
 */
import { describe, it, expect } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import type { ChatMessage, BaseProvider, CompletionResult } from "../../src/providers/ProviderInterface.js";

const VALID_SUMMARY = (n: number) => `## Objective
Task objective ${n}

## Important Details
none

## Work State
- Completed: step ${n}
- Active: none
- Blocked: none

## Next Move
continue

## Relevant Files
none`;

function fakeProvider(captured: ChatMessage[][]): BaseProvider {
  let callCount = 0;
  return {
    complete: async (messages: ChatMessage[]) => {
      captured.push(messages);
      callCount++;
      return {
        content: VALID_SUMMARY(callCount),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: "test-model",
        finishReason: "stop",
      } as CompletionResult;
    },
  } as unknown as BaseProvider;
}

function filler(label: string): ChatMessage {
  // ~75 tokens (300 chars) per message at the chars/4 heuristic.
  return { role: "user", content: `${label} ${"x".repeat(290)}` };
}

describe("BaseAgent.truncateMessages incremental compaction", () => {
  it("only sends new-since-last-compaction messages on a second compaction", async () => {
    const agent = new UniversalAgent("code");
    const captured: ChatMessage[][] = [];
    const provider = fakeProvider(captured);

    // Inject a minimal context without going through initializeContext()
    // (which would require a real provider route / network).
    (agent as unknown as { context: unknown }).context = {
      taskId: "t1",
      task: {
        id: "t1",
        description: "test",
        complexity: "simple",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      messages: [],
      toolResults: new Map(),
      memory: {},
      provider,
      model: "test-model",
    };

    const truncate = (
      agent as unknown as {
        truncateMessages: (
          messages: ChatMessage[],
          maxTokens: number,
        ) => Promise<ChatMessage[]>;
      }
    ).truncateMessages.bind(agent);

    const system: ChatMessage[] = [{ role: "system", content: "You are an agent." }];
    const firstUser: ChatMessage = { role: "user", content: "the original task" };

    // Enough filler to comfortably cross the 70% trigger with maxTokens=1000
    // (effectiveLimit=700 tokens; each filler message is ~75 tokens, so 20
    // of them is ~1500 tokens) while leaving several messages outside the
    // recent window (conversationBudget=400 tokens, ~5 messages).
    const batch1 = Array.from({ length: 20 }, (_, i) => filler(`batch1-${i}`));

    const round1 = await truncate([...system, firstUser, ...batch1], 1000);

    expect(captured.length).toBe(1);
    // First compaction call should include some of batch1's raw content.
    const firstCallContents = captured[0].map((m) => m.content).join("\n");
    expect(firstCallContents).toContain("batch1-0");

    // Result should carry the rendered summary, not raw batch1 messages
    // that got folded in.
    const summaryMsg = round1.find(
      (m) => m.role === "system" && m.content.includes("Conversation Summary"),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain("Task objective 1");

    // Second round: append more filler, forcing a second compaction.
    const batch2 = Array.from({ length: 20 }, (_, i) => filler(`batch2-${i}`));
    const round2 = await truncate(
      [...system, firstUser, ...batch1, ...batch2],
      1000,
    );

    expect(captured.length).toBe(2);
    const secondCallContents = captured[1].map((m) => m.content).join("\n");

    // The second compaction call must NOT re-send batch1's raw content —
    // only the merge instruction (which references the existing summary
    // text, not the original messages) plus whatever's newly aged out.
    expect(secondCallContents).not.toContain("batch1-0");
    expect(secondCallContents).toContain("Task objective 1"); // merged via existingSummary
    expect(captured[1][captured[1].length - 1].content).toContain(
      "existing summary",
    );

    const summaryMsg2 = round2.find(
      (m) => m.role === "system" && m.content.includes("Conversation Summary"),
    );
    expect(summaryMsg2?.content).toContain("Task objective 2");
  });

  it("returns messages unchanged when under the compaction threshold", async () => {
    const agent = new UniversalAgent("code");
    const truncate = (
      agent as unknown as {
        truncateMessages: (
          messages: ChatMessage[],
          maxTokens: number,
        ) => Promise<ChatMessage[]>;
      }
    ).truncateMessages.bind(agent);

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "short task" },
    ];

    const result = await truncate(messages, 100000);
    expect(result).toEqual(messages);
  });
});
