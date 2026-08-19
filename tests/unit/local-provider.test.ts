/**
 * Tests for LocalProvider (providers/LocalProvider.ts) — the project's
 * default, local-first provider — previously zero test coverage.
 *
 * Centerpiece regression: complete()'s "ollama" branch never forwarded
 * CompletionOptions.tools to Ollama's chat API and never parsed
 * message.tool_calls back, even though:
 *   1. BaseAgent.callLLM() already builds and passes `tools` in the
 *      options object on every single call, to every provider.
 *   2. UniversalAgent.execute() explicitly PREFERS a provider's native
 *      `CompletionResult.toolCalls` over its own text-based ```tool
 *      block parser whenever toolCalls is non-empty.
 *   3. The Ollama client actually installed (`ollama` npm package,
 *      confirmed against its own .d.ts) supports both ChatRequest.tools
 *      and Message.tool_calls natively.
 *   4. A dead, unreachable 495-line OllamaProvider.ts already implemented
 *      this correctly — proof the capability was always available, just
 *      never wired into the class actually constructed by ProviderFactory
 *      (confirmed: `local: LocalProvider, ollama: LocalProvider` — the
 *      OllamaProvider class had zero real callers anywhere and was
 *      deleted after porting the one thing worth keeping from it).
 * Net effect before this fix: every local/Ollama-routed task — the
 * project's own default, "local-first" path — was forced onto the
 * strictly more fragile text-parsing path for tool calls, never the
 * more reliable native mechanism every other capable provider gets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalProvider } from "../../src/providers/LocalProvider.js";
import type { ChatMessage, CompletionOptions } from "../../src/providers/ProviderInterface.js";

const chatMock = vi.fn();
const embeddingsMock = vi.fn();

vi.mock("ollama", () => ({
  default: {
    chat: (...args: unknown[]) => chatMock(...args),
    embeddings: (...args: unknown[]) => embeddingsMock(...args),
  },
}));

function ollamaProvider(): LocalProvider {
  return new LocalProvider({ provider: "ollama" });
}

function lmStudioProvider(): LocalProvider {
  return new LocalProvider({ provider: "lmstudio", baseUrl: "http://localhost:1234" });
}

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function chatResponse(overrides?: Record<string, unknown>) {
  return {
    model: "qwen2.5-coder:latest",
    message: { role: "assistant", content: "hi there" },
    done: true,
    prompt_eval_count: 10,
    eval_count: 5,
    ...overrides,
  };
}

beforeEach(() => {
  chatMock.mockReset();
  embeddingsMock.mockReset();
});

describe("LocalProvider (ollama) — native tool-calling fix", () => {
  it("forwards CompletionOptions.tools to ollama.chat() in the correct shape", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    const options: CompletionOptions = {
      tools: [
        {
          name: "file_read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    };
    await provider.complete(userMsg, options);

    const sentRequest = chatMock.mock.calls[0][0];
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

  it("does not send a tools field at all when no tools are requested", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    await provider.complete(userMsg);

    const sentRequest = chatMock.mock.calls[0][0];
    expect(sentRequest.tools).toBeUndefined();
  });

  it("does not send a tools field when options.tools is an empty array", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    await provider.complete(userMsg, { tools: [] });

    const sentRequest = chatMock.mock.calls[0][0];
    expect(sentRequest.tools).toBeUndefined();
  });

  it("parses a single tool_call from the response into CompletionResult.toolCalls", async () => {
    chatMock.mockResolvedValue(
      chatResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "file_read", arguments: { path: "x.ts" } } }],
        },
      }),
    );
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });

    expect(result.toolCalls).toEqual([{ name: "file_read", params: { path: "x.ts" } }]);
  });

  it("parses multiple tool_calls in a single response", async () => {
    chatMock.mockResolvedValue(
      chatResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "file_read", arguments: { path: "a.ts" } } },
            { function: { name: "file_read", arguments: { path: "b.ts" } } },
          ],
        },
      }),
    );
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });

    expect(result.toolCalls?.length).toBe(2);
    expect(result.toolCalls?.[1]).toEqual({ name: "file_read", params: { path: "b.ts" } });
  });

  it("sets finishReason to 'tool_calls' when tool calls are present", async () => {
    chatMock.mockResolvedValue(
      chatResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "file_read", arguments: {} } }],
        },
      }),
    );
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.finishReason).toBe("tool_calls");
  });

  it("sets finishReason to 'stop' when no tool calls are present", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
  });

  it("leaves toolCalls undefined (not an empty array) when the response's tool_calls field is absent", async () => {
    chatMock.mockResolvedValue(chatResponse({ message: { role: "assistant", content: "hi" } }));
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
  });

  it("leaves toolCalls undefined when the response's tool_calls array is empty", async () => {
    chatMock.mockResolvedValue(
      chatResponse({ message: { role: "assistant", content: "hi", tool_calls: [] } }),
    );
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe("stop");
  });

  it("getCapabilities().functionCalling is true for the ollama sub-mode", () => {
    expect(ollamaProvider().getCapabilities().functionCalling).toBe(true);
  });

  it("getCapabilities().functionCalling is false for the lmstudio sub-mode (not wired up there)", () => {
    expect(lmStudioProvider().getCapabilities().functionCalling).toBe(false);
  });
});

describe("LocalProvider (ollama) — complete() general behavior", () => {
  it("uses the configured default model when none is specified", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = new LocalProvider({ provider: "ollama", defaultModel: "custom-model" });
    await provider.complete(userMsg);
    expect(chatMock.mock.calls[0][0].model).toBe("custom-model");
  });

  it("uses an explicitly requested model over the default", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    await provider.complete(userMsg, { model: "other-model" });
    expect(chatMock.mock.calls[0][0].model).toBe("other-model");
  });

  it("maps prompt_eval_count/eval_count into usage stats correctly", async () => {
    chatMock.mockResolvedValue(chatResponse({ prompt_eval_count: 100, eval_count: 50 }));
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("defaults usage counts to 0 when the response omits them", async () => {
    chatMock.mockResolvedValue({ model: "x", message: { role: "assistant", content: "hi" }, done: true });
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("passes through the response content", async () => {
    chatMock.mockResolvedValue(chatResponse({ message: { role: "assistant", content: "the answer" } }));
    const provider = ollamaProvider();
    const result = await provider.complete(userMsg);
    expect(result.content).toBe("the answer");
  });

  it("wraps a thrown error as a ProviderError", async () => {
    chatMock.mockRejectedValue(new Error("connection refused"));
    const provider = ollamaProvider();
    await expect(provider.complete(userMsg)).rejects.toThrow(/connection refused/);
  });

  it("converts ContentBlock[] message content to a text string", async () => {
    chatMock.mockResolvedValue(chatResponse());
    const provider = ollamaProvider();
    await provider.complete([
      {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      },
    ]);
    expect(chatMock.mock.calls[0][0].messages[0].content).toBe("part one\npart two");
  });
});

describe("LocalProvider (lmstudio) — complete()", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts to the LM Studio OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "lm studio reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = lmStudioProvider();
    const result = await provider.complete(userMsg);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.content).toBe("lm studio reply");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  });

  it("throws a ProviderError on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Internal Server Error",
    }) as unknown as typeof fetch;

    const provider = lmStudioProvider();
    await expect(provider.complete(userMsg)).rejects.toThrow(/LM Studio API error/);
  });

  it("maps finish_reason 'length' correctly", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "x" }, finish_reason: "length" }],
        usage: {},
      }),
    }) as unknown as typeof fetch;

    const provider = lmStudioProvider();
    const result = await provider.complete(userMsg);
    expect(result.finishReason).toBe("length");
  });

  it("maps an unrecognized finish_reason to 'error'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "x" }, finish_reason: "content_filter" }],
        usage: {},
      }),
    }) as unknown as typeof fetch;

    const provider = lmStudioProvider();
    const result = await provider.complete(userMsg);
    expect(result.finishReason).toBe("error");
  });
});

describe("LocalProvider — isAvailable()", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("checks /api/tags for the ollama sub-mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = ollamaProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/tags"));
  });

  it("checks /v1/models for the lmstudio sub-mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = lmStudioProvider();
    await provider.isAvailable();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v1/models"));
  });

  it("returns false when the server responds not-ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await ollamaProvider().isAvailable()).toBe(false);
  });

  it("returns false (not throw) when fetch itself throws (server not running)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(ollamaProvider().isAvailable()).resolves.toBe(false);
  });
});

describe("LocalProvider — getModels()", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses model names from /api/tags for ollama", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "a" }, { name: "b" }] }),
    }) as unknown as typeof fetch;
    expect(await ollamaProvider().getModels()).toEqual(["a", "b"]);
  });

  it("parses model ids from /v1/models for lmstudio", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "x" }, { id: "y" }] }),
    }) as unknown as typeof fetch;
    expect(await lmStudioProvider().getModels()).toEqual(["x", "y"]);
  });

  it("returns an empty array (not throw) when the request fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
    await expect(ollamaProvider().getModels()).resolves.toEqual([]);
  });
});

describe("LocalProvider — embed()", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses ollama.embeddings() for the ollama sub-mode", async () => {
    embeddingsMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    const result = await ollamaProvider().embed("some text");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(embeddingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "nomic-embed-text", prompt: "some text" }),
    );
  });

  it("posts to /v1/embeddings for the lmstudio sub-mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.4, 0.5] }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await lmStudioProvider().embed("some text");
    expect(result).toEqual([0.4, 0.5]);
  });

  it("throws a ProviderError when the ollama embeddings call fails", async () => {
    embeddingsMock.mockRejectedValue(new Error("model not found"));
    await expect(ollamaProvider().embed("x")).rejects.toThrow(/model not found/);
  });
});

describe("LocalProvider — countTokens/estimateCost/getDefaultModel", () => {
  it("countTokens estimates roughly 4 characters per token", () => {
    const provider = ollamaProvider();
    expect(provider.countTokens("a".repeat(400))).toBe(100);
  });

  it("estimateCost is always zero (local models are free)", () => {
    const provider = ollamaProvider();
    expect(provider.estimateCost(100000, 100000, "any-model")).toBe(0);
  });

  it("getDefaultModel returns the coder model for every task type", async () => {
    const provider = ollamaProvider();
    expect(await provider.getDefaultModel("simple")).toBe("qwen2.5-coder:latest");
    expect(await provider.getDefaultModel("code")).toBe("qwen2.5-coder:latest");
    expect(await provider.getDefaultModel("complex")).toBe("qwen2.5-coder:latest");
  });
});

describe("LocalProvider — stream()", () => {
  it("yields content chunks from the ollama stream, then a final done sentinel", async () => {
    async function* fakeStream() {
      yield { message: { content: "hel" } };
      yield { message: { content: "lo" } };
    }
    chatMock.mockResolvedValue(fakeStream());
    const provider = ollamaProvider();

    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of provider.stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo", ""]);
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it("forwards tools to the ollama streaming chat call in the correct shape", async () => {
    async function* fakeStream() {
      yield { message: { content: "ok" } };
    }
    chatMock.mockResolvedValue(fakeStream());
    const tools = [
      {
        name: "search",
        description: "search things",
        parameters: { type: "object" as const, properties: { q: { type: "string" } } },
      },
    ];
    for await (const _ of ollamaProvider().stream(userMsg, { tools } as CompletionOptions)) {
      // drain
    }
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        tools: [
          { type: "function", function: { name: "search", description: "search things", parameters: tools[0].parameters } },
        ],
      }),
    );
  });

  it("collects whole tool_calls entries from ollama stream chunks into toolCalls on the final chunk", async () => {
    async function* fakeStream() {
      yield {
        message: {
          content: "",
          tool_calls: [{ function: { name: "search", arguments: { q: "cats" } } }],
        },
      };
    }
    chatMock.mockResolvedValue(fakeStream());
    const chunks: Array<{ toolCalls?: unknown; done: boolean }> = [];
    for await (const chunk of ollamaProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    const last = chunks[chunks.length - 1];
    expect(last.done).toBe(true);
    expect(last.toolCalls).toEqual([{ name: "search", params: { q: "cats" } }]);
  });

  it("lmstudio stream parses SSE 'data:' lines and skips [DONE]", async () => {
    const encoder = new TextEncoder();
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}\n`,
      `data: [DONE]\n`,
    ].join("");

    let read = false;
    const reader = {
      read: async () => {
        if (read) return { done: true, value: undefined };
        read = true;
        return { done: false, value: encoder.encode(body) };
      },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    }) as unknown as typeof fetch;

    const provider = lmStudioProvider();
    const chunks: string[] = [];
    for await (const chunk of provider.stream(userMsg)) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks).toEqual(["a", "b"]);
    global.fetch = globalThis.fetch;
  });
});
