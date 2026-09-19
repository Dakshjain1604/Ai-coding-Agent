import { describe, expect, it, vi } from "vitest";
import { DEADLINE_EXCEEDED, OpenRouterClient, describeError, parseModelSpec, retryDelayMs, toWireMessages } from "../../../src/harness/openrouter-client.js";
import { ModelError } from "../../../src/harness/types.js";
import type { Message } from "../../../src/harness/types.js";

type Chunk = Record<string, unknown>;

async function* streamOf(chunks: Chunk[]) {
  for (const c of chunks) yield c;
}

function fakeClient(responses: Array<Chunk[] | Error | (() => AsyncIterable<Chunk>)>) {
  const create = vi.fn(async (_body: Record<string, unknown>, _opts: { signal: AbortSignal }) => {
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : streamOf(next);
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

function makeClient(responses: Parameters<typeof fakeClient>[0], overrides: Record<string, unknown> = {}) {
  const { client, create } = fakeClient(responses);
  const sleep = vi.fn(async () => {});
  const model = new OpenRouterClient({
    spec: "openrouter/vendor/model:free",
    client,
    sleep,
    fetchModelMetadata: async () => undefined,
    ...overrides,
  });
  return { model, create, sleep };
}

const opts = { deadline: Date.now() + 3_600_000, maxOutputTokens: 1000 };
const conversation: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "task" },
];

const textChunks: Chunk[] = [
  { model: "vendor/model", choices: [{ delta: { content: "Hel" } }] },
  { model: "vendor/model", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.0012 } },
];

describe("toWireMessages", () => {
  const transcript: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "bash", arguments: '{"command":"ls"}' },
        { id: "c2", name: "bash", arguments: '{"command": "unterminated' },
      ],
      reasoningDetails: [{ type: "reasoning.text", text: "think" }],
    },
    { role: "tool", toolCallId: "c1", name: "bash", content: "[exit code 0]" },
    { role: "tool", toolCallId: "c2", name: "bash", content: "Error: not valid JSON" },
    { role: "assistant", content: "done", toolCalls: [] },
  ];

  it("keeps tool calls and reasoning details, and links each tool result to its call id", () => {
    const wire = toWireMessages(transcript);
    expect(wire[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        { id: "c2", type: "function", function: { name: "bash", arguments: JSON.stringify({ invalid_arguments: '{"command": "unterminated' }) } },
      ],
      reasoning_details: [{ type: "reasoning.text", text: "think" }],
    });
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "[exit code 0]" });
    expect(wire[5]).toEqual({ role: "assistant", content: "done" });
  });
});

