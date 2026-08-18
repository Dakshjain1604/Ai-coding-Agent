/**
 * Tests for OpenRouterProvider (providers/OpenRouterProvider.ts) —
 * previously zero coverage.
 *
 * Centerpiece regression: complete() never forwarded CompletionOptions.
 * tools to OpenRouter's (OpenAI-compatible) chat API and never parsed
 * choice.message.tool_calls back — despite getCapabilities() already
 * (incorrectly) claiming `functionCalling: true`, and OpenRouter being
 * one of ModelRouter's two primary free-tier fallback providers
 * (alongside Groq). Same bug class as LocalProvider's/GroqProvider's,
 * found by systematically checking every remaining provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenRouterProvider } from "../../src/providers/OpenRouterProvider.js";
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
    model: "google/gemma-2-9b-8192-it",
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

beforeEach(() => {
  createMock.mockReset();
  modelsListMock.mockReset();
  process.env.OPENROUTER_API_KEY = "test-key";
});

function makeProvider(): OpenRouterProvider {
  return new OpenRouterProvider();
}

describe("OpenRouterProvider — constructor", () => {
  it("throws a clear error when no API key is available", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => new OpenRouterProvider()).toThrow(/API key/);
  });
});

describe("OpenRouterProvider — native tool-calling fix", () => {
  it("forwards tools to the request in OpenAI function-calling shape", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const provider = makeProvider();
    await provider.complete(userMsg, {
      tools: [
        {
          name: "search_content",
          description: "Search file contents",
          parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
        },
      ],
    });

    const sentRequest = createMock.mock.calls[0][0];
    expect(sentRequest.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_content",
          description: "Search file contents",
          parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
        },
      },
    ]);
  });

  it("does not send a tools field when no tools are requested", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].tools).toBeUndefined();
  });

  it("parses tool_calls from the response", async () => {
    createMock.mockResolvedValue(
      chatCompletion({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "search_content", arguments: '{"pattern":"TODO"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const result = await makeProvider().complete(userMsg, {
      tools: [{ name: "search_content", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "search_content", params: { pattern: "TODO" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("falls back to an empty params object for malformed JSON arguments", async () => {
    createMock.mockResolvedValue(
      chatCompletion({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: "c", function: { name: "x", arguments: "{bad" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const result = await makeProvider().complete(userMsg, {
      tools: [{ name: "x", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.toolCalls?.[0].params).toEqual({});
  });

  it("leaves toolCalls undefined for a plain text response", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const result = await makeProvider().complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
  });
});

describe("OpenRouterProvider — complete() general behavior", () => {
  it("uses the default model when none specified", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].model).toBe("google/gemma-2-9b-8192-it");
  });

  it("uses an explicit model override, including a paid model", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { model: "anthropic/claude-3.5-sonnet" });
    expect(createMock.mock.calls[0][0].model).toBe("anthropic/claude-3.5-sonnet");
  });

  it("maps usage stats correctly", async () => {
    createMock.mockResolvedValue(chatCompletion({ usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    const result = await makeProvider().complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it("wraps a thrown error as a ProviderError", async () => {
    createMock.mockRejectedValue(new Error("insufficient credits"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/insufficient credits/);
  });

  it("maps finish_reason 'length' correctly", async () => {
    createMock.mockResolvedValue(
      chatCompletion({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }),
    );
    expect((await makeProvider().complete(userMsg)).finishReason).toBe("length");
  });
});

describe("OpenRouterProvider — isAvailable/getModels/estimateCost/embed", () => {
  it("isAvailable() returns true when models.list() succeeds", async () => {
    modelsListMock.mockResolvedValue({ data: [] });
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when models.list() throws", async () => {
    modelsListMock.mockRejectedValue(new Error("unauthorized"));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("getModels() includes both free and paid models", async () => {
    const models = await makeProvider().getModels();
    expect(models).toContain("google/gemma-2-9b-8192-it");
    expect(models).toContain("openai/gpt-4o");
  });

  it("estimateCost() is zero for a known free model", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "google/gemma-2-9b-8192-it")).toBe(0);
  });

  it("estimateCost() is non-zero for a paid model", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "openai/gpt-4o")).toBeGreaterThan(0);
  });

  it("embed() throws — not directly supported through this client", async () => {
    await expect(makeProvider().embed("text")).rejects.toThrow();
  });
});

describe("OpenRouterProvider — stream()", () => {
  it("yields content deltas", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "a" } }] };
      yield { choices: [{ delta: { content: "b" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const chunks: string[] = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks).toEqual(["a", "b"]);
  });
});
