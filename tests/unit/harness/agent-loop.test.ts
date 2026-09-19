/**
 * Agent loop against a scripted model and a recording tool. Covers the
 * protocol invariants (every call answered, linked by id, nothing thrown
 * away) and every way a run can end.
 */
import { describe, expect, it } from "vitest";
import { runAgent, type AgentLoopOptions } from "../../../src/harness/agent-loop.js";
import { ToolExecutor, type Tool } from "../../../src/harness/tools/tool.js";
import type { TrajectoryEvent } from "../../../src/harness/trajectory.js";
import { ModelError, type AssistantMessage, type ChatModel, type CompleteOptions, type Message, type ModelTurn, type ToolSpec } from "../../../src/harness/types.js";

type Script = Array<Partial<ModelTurn> & { message: AssistantMessage } | Error>;

class ScriptedModel implements ChatModel {
  readonly id = "fake/model";
  readonly requests: Message[][] = [];
  readonly options: CompleteOptions[] = [];
  constructor(private readonly script: Script, private readonly contextWindow = 1_000_000) {}
  async limits() {
    return { contextWindow: this.contextWindow, maxOutputTokens: 8_000 };
  }
  async complete(messages: Message[], _tools: ToolSpec[], options: CompleteOptions): Promise<ModelTurn> {
    this.requests.push(structuredClone(messages));
    this.options.push(options);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return {
      finishReason: next.message.toolCalls.length ? "tool_calls" : "stop",
      usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0 },
      servedBy: "fake/model",
      latencyMs: 5,
      firstChunkMs: 1,
      attempts: 1,
      ...next,
    };
  }
}

const say = (content: string): { message: AssistantMessage } => ({ message: { role: "assistant", content, toolCalls: [] } });
const callTools = (...commands: string[]): { message: AssistantMessage } => ({
  message: {
    role: "assistant",
    content: "",
    toolCalls: commands.map((command, i) => ({ id: `id-${command}-${i}`, name: "echo", arguments: JSON.stringify({ text: command }) })),
  },
});

function setup(script: Script, overrides: Partial<AgentLoopOptions> = {}, contextWindow?: number) {
  const executed: string[] = [];
  const echo: Tool = {
    spec: { name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    run: async (args) => {
      executed.push(args.text as string);
      return { ok: true, output: `echo: ${args.text}` };
    },
  };
  const events: TrajectoryEvent[] = [];
  const model = new ScriptedModel(script, contextWindow);
  const options: AgentLoopOptions = {
    model,
    tools: new ToolExecutor([echo]),
    toolContext: { cwd: () => "/work", startedAt: Date.now(), deadline: Date.now() + 3_600_000, scratchDir: "/tmp" },
    systemPrompt: "SYSTEM",
    instruction: "TASK",
    maxTurns: 20,
    deadline: Date.now() + 3_600_000,
    maxOutputTokens: 4_000,
    trajectory: { record: (e) => events.push(e) },
    ...overrides,
  };
  return { model, options, events, executed };
}

describe("runAgent — completion", () => {
  it("completes when the model replies without tool calls", async () => {
    const { options, events } = setup([say("All done.")]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "completed", finalMessage: "All done.", turns: 1, toolCalls: 0 });
    expect(events.map((e) => e.type)).toEqual(["run_start", "model_request", "model_response", "run_end"]);
  });

  it("starts from the system prompt and instruction", async () => {
    const { options, model } = setup([say("ok")]);
    await runAgent(options);
    expect(model.requests[0]).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "TASK" },
    ]);
  });
});