describe("parseModelSpec", () => {
  it("returns the model id, which may contain slashes", () => {
    expect(parseModelSpec("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  it.each([["groq/openai/gpt-oss-120b"], ["nvidia/nemotron"], ["openrouter/"], [""]])("rejects %j", (spec) => {
    expect(() => parseModelSpec(spec)).toThrow(/expected "openrouter\/<model id>"/);
  });
});

describe("OpenRouterClient — construction", () => {
  it("requires OPENROUTER_API_KEY when no client is injected", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterClient({ spec: "openrouter/x/y" })).toThrow(/OPENROUTER_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it("exposes the API key env var so tools can hide it", () => {
    const { model } = makeClient([]);
    expect(model.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });
});

describe("OpenRouterClient — request", () => {
  const bashSpec = { name: "bash", description: "run", parameters: { type: "object" as const, properties: {}, required: [] } };

  it("streams, caps output, accounts usage, and routes only to upstreams supporting every parameter", async () => {
    const { model, create } = makeClient([textChunks]);
    await model.complete(conversation, [bashSpec], opts);
    const body = create.mock.calls[0][0];
    expect(body).toMatchObject({
      model: "vendor/model:free",
      stream: true,
      max_tokens: 1000,
      tool_choice: "auto",
      usage: { include: true },
      provider: { require_parameters: true },
      tools: [{ type: "function", function: { name: "bash", description: "run" } }],
    });
    expect(body).not.toHaveProperty("models"); // never a server-side model swap
    expect(body).not.toHaveProperty("reasoning");
  });

  it("omits tools when none are given", async () => {
    const { model, create } = makeClient([textChunks]);
    await model.complete(conversation, [], opts);
    expect(create.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(create.mock.calls[0][0]).not.toHaveProperty("tool_choice");
  });

  it("sends reasoning effort when configured", async () => {
    const { model, create } = makeClient([textChunks], { reasoningEffort: "high" });
    await model.complete(conversation, [], opts);
    expect(create.mock.calls[0][0].reasoning).toEqual({ effort: "high" });
  });
});

describe("OpenRouterClient — stream parsing", () => {
  it("assembles text, finish reason, usage and cost", async () => {
    const { model } = makeClient([textChunks]);
    const turn = await model.complete(conversation, [], opts);
    expect(turn.message).toEqual({ role: "assistant", content: "Hello", toolCalls: [] });
    expect(turn.finishReason).toBe("stop");
    expect(turn.usage).toEqual({ promptTokens: 12, completionTokens: 3, cachedTokens: 4, costUsd: 0.0012 });
    expect(turn.servedBy).toBe("vendor/model");
    expect(turn.attempts).toBe(1);
  });

  it("assembles streamed tool-call fragments, keeping raw arguments and ids", async () => {
    const { model } = makeClient([
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "bash", arguments: '{"comm' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "editor", arguments: "{bad" } }] }, finish_reason: "tool_calls" }] },
      ],
    ]);
    const turn = await model.complete(conversation, [], opts);
    expect(turn.message.toolCalls).toEqual([
      { id: "call_a", name: "bash", arguments: '{"command":"ls"}' },
      { id: "call_b", name: "editor", arguments: "{bad" },
    ]);
    expect(turn.finishReason).toBe("tool_calls");
  });

  it("records the upstream provider OpenRouter routed to", async () => {
    const { model } = makeClient([[{ provider: "Nvidia", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]]);
    expect((await model.complete(conversation, [], opts)).upstream).toBe("Nvidia");
  });

  it("generates ids for tool calls the provider left unnamed", async () => {
    const { model } = makeClient([
      [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "{}" } }] } }] }],
    ]);
    const turn = await model.complete(conversation, [], opts);
    expect(turn.message.toolCalls[0].id).toMatch(/^call_/);
    expect(turn.finishReason).toBe("tool_calls");
  });

  it("collects reasoning details for echoing back", async () => {
    const { model } = makeClient([
      [
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a" }] } }] },
        { choices: [{ delta: { content: "ok", reasoning_details: [{ type: "reasoning.text", text: "b" }] }, finish_reason: "stop" }] },
      ],
    ]);
    const turn = await model.complete(conversation, [], opts);
    expect(turn.message.reasoningDetails).toEqual([
      { type: "reasoning.text", text: "a" },
      { type: "reasoning.text", text: "b" },
    ]);
  });

  it("maps finish_reason length", async () => {
    const { model } = makeClient([[{ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }]]);
    expect((await model.complete(conversation, [], opts)).finishReason).toBe("length");
  });
});

