/**
 * Tests for OllamaCloudProvider (providers/OllamaCloudProvider.ts) —
 * previously zero coverage.
 *
 * Two regressions found and fixed this pass:
 *  1. stream() never yielded a final `{content:"", done:true}` sentinel —
 *     every other provider's stream() does, and StreamChunk.done is a
 *     required field of the interface contract.
 *  2. complete() cast `choice.finish_reason` straight to `"stop"|"length"`
 *     with no runtime check, silently mislabeling anything else (e.g.
 *     "content_filter" or null) as one of those two. Same bug class fixed
 *     in Groq/OpenRouter this session; ported the same mapFinishReason
 *     pattern here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaCloudProvider } from "../../src/providers/OllamaCloudProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const createMock = vi.fn();
const modelsListMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string | undefined;
    baseURL: string;
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    models = { list: (...args: unknown[]) => modelsListMock(...args) };
    constructor(config: { apiKey?: string; baseURL: string }) {
      this.apiKey = config.apiKey;
      this.baseURL = config.baseURL;
    }
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function chatCompletion(overrides?: Record<string, unknown>) {
  return {
    id: "x",
    model: "llama3.2",
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

beforeEach(() => {
  createMock.mockReset();
  modelsListMock.mockReset();
});

function makeProvider(overrides?: Record<string, unknown>): OllamaCloudProvider {
  return new OllamaCloudProvider({ baseUrl: "https://cloud.example.com/v1", ...overrides });
}

describe("OllamaCloudProvider — constructor", () => {
  it("throws a clear error when no baseUrl is provided", () => {
    expect(() => new OllamaCloudProvider()).toThrow(/baseUrl/);
  });

  it("throws when config is provided but baseUrl is omitted", () => {
    expect(() => new OllamaCloudProvider({ apiKey: "x" })).toThrow(/baseUrl/);
  });

  it("accepts a baseUrl with no apiKey", () => {
    expect(() => new OllamaCloudProvider({ baseUrl: "https://cloud.example.com" })).not.toThrow();
  });

  it("defaults the model to llama3.2 when none specified", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].model).toBe("llama3.2");
  });

  it("uses a configured defaultModel override", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider({ defaultModel: "mistral" }).complete(userMsg);
    expect(createMock.mock.calls[0][0].model).toBe("mistral");
  });
});

describe("OllamaCloudProvider — finishReason mapping fix", () => {
  it("maps 'stop' correctly", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("stop");
  });

  it("maps 'length' correctly", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("length");
  });

  it("maps 'tool_calls' to 'tool_calls' instead of silently mislabeling it", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "tool_calls" }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("tool_calls");
  });

  it("maps 'function_call' to 'tool_calls'", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "function_call" }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("tool_calls");
  });

  it("maps an unrecognized finish_reason (e.g. 'content_filter') to 'error' rather than silently casting it", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("error");
  });

  it("maps a null finish_reason to 'error' rather than casting it to a bogus 'stop'/'length' value", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: null }] }));
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("error");
  });
});

describe("OllamaCloudProvider — complete() general behavior", () => {
  it("returns content from the first choice", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const result = await makeProvider().complete(userMsg);
    expect(result.content).toBe("hi there");
  });

  it("falls back to empty string when content is null", async () => {
    createMock.mockResolvedValue(chatCompletion({ choices: [{ message: { content: null }, finish_reason: "stop" }] }));
    const result = await makeProvider().complete(userMsg);
    expect(result.content).toBe("");
  });

  it("maps usage stats correctly", async () => {
    createMock.mockResolvedValue(chatCompletion({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    const result = await makeProvider().complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("defaults usage stats to zero when usage is absent", async () => {
    createMock.mockResolvedValue(chatCompletion({ usage: undefined }));
    const result = await makeProvider().complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("forwards temperature and maxTokens to the request", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { temperature: 0.3, maxTokens: 2048 });
    const sent = createMock.mock.calls[0][0];
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_tokens).toBe(2048);
  });

  it("defaults maxTokens to 4096 when not specified", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].max_tokens).toBe(4096);
  });

  it("wraps a thrown error as a ProviderError", async () => {
    createMock.mockRejectedValue(new Error("connection refused"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/connection refused/);
  });

  it("serializes non-string message content to JSON", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete([
      { role: "user", content: [{ type: "text", text: "hi" }] as unknown as string },
    ]);
    const sentMessages = createMock.mock.calls[0][0].messages;
    expect(typeof sentMessages[0].content).toBe("string");
  });
});

describe("OllamaCloudProvider — stream() sentinel fix", () => {
  it("yields content deltas then a final done:true sentinel", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "hel" } }] };
      yield { choices: [{ delta: { content: "lo" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo", ""]);
    expect(chunks[chunks.length - 1].done).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.done === false)).toBe(true);
  });

  it("yields only the done sentinel when the stream has no content deltas", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: {} }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ content: "", done: true }]);
  });

  it("wraps a streaming error as a ProviderError", async () => {
    createMock.mockRejectedValue(new Error("stream failed"));
    const provider = makeProvider();
    await expect(provider.stream(userMsg).next()).rejects.toThrow(/stream failed/);
  });
});

describe("OllamaCloudProvider — isAvailable/getModels/estimateCost/embed/countTokens", () => {
  it("isAvailable() returns true when models.list() succeeds", async () => {
    modelsListMock.mockResolvedValue({ data: [] });
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when models.list() throws", async () => {
    modelsListMock.mockRejectedValue(new Error("unreachable"));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("getModels() returns the static supported-models list", async () => {
    const models = await makeProvider().getModels();
    expect(models).toContain("llama3.2");
  });

  it("estimateCost() is always zero", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "llama3.2")).toBe(0);
  });

  it("embed() throws — not supported through this generic OpenAI-compatible client", async () => {
    await expect(makeProvider().embed("text")).rejects.toThrow(/provider-specific/i);
  });

  it("countTokens estimates roughly 4 characters per token", () => {
    expect(makeProvider().countTokens("a".repeat(400))).toBe(100);
  });

  it("getCapabilities() honestly reports functionCalling:false", () => {
    expect(makeProvider().getCapabilities().functionCalling).toBe(false);
  });
});