describe("runAgent — transcript fidelity", () => {
  it("records the assistant's tool calls and answers each one, linked by id, in order", async () => {
    const { options, model, executed } = setup([callTools("a", "b"), say("done")]);
    const result = await runAgent(options);
    expect(executed).toEqual(["a", "b"]);
    expect(result.toolCalls).toBe(2);
    const second = model.requests[1];
    expect(second[2]).toMatchObject({ role: "assistant", toolCalls: [{ id: "id-a-0" }, { id: "id-b-1" }] });
    expect(second[3]).toMatchObject({ role: "tool", toolCallId: "id-a-0", name: "echo", content: expect.stringContaining("echo: a") });
    expect(second[4]).toMatchObject({ role: "tool", toolCallId: "id-b-1", name: "echo", content: expect.stringContaining("echo: b") });
    // Each observation carries the remaining time budget (see tool.ts timeFooter).
    expect(second[3].content).toMatch(/\[time: \d+m elapsed, ~\d+m left\]$/);
  });

  it("answers an invalid call with an error observation instead of stopping", async () => {
    const bad = { message: { role: "assistant" as const, content: "", toolCalls: [{ id: "x", name: "nope", arguments: "{}" }] } };
    const { options, model } = setup([bad, say("recovered")]);
    const result = await runAgent(options);
    expect(result.status).toBe("completed");
    expect(model.requests[1][3]).toMatchObject({ role: "tool", toolCallId: "x", content: expect.stringContaining('unknown tool "nope"') });
  });

  it("logs each tool result with arguments, output and duration", async () => {
    const { options, events } = setup([callTools("hello"), say("done")]);
    await runAgent(options);
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent).toMatchObject({ name: "echo", call_id: "id-hello-0", ok: true, arguments: '{"text":"hello"}' });
    expect(toolEvent!.output).toMatch(/^echo: hello\n\[time:/);
  });

  it("accumulates token usage and cost across turns", async () => {
    const { options } = setup([
      { ...callTools("a"), usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 10, costUsd: 0.01 } },
      { ...say("done"), usage: { promptTokens: 70, completionTokens: 7, cachedTokens: 20, costUsd: 0.02 } },
    ]);
    const result = await runAgent(options);
    expect(result.usage.promptTokens).toBe(120);
    expect(result.usage.completionTokens).toBe(12);
    expect(result.usage.cachedTokens).toBe(30);
    expect(result.usage.costUsd).toBeCloseTo(0.03);
  });
});

describe("runAgent — replies that are not answers", () => {
  it("asks the model to continue after output cut off by the length limit", async () => {
    const { options, model } = setup([{ ...say("partial..."), finishReason: "length" }, say("finished")]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "completed", finalMessage: "finished", turns: 2 });
    expect(model.requests[1].at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("cut off") });
  });

  it("asks the model to continue after an empty reply", async () => {
    const { options, model } = setup([say(""), say("real answer")]);
    const result = await runAgent(options);
    expect(result.status).toBe("completed");
    expect(model.requests[1].at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("empty") });
  });

  it("stops after three consecutive empty replies", async () => {
    const { options } = setup([say(""), say("  "), say("")]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "unproductive_turns", turns: 3 });
  });

  it("feeds a rejected generation back to the model, including what it produced, and continues", async () => {
    const rejected = new ModelError("Failed to parse tool call arguments as JSON", "invalid_model_output", 1, '{"text": "a"b"}');
    const { options, model, events } = setup([rejected, callTools("fixed"), say("done")]);
    const result = await runAgent(options);
    expect(result.status).toBe("completed");
    const feedback = model.requests[1].at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("rejected by the model provider: Failed to parse tool call arguments as JSON");
    expect(feedback.content).toContain('{"text": "a"b"}');
    expect(events.find((e) => e.type === "model_error")).toMatchObject({ category: "invalid_model_output", rejected_generation: '{"text": "a"b"}' });
  });

  it("counts rejected generations, empty replies and truncations toward one streak limit", async () => {
    const rejected = new ModelError("Failed to parse tool call arguments as JSON", "invalid_model_output", 1);
    const { options } = setup([rejected, say(""), { ...say("cut"), finishReason: "length" }]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "unproductive_turns", turns: 3 });
    expect(result.finalMessage).toContain("3 consecutive turns without usable output");
  });

  it("does not turn other model errors into feedback", async () => {
    const { options, model } = setup([new ModelError("401 Unauthorized", "auth", 1), say("never")]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "auth", turns: 1 });
    expect(model.requests).toHaveLength(1);
  });

  it("resets the empty-reply count after real progress", async () => {
    const { options } = setup([say(""), say(""), callTools("a"), say(""), say(""), say("done")]);
    expect((await runAgent(options)).status).toBe("completed");
  });
});

