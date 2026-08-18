/**
 * Tests for GroqProvider (providers/GroqProvider.ts) — previously zero
 * coverage.
 *
 * Centerpiece regression: complete() never forwarded CompletionOptions.
 * tools to Groq's (OpenAI-compatible) chat API and never parsed
 * choice.message.tool_calls back — despite getCapabilities() already
 * (incorrectly) claiming `functionCalling: true`, and Groq being one of
 * ModelRouter's two primary free-tier fallback providers (alongside
 * OpenRouter). Same bug class as LocalProvider's, found by systematically
 * checking every remaining provider after that fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroqProvider } from "../../src/providers/GroqProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const createMock = vi.fn();
const modelsListMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    models = { list: (...args: unknown[]) => modelsListMock(...args) };
    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
    }
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function chatCompletion(overrides?: Record<string, unknown>) {
  return {
    id: "x",
    model: "openai/gpt-oss-20b",
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

beforeEach(() => {
  createMock.mockReset();
  modelsListMock.mockReset();
  process.env.GROQ_API_KEY = "test-key";
});

function makeProvider(): GroqProvider {
  return new GroqProvider();
}

describe("GroqProvider — constructor", () => {
  it("throws a clear error when no API key is available", () => {
    delete process.env.GROQ_API_KEY;
    expect(() => new GroqProvider()).toThrow(/API key/);
  });

  it("accepts an explicit apiKey in config", () => {
    delete process.env.GROQ_API_KEY;
    expect(() => new GroqProvider({ apiKey: "explicit-key" })).not.toThrow();
  });
});

describe("GroqProvider — native tool-calling fix", () => {
  it("forwards tools to the request in OpenAI function-calling shape", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const provider = makeProvider();
    await provider.complete(userMsg, {
      tools: [
        {
          name: "file_read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    });

    const sentRequest = createMock.mock.calls[0][0];
    expect(sentRequest.tools).toEqual([
      {
        type: "function",
        function: {
          name: "file_read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ]);
  });

  it("does not send a tools field when no tools are requested", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const provider = makeProvider();
    await provider.complete(userMsg);
    expect(createMock.mock.calls[0][0].tools).toBeUndefined();
  });

  it("does not send a tools field for an empty tools array", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const provider = makeProvider();
    await provider.complete(userMsg, { tools: [] });
    expect(createMock.mock.calls[0][0].tools).toBeUndefined();
  });

  it("parses tool_calls from the response, including JSON-decoding string arguments", async () => {
    createMock.mockResolvedValue(
      chatCompletion({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "file_read", arguments: '{"path":"x.ts"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const provider = makeProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });

    expect(result.toolCalls).toEqual([{ id: "call_1", name: "file_read", params: { path: "x.ts" } }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("falls back to an empty params object for malformed JSON arguments, without throwing", async () => {
    createMock.mockResolvedValue(
      chatCompletion({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "x", arguments: "{not valid json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const provider = makeProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "x", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.toolCalls?.[0].params).toEqual({});
  });

  it("leaves toolCalls undefined for a plain text response", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const provider = makeProvider();
    const result = await provider.complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe("stop");
  });

  it("maps finish_reason 'length' correctly", async () => {
    createMock.mockResolvedValue(
      chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }),
    );
    const result = await makeProvider().complete(userMsg);
    expect(result.finishReason).toBe("length");
  });

  it("maps an unrecognized finish_reason to 'error'", async () => {
    createMock.mockResolvedValue(
      chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] }),
    );
    const result = await makeProvider().complete(userMsg);
    expect(result.finishReason).toBe("error");
  });
});

describe("GroqProvider — complete() general behavior", () => {
  it("uses the default model when none specified", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].model).toBe("openai/gpt-oss-20b");
  });

  it("uses an explicit model override", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { model: "openai/gpt-oss-120b" });
    expect(createMock.mock.calls[0][0].model).toBe("openai/gpt-oss-120b");
  });

  it("maps usage stats correctly", async () => {
    createMock.mockResolvedValue(chatCompletion({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    const result = await makeProvider().complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("wraps a thrown error as a ProviderError", async () => {
    createMock.mockRejectedValue(new Error("rate limited"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/rate limited/);
  });
});

describe("GroqProvider — isAvailable/getModels/estimateCost/embed", () => {
  it("isAvailable() returns true when models.list() succeeds", async () => {
    modelsListMock.mockResolvedValue({ data: [] });
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when models.list() throws", async () => {
    modelsListMock.mockRejectedValue(new Error("unauthorized"));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("getModels() returns the static supported-models list", async () => {
    const models = await makeProvider().getModels();
    expect(models).toContain("openai/gpt-oss-20b");
  });

  it("estimateCost() is zero for Groq's free-tier models", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "openai/gpt-oss-20b")).toBe(0);
  });

  it("estimateCost() is zero even for an unrecognized model (defaults to free rates)", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "some-unknown-model")).toBe(0);
  });

  it("embed() throws — Groq does not support embeddings", async () => {
    await expect(makeProvider().embed("text")).rejects.toThrow(/not supported/i);
  });

  it("countTokens estimates roughly 4 characters per token", () => {
    expect(makeProvider().countTokens("a".repeat(400))).toBe(100);
  });
});

describe("GroqProvider — stream()", () => {
  it("yields content deltas then a final done sentinel", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "hel" } }] };
      yield { choices: [{ delta: { content: "lo" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo"]);
  });

  it("wraps a streaming error as a ProviderError", async () => {
    createMock.mockRejectedValue(new Error("stream failed"));
    const provider = makeProvider();
    // stream() is an async generator — its body only runs once iteration
    // begins, so calling .next() is what actually triggers (and lets us
    // catch) the underlying request rejection.
    await expect(provider.stream(userMsg).next()).rejects.toThrow(/stream failed/);
  });
});
