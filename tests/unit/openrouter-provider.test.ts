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
    // OPENROUTER_FREE_TOOL_MODELS[0] — see that constant's comment for why
    // gemma, not gpt-oss-20b, is the live-evidence-backed default.
    expect(createMock.mock.calls[0][0].model).toBe("google/gemma-4-31b-it:free");
  });

  it("uses an explicit model override, including a paid model", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { model: "anthropic/claude-sonnet-5" });
    expect(createMock.mock.calls[0][0].model).toBe("anthropic/claude-sonnet-5");
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
    expect(models).toContain("openai/gpt-oss-20b:free");
    expect(models).toContain("openai/gpt-4o");
  });

  it("estimateCost() is zero for a known free model", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "openai/gpt-oss-20b:free")).toBe(0);
  });

  it("estimateCost() is non-zero for a paid model", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "openai/gpt-4o")).toBeGreaterThan(0);
  });

  it("embed() throws — not directly supported through this client", async () => {
    await expect(makeProvider().embed("text")).rejects.toThrow();
  });
});

// Regression coverage for OpenRouter's free-tier rate-limit strategy:
// each ":free" model draws from a per-model shared upstream pool across
// ALL of OpenRouter's free users, not a per-account quota — confirmed
// live, google/gemma-4-31b-it:free 429'd within a handful of requests
// with this account nowhere near any documented per-key limit. OpenRouter
// itself provides a `models` request field (an ordered list, tried
// server-side on failure, within one round trip) for exactly this — a
// client-side retry loop only re-hits the SAME exhausted pool.
describe("OpenRouterProvider — free-tier rate-limit spreading (models array)", () => {
  it("sends a `models` fallback list (primary + the other curated free models) when the resolved model is free", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { model: "openai/gpt-oss-20b:free" });
    const sent = createMock.mock.calls[0][0];
    expect(sent.model).toBe("openai/gpt-oss-20b:free");
    expect(sent.models[0]).toBe("openai/gpt-oss-20b:free");
    expect(sent.models.length).toBeGreaterThan(1);
    expect(new Set(sent.models).size).toBe(sent.models.length); // no duplicates
  });

  it("does NOT send a `models` fallback list for an explicit paid model — never silently substitutes a paid request", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg, { model: "anthropic/claude-sonnet-5" });
    expect(createMock.mock.calls[0][0].models).toBeUndefined();
  });

  it("sends the same `models` fallback list on the streaming path", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    for await (const _ of makeProvider().stream(userMsg, { model: "openai/gpt-oss-20b:free" })) {
      // drain
    }
    const sent = createMock.mock.calls[0][0];
    expect(sent.models[0]).toBe("openai/gpt-oss-20b:free");
    expect(sent.models.length).toBeGreaterThan(1);
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

  it("forwards tools to the streaming request in OpenAI function-calling shape", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const tools = [
      {
        name: "search",
        description: "search things",
        parameters: { type: "object" as const, properties: { q: { type: "string" } } },
      },
    ];
    for await (const _ of makeProvider().stream(userMsg, { tools })) {
      // drain
    }
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        tools: [
          {
            type: "function",
            function: { name: "search", description: "search things", parameters: tools[0].parameters },
          },
        ],
      }),
    );
  });

  it("accumulates streamed tool_call argument fragments into a completed toolCalls array on the final chunk", async () => {
    async function* fakeStream() {
      yield {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] } },
        ],
      };
      yield {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"cats"}' } }] } }],
      };
    }
    createMock.mockResolvedValue(fakeStream());
    const chunks: Array<{ toolCalls?: unknown; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    const last = chunks[chunks.length - 1];
    expect(last.done).toBe(true);
    expect(last.toolCalls).toEqual([{ id: "call_1", name: "search", params: { q: "cats" } }]);
  });
});