describe("runAgent — budgets and failures", () => {
  it("stops at max turns, after the last tool results were recorded", async () => {
    const { options, executed } = setup([callTools("a"), callTools("b"), callTools("c")], { maxTurns: 2 });
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "max_turns", turns: 2 });
    expect(executed).toEqual(["a", "b"]);
  });

  it("stops when the deadline (minus the reserve) has passed, before calling the model", async () => {
    const { options, model } = setup([say("never")], { deadline: Date.now() + 5_000 });
    const result = await runAgent(options);
    expect(result.status).toBe("timeout");
    expect(model.requests).toHaveLength(0);
  });

  it("passes the deadline minus the reserve to the model client", async () => {
    const deadline = Date.now() + 600_000;
    const { options, model } = setup([say("ok")], { deadline });
    await runAgent(options);
    expect(model.options[0].deadline).toBe(deadline - 15_000);
  });

  it("caps output tokens at the model's own limit", async () => {
    const { options, model } = setup([say("ok")], { maxOutputTokens: 100_000 });
    await runAgent(options);
    expect(model.options[0].maxOutputTokens).toBe(8_000);
  });

  it("never reserves more than a quarter of a small context window for output", async () => {
    const { options, model } = setup([say("ok")], { maxOutputTokens: 100_000 }, 16_000);
    await runAgent(options);
    expect(model.options[0].maxOutputTokens).toBe(4_000);
  });

  it("ends with model_error and the category when the model call fails", async () => {
    const { options, events } = setup([new ModelError("quota gone", "quota_exhausted", 1)]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "quota_exhausted" });
    expect(events.find((e) => e.type === "model_error")).toMatchObject({ category: "quota_exhausted" });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "model_error" });
  });
});

describe("runAgent — context compaction", () => {
  it("compacts when the next request would overflow the window, keeping call/result pairs intact", async () => {
    const big = "x".repeat(12_000);
    const bigTurn = (id: string) => ({
      message: { role: "assistant" as const, content: big, toolCalls: [{ id, name: "echo", arguments: JSON.stringify({ text: id }) }] },
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    });
    // Window 20k tokens with 5k (its 25% cap) reserved for output: the trigger is
    // 16k, so the ~13.7k-token history after four big turns overflows on the 5th request.
    const { options, model, events } = setup(
      [bigTurn("t1"), bigTurn("t2"), bigTurn("t3"), bigTurn("t4"), say("SUMMARY NOTES"), say("done")],
      { maxOutputTokens: 8_000 },
      20_000,
    );
    const result = await runAgent(options);
    expect(result.status).toBe("completed");

    const compaction = events.find((e) => e.type === "compaction");
    expect(compaction).toMatchObject({ outcome: "summarized" });

    const afterCompaction = model.requests.at(-1)!;
    expect(afterCompaction[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(afterCompaction[1]).toEqual({ role: "user", content: "TASK" });
    expect(afterCompaction[2]).toMatchObject({ role: "user", content: expect.stringContaining("SUMMARY NOTES") });
    // Every tool message still follows its assistant call.
    afterCompaction.forEach((m, i) => {
      if (m.role === "tool") {
        const owner = afterCompaction.slice(0, i).reverse().find((p) => p.role === "assistant");
        expect(owner && owner.role === "assistant" && owner.toolCalls.some((c) => c.id === m.toolCallId)).toBe(true);
      }
    });
  });
});

describe("runAgent — time checks", () => {
  /**
   * From two cobol-modernization traces: the agent read the remaining time in
   * its observations and kept exploring anyway, finishing with the deliverable
   * never written. The loop now interrupts at fixed thresholds.
   */
  const scriptOf = (n: number) => Array.from({ length: n }, (_, i) => callTools(`t${i}`));

  function withClock(totalMs: number, perTurnMs: number, turnCount: number) {
    let clock = 1_000_000;
    const started = clock;
    const realNow = Date.now;
    Date.now = () => clock;
    const { options, model, events } = setup([...scriptOf(turnCount), say("done")], {
      deadline: started + totalMs,
    });
    const advance = () => {
      clock += perTurnMs;
    };
    return { options, model, events, advance, restore: () => (Date.now = realNow) };
  }

  it("sends a time check once per threshold, escalating as time runs out", async () => {
    // 10-minute budget, 90s per turn: remaining crosses 50%, 25% and 10% in turn.
    const { options, model, events, advance, restore } = withClock(600_000, 90_000, 6);
    const original = model.complete.bind(model);
    model.complete = async (...args) => {
      advance();
      return original(...args);
    };
    try {
      await runAgent(options);
    } finally {
      restore();
    }
    const checks = events.filter((e) => e.type === "notice" && String(e.message).startsWith("time check"));
    expect(checks.map((e) => e.message)).toEqual([
      "time check sent at 50% remaining",
      "time check sent at 25% remaining",
      "time check sent at 10% remaining",
    ]);
    const sent = model.requests.at(-1)!.filter((m) => m.role === "user" && m.content.startsWith("[Time check]"));
    expect(sent).toHaveLength(3);
    expect(sent[0].content).toMatch(/minute\(s\) of the run remain/);
    expect(sent[0].content).toMatch(/is every artifact the task asked for actually in place/i);
  });

  it("sends no time check while plenty of time remains", async () => {
    const { options, events } = setup([callTools("a"), say("done")], { deadline: Date.now() + 3_600_000 });
    await runAgent(options);
    expect(events.filter((e) => e.type === "notice")).toHaveLength(0);
  });
});

describe("runAgent — deadline reached inside a model call", () => {
  it("ends as timeout, not as a model error", async () => {
    const { options, events } = setup([new ModelError("Model call aborted after 5539s: the run deadline passed", "deadline_exceeded", 1)]);
    const result = await runAgent(options);
    expect(result.status).toBe("timeout");
    expect(result.errorCategory).toBeUndefined();
    expect(result.finalMessage).toMatch(/time budget ran out during a model call/);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "timeout" });
  });
});

