/**
 * Regression coverage for a real, live-confirmed bug: UniversalAgent's
 * main loop treated ANY response with zero parsed tool calls as "the model
 * is done" (see the `toolCallsInOutput.length === 0 && iterations > 0`
 * early-exit in UniversalAgent.execute()), with no way to distinguish a
 * genuine final answer from a tool-call attempt whose JSON body was
 * malformed or truncated mid-generation.
 *
 * Confirmed live on a real SWE-bench task: a free-tier OpenRouter model's
 * response was cut off mid-generation inside a ```tool\nfile_write\n{...}
 * block — the JSON's "content" string value (and the outer object) never
 * closed. parseToolCalls() correctly returned zero calls for it (nothing
 * safe to guess at — see parseFencedToolCallNoClosingFence's comment), but
 * the loop silently treated that as "no more actions needed" and finished
 * the task WITHOUT ever writing the fix, with no error, no retry, and no
 * indication in the final answer that anything had gone wrong.
 *
 * The fix: UniversalAgent now checks hasIncompleteToolCallAttempt() before
 * falling into that early-exit path, and if the response clearly named a
 * real tool inside a ```tool fence, nudges the model to retry instead of
 * ending the task — using the same bounded blankResponseRetries budget the
 * existing empty-response handling already uses, so a persistently broken
 * model still fails loudly rather than looping forever.
 */
import { describe, it, expect, afterEach } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

describe("UniversalAgent — incomplete tool-call attempt retry", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("nudges and retries instead of silently finishing when a ```tool fence names a real tool but its JSON is truncated", async () => {
    const truncated = scriptedResult(
      '```tool\nfile_write\n{\n  "path": "a.py",\n  "content": "some content that never closes',
    );
    const recovered = scriptedResult("Done — fix applied.");

    env = setupFakeAgentEnv([truncated, recovered]);
    const agent = new UniversalAgent("code");

    const result = await agent.execute({
      id: "t1",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The task must succeed via the SECOND (recovered) response, not
    // silently "complete" on the first, truncated one.
    expect(result.success).toBe(true);
    expect(result.output).toBe("Done — fix applied.");
    expect(env.provider.calls.length).toBe(2);

    // The retry nudge must actually reach the model as a real message —
    // otherwise the model has no way to know its previous attempt failed.
    const secondCallMessages = env.provider.calls[1];
    const nudge = secondCallMessages.find((m) =>
      m.content.includes("malformed or incomplete"),
    );
    expect(nudge).toBeDefined();
  });

  it("fails honestly (not silently success:true) after exhausting retries if every attempt is incomplete", async () => {
    // execute() catches the thrown error at its top level and surfaces it
    // as a failed TaskResult rather than letting it escape as a rejected
    // promise (see UniversalAgent.execute()'s outer catch) — the important
    // assertion is that this is NOT reported as success:true with the
    // truncated attempt silently discarded, which is the exact failure
    // mode this fix exists to close.
    const truncated = scriptedResult(
      '```tool\nfile_write\n{\n  "path": "a.py", "content": "cut off',
    );
    env = setupFakeAgentEnv([truncated]);
    const agent = new UniversalAgent("code");

    const result = await agent.execute({
      id: "t2",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/could not be parsed/);
  });

  it("does NOT nudge-retry a genuine final answer that happens to contain an unrelated fenced code block", async () => {
    const finalAnswer = scriptedResult(
      'Here is the fix:\n```python\ndef foo():\n    return 1\n```\nThat resolves the issue.',
    );
    env = setupFakeAgentEnv([finalAnswer]);
    const agent = new UniversalAgent("code");

    const result = await agent.execute({
      id: "t3",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(true);
    // None of the calls should ever have received the
    // incomplete-tool-call nudge — a plain fenced code block in a real
    // final answer must never be mistaken for a failed tool-call attempt.
    const anyNudged = env.provider.calls.some((msgs) =>
      msgs.some((m) => m.content.includes("malformed or incomplete")),
    );
    expect(anyNudged).toBe(false);
  });
});

describe("UniversalAgent — blank-response retry budget counts CONSECUTIVE failures, not a lifetime total", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("does not fail after only 2 blanks total when a successful tool call happened in between (real bug: budget never reset on progress)", async () => {
    // Reproduces a real live failure verbatim: blank -> successful
    // file_read tool call -> blank -> blank -> the task incorrectly threw
    // "3 consecutive empty responses" even though only 2 of those 3
    // blanks were actually consecutive (a real, productive tool call sat
    // between the first blank and the other two). With MAX_BLANK_RESPONSE_
    // RETRIES=2, the buggy (never-reset) counter would throw on the THIRD
    // blank overall (the 4th scripted call here); the fix must survive
    // that and only throw once 3 blanks occur back-to-back with no
    // progress in between (the 7th scripted call below).
    const blank = scriptedResult("");
    // Native toolCalls aren't carried through FakeProvider.stream() (the
    // harness only forwards `content` chunk-by-chunk, matching real
    // streaming providers whose SDKs attach tool calls only once fully
    // accumulated) — express "made real progress" via the same text-based
    // ```tool fallback format the real live failure this test reproduces
    // actually used.
    const productive = scriptedResult(
      '```tool\nsearch_files\n{"pattern": "*.py"}\n```',
    );

    // Routed to the "groq" fallback (128000-token capabilities, so the
    // context-budget fix gives it a real 32000-token ceiling) rather than
    // "local" (whose default budget is small enough that this sequence's
    // extra tool-result turns can trigger context compaction — itself a
    // real LLM call, which would add non-deterministic noise to the exact
    // call count this test asserts on and has nothing to do with what's
    // being tested here).
    env = setupFakeAgentEnv(
      [scriptedResult("unused — local is forced unavailable below")],
      [
        blank, // 1: blank (retry 1/2)
        productive, // 2: real progress -> resets budget to 0
        blank, // 3: blank (retry 1/2 again, post-reset)
        blank, // 4: blank (retry 2/2) — this is where the pre-fix bug threw
        productive, // 5: real progress -> resets budget to 0 again
        blank, // 6: blank (retry 1/2)
        blank, // 7: blank (retry 2/2)
        blank, // 8: blank (3rd CONSECUTIVE since last progress) -> throws
      ],
    );
    (
      ProviderFactory.getInstance() as unknown as {
        availability: Map<string, boolean>;
      }
    ).availability.set("local", false);

    const agent = new UniversalAgent("code");

    const result = await agent.execute({
      id: "t4",
      description: "do something",
      complexity: "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/3 consecutive empty responses/);
    // 8 LLM calls, not fewer — proves the two intervening productive
    // turns genuinely bought two full fresh retry budgets instead of the
    // failure firing early on the first unlucky streak of 2. Asserted on
    // the fallback provider, not `env.provider` (local) — local was
    // forced unavailable above, so all real traffic routed to fallback.
    expect(env.fallbackProvider?.calls.length).toBe(8);
  });
});