describe("OpenRouterClient — retry policy (the only one)", () => {
  const rateLimited = () => Object.assign(new Error("429 Rate limit exceeded: too many requests per minute"), { status: 429, headers: { "retry-after": "7" } });

  it("retries a transient rate limit honoring Retry-After, reporting each retry", async () => {
    const onRetry = vi.fn();
    const { model, sleep } = makeClient([rateLimited(), textChunks]);
    const turn = await model.complete(conversation, [], { ...opts, onRetry });
    expect(turn.message.content).toBe("Hello");
    expect(turn.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(7_000);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, category: "rate_limit", waitMs: 7_000 }));
  });

  it("fails fast on an exhausted daily quota (seen live: retried 9x before)", async () => {
    const quota = Object.assign(new Error("429 Rate limit exceeded: free-models-per-day. Add 5 credits"), { status: 429 });
    const { model, create, sleep } = makeClient([quota, textChunks]);
    const error = await model.complete(conversation, [], opts).catch((e) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.category).toBe("quota_exhausted");
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable request error", async () => {
    const { model, create } = makeClient([Object.assign(new Error("400 Bad Request"), { status: 400 })]);
    await expect(model.complete(conversation, [], opts)).rejects.toMatchObject({ category: "invalid_request" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not resend a request whose generation the provider rejected, and carries the rejected output", async () => {
    const rejected = Object.assign(new Error('400 {"code":"tool_use_failed"}'), {
      status: 400,
      error: { code: "tool_use_failed", failed_generation: '{"command": "echo "hi""}' },
    });
    const { model, create, sleep } = makeClient([rejected, textChunks]);
    const error = await model.complete(conversation, [], opts).catch((e) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.category).toBe("invalid_model_output");
    expect(error.rejectedGeneration).toBe('{"command": "echo "hi""}');
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recognizes a rejected generation reported as a mid-stream error chunk", async () => {
    const { model, create } = makeClient([
      [{ error: { message: "Failed to parse tool call arguments as JSON", failed_generation: "{bad" } }],
      textChunks,
    ]);
    const error = await model.complete(conversation, [], opts).catch((e) => e);
    expect(error).toMatchObject({ category: "invalid_model_output", rejectedGeneration: "{bad" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("finds a rejected generation nested in OpenRouter's upstream metadata", async () => {
    const rejected = Object.assign(new Error("400 Provider returned error"), {
      status: 400,
      error: {
        code: 400,
        message: "Provider returned error",
        metadata: { provider_name: "Groq", raw: JSON.stringify({ error: { code: "tool_use_failed", failed_generation: "{oops" } }) },
      },
    });
    const { model, create } = makeClient([rejected, textChunks]);
    const error = await model.complete(conversation, [], opts).catch((e) => e);
    expect(error).toMatchObject({ category: "invalid_model_output", rejectedGeneration: "{oops" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("raises context overflow immediately (hidden in upstream detail) so the loop can compact", async () => {
    const overflow = Object.assign(new Error("400 Provider returned error"), {
      status: 400,
      error: { message: "Provider returned error", metadata: { raw: "This model's maximum context length is 32768 tokens" } },
    });
    const { model, create, sleep } = makeClient([overflow, textChunks]);
    const error = await model.complete(conversation, [], opts).catch((e) => e);
    expect(error).toMatchObject({ category: "context_overflow" });
    expect(error.message).toContain("maximum context length is 32768");
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts", async () => {
    const serverError = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    const { model, create } = makeClient([serverError(), serverError(), serverError()], { maxAttempts: 3 });
    await expect(model.complete(conversation, [], opts)).rejects.toMatchObject({ category: "server_error", attempts: 3 });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not sleep past the deadline", async () => {
    const { model, sleep } = makeClient([rateLimited(), textChunks]);
    const error = await model.complete(conversation, [], { ...opts, deadline: Date.now() + 1_000 }).catch((e) => e);
    expect(error.message).toMatch(/deadline reached before retry/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats a mid-stream provider error chunk as a failure and retries it", async () => {
    const { model, create } = makeClient([
      [{ choices: [{ delta: { content: "par" } }] }, { error: { message: "Upstream overloaded", code: 502 } }],
      textChunks,
    ]);
    const turn = await model.complete(conversation, [], opts);
    expect(turn.message.content).toBe("Hello"); // partial content from the failed attempt is discarded
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled stream after the idle timeout and retries", async () => {
    const stalled = () =>
      (async function* () {
        yield { choices: [{ delta: { content: "x" } }] };
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      })();
    const { model, create } = makeClient([stalled, textChunks], { idleTimeoutMs: 50 });
    // The fake stream ignores the abort signal, so emulate the SDK: reject when aborted.
    const original = create.getMockImplementation()!;
    create.mockImplementation(async (body, options) => {
      const iterable = await original(body, options);
      return (async function* () {
        const iterator = (iterable as AsyncIterable<Chunk>)[Symbol.asyncIterator]();
        for (;;) {
          const aborted = new Promise<never>((_, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true }),
          );
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) return;
          yield next.value;
        }
      })();
    });
    const onRetry = vi.fn();
    const turn = await model.complete(conversation, [], { ...opts, onRetry });
    expect(turn.message.content).toBe("Hello");
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ category: "network", message: expect.stringMatching(/stalled/) }));
  });
});

describe("OpenRouterClient — the run deadline bounds a call in flight", () => {
  /**
   * Seen live: the host slept mid-stream, so no timer fired and one call ran
   * for 92 minutes, spending the whole task budget. The wall clock is checked
   * on every chunk, not only by a timer.
   */
  it("aborts a stream that is still arriving after the deadline, without retrying", async () => {
    let clock = 1_000_000;
    const { model, create, sleep } = makeClient(
      [
        [
          { choices: [{ delta: { content: "before" } }] },
          { choices: [{ delta: { content: "after the host woke up" } }] },
        ],
        textChunks,
      ],
      { now: () => clock },
    );
    const deadline = clock + 60_000;
    const original = create.getMockImplementation()!;
    create.mockImplementation(async (body, options) => {
      const iterable = await original(body, options);
      return (async function* () {
        for await (const chunk of iterable as AsyncIterable<Chunk>) {
          clock += 3_600_000; // the host was suspended between chunks
          yield chunk;
        }
      })();
    });

    const error = await model.complete(conversation, [], { ...opts, deadline }).catch((e) => e);
    expect(error.category).toBe(DEADLINE_EXCEEDED);
    expect(error.message).toMatch(/run deadline passed/);
    expect(create).toHaveBeenCalledTimes(1); // never retried: the run is over
    expect(sleep).not.toHaveBeenCalled();
  });

  it("leaves a call that finishes before the deadline untouched", async () => {
    const { model } = makeClient([textChunks]);
    const turn = await model.complete(conversation, [], { ...opts, deadline: Date.now() + 600_000 });
    expect(turn.message.content).toBe("Hello");
  });
});

describe("OpenRouterClient — limits", () => {
  it("merges defaults, provider metadata and explicit overrides (in that precedence)", async () => {
    const { model } = makeClient([], {
      fetchModelMetadata: async () => ({ contextWindow: 1_000_000, maxOutputTokens: 65_536 }),
      limits: { contextWindow: 200_000 },
    });
    expect(await model.limits()).toEqual({ contextWindow: 200_000, maxOutputTokens: 65_536 });
  });

  it("falls back to defaults when metadata lookup fails", async () => {
    const { model } = makeClient([], { fetchModelMetadata: async () => { throw new Error("offline"); } });
    expect(await model.limits()).toEqual({ contextWindow: 128_000, maxOutputTokens: 16_384 });
  });
});

describe("retryDelayMs", () => {
  it("uses Retry-After seconds, capped at 120s", () => {
    expect(retryDelayMs({ headers: { "retry-after": "3" } }, 1)).toBe(3_000);
    expect(retryDelayMs({ headers: { "retry-after": "999" } }, 1)).toBe(120_000);
  });

  it("uses jittered exponential backoff otherwise, capped at 60s", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const base = Math.min(2 ** attempt * 1000, 60_000);
      const delay = retryDelayMs(new Error("x"), attempt);
      expect(delay).toBeGreaterThanOrEqual(base / 2);
      expect(delay).toBeLessThanOrEqual(base);
    }
  });
});


describe("describeError", () => {
  it("appends OpenRouter's provider name and upstream detail", () => {
    const error = Object.assign(new Error("400 Provider returned error"), {
      error: { metadata: { provider_name: "DeepInfra", raw: { error: "bad things" } } },
    });
    expect(describeError(error)).toBe('400 Provider returned error | provider: DeepInfra | upstream: {"error":"bad things"}');
  });

  it("returns the plain message when there is no metadata", () => {
    expect(describeError(new Error("503 Service Unavailable"))).toBe("503 Service Unavailable");
    expect(describeError("text")).toBe("text");
  });

  it("bounds very long upstream detail", () => {
    const error = Object.assign(new Error("x"), { error: { metadata: { raw: "y".repeat(10_000) } } });
    expect(describeError(error).length).toBeLessThan(2_000);
  });
});