describe("runAgent — context overflow reported by the provider", () => {
  const overflow = () => new ModelError("maximum context length is 32768 tokens", "context_overflow", 1);
  const bigCall = (id: string) => ({
    message: { role: "assistant" as const, content: "x".repeat(20_000), toolCalls: [{ id, name: "echo", arguments: JSON.stringify({ text: id }) }] },
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
  });

  it("learns a smaller window, compacts, and continues", async () => {
    // The metadata claims 1M tokens; the provider actually overflows at ~17k.
    const { options, model, events } = setup([bigCall("a"), bigCall("b"), bigCall("c"), overflow(), say("NOTES"), say("done")]);
    const result = await runAgent(options);
    expect(result.status).toBe("completed");
    const compaction = events.find((e) => e.type === "compaction")!;
    expect(compaction).toMatchObject({ reason: "provider reported context overflow", outcome: "summarized" });
    expect(compaction.context_window as number).toBeLessThan(1_000_000);
    expect(model.requests.at(-1)![2]).toMatchObject({ role: "user", content: expect.stringContaining("NOTES") });
  });

  it("uses the learned window for later output budgets", async () => {
    const { options, model } = setup([bigCall("a"), bigCall("b"), bigCall("c"), overflow(), say("NOTES"), say("done")], { maxOutputTokens: 8_000 });
    await runAgent(options);
    const last = model.options.at(-1)!;
    expect(last.maxOutputTokens).toBeLessThan(8_000);
  });

  it("stops with context_overflow when there is nothing left to compact", async () => {
    const { options } = setup([overflow()]);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "context_overflow" });
  });

  it("stops instead of compacting forever when the provider keeps overflowing", async () => {
    const script: Parameters<typeof setup>[0] = [];
    for (let i = 0; i < 8; i++) script.push(bigCall(`t${i}`));
    for (let i = 0; i < 10; i++) script.push(overflow(), say(`N${i}`));
    const { options, model } = setup(script);
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: "model_error", errorCategory: "context_overflow" });
    expect(model.requests.length).toBeLessThanOrEqual(8 + 2 * 3);
  });
});
