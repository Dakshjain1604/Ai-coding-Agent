/**
 * Tests for GeminiProvider (providers/GeminiProvider.ts) — previously
 * zero coverage.
 *
 * Centerpiece regression: complete() never forwarded CompletionOptions.
 * tools to Gemini's native function-calling API (a `tools:
 * [{functionDeclarations}]` request field) and never read the response's
 * `functionCalls()` helper — despite getCapabilities() already
 * (incorrectly) claiming `functionCalling: true`. Same bug class found
 * across LocalProvider/GroqProvider/OpenRouterProvider this phase.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../../src/providers/GeminiProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const generateContentMock = vi.fn();
const generateContentStreamMock = vi.fn();
const embedContentMock = vi.fn();
const getGenerativeModelMock = vi.fn();

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel(config: unknown) {
      getGenerativeModelMock(config);
      return {
        generateContent: (...args: unknown[]) => generateContentMock(...args),
        generateContentStream: (...args: unknown[]) => generateContentStreamMock(...args),
        embedContent: (...args: unknown[]) => embedContentMock(...args),
      };
    }
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function geminiResult(overrides?: Record<string, unknown>) {
  return {
    response: {
      text: () => "hi there",
      functionCalls: () => undefined,
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      candidates: [{ finishReason: "STOP" }],
      ...overrides,
    },
  };
}

beforeEach(() => {
  generateContentMock.mockReset();
  generateContentStreamMock.mockReset();
  embedContentMock.mockReset();
  getGenerativeModelMock.mockReset();
  process.env.GOOGLE_API_KEY = "test-key";
});

function makeProvider(): GeminiProvider {
  return new GeminiProvider();
}

describe("GeminiProvider — constructor", () => {
  it("throws a clear error when no API key is available", () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiProvider()).toThrow(/API key/);
  });

  it("accepts GEMINI_API_KEY as a fallback env var", () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    expect(() => new GeminiProvider()).not.toThrow();
    delete process.env.GEMINI_API_KEY;
  });
});

describe("GeminiProvider — native tool-calling fix", () => {
  it("forwards tools as a functionDeclarations block to getGenerativeModel", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
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

    const config = getGenerativeModelMock.mock.calls[0][0];
    expect(config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "file_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
      },
    ]);
  });

  it("does not send a tools field when no tools are requested", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
    await makeProvider().complete(userMsg);
    const config = getGenerativeModelMock.mock.calls[0][0];
    expect(config.tools).toBeUndefined();
  });

  it("does not send a tools field for an empty tools array", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
    await makeProvider().complete(userMsg, { tools: [] });
    expect(getGenerativeModelMock.mock.calls[0][0].tools).toBeUndefined();
  });

  it("parses functionCalls() into CompletionResult.toolCalls", async () => {
    generateContentMock.mockResolvedValue(
      geminiResult({ functionCalls: () => [{ name: "file_read", args: { path: "x.ts" } }] }),
    );
    const provider = makeProvider();
    const result = await provider.complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.toolCalls).toEqual([{ name: "file_read", params: { path: "x.ts" } }]);
  });

  it("parses multiple function calls in one response", async () => {
    generateContentMock.mockResolvedValue(
      geminiResult({
        functionCalls: () => [
          { name: "file_read", args: { path: "a.ts" } },
          { name: "file_read", args: { path: "b.ts" } },
        ],
      }),
    );
    const result = await makeProvider().complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.toolCalls?.length).toBe(2);
  });

  it("sets finishReason to 'tool_calls' when function calls are present, overriding the raw finishReason", async () => {
    generateContentMock.mockResolvedValue(
      geminiResult({
        functionCalls: () => [{ name: "file_read", args: {} }],
        candidates: [{ finishReason: "STOP" }],
      }),
    );
    const result = await makeProvider().complete(userMsg, {
      tools: [{ name: "file_read", description: "x", parameters: { type: "object", properties: {} } }],
    });
    expect(result.finishReason).toBe("tool_calls");
  });

  it("leaves toolCalls undefined when functionCalls() returns undefined", async () => {
    generateContentMock.mockResolvedValue(geminiResult({ functionCalls: () => undefined }));
    const result = await makeProvider().complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe("stop");
  });

  it("leaves toolCalls undefined when functionCalls() returns an empty array", async () => {
    generateContentMock.mockResolvedValue(geminiResult({ functionCalls: () => [] }));
    const result = await makeProvider().complete(userMsg);
    expect(result.toolCalls).toBeUndefined();
  });
});

describe("GeminiProvider — complete() general behavior", () => {
  it("maps usage stats correctly", async () => {
    generateContentMock.mockResolvedValue(
      geminiResult({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } }),
    );
    const result = await makeProvider().complete(userMsg);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("maps finishReason MAX_TOKENS to 'length'", async () => {
    generateContentMock.mockResolvedValue(geminiResult({ candidates: [{ finishReason: "MAX_TOKENS" }] }));
    const result = await makeProvider().complete(userMsg);
    expect(result.finishReason).toBe("length");
  });

  it("maps an unrecognized finishReason to 'error'", async () => {
    generateContentMock.mockResolvedValue(geminiResult({ candidates: [{ finishReason: "SAFETY" }] }));
    const result = await makeProvider().complete(userMsg);
    expect(result.finishReason).toBe("error");
  });

  it("wraps a thrown error as a ProviderError", async () => {
    generateContentMock.mockRejectedValue(new Error("quota exceeded"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/quota exceeded/);
  });

  it("separates a system message into systemInstruction rather than contents", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
    await makeProvider().complete([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ]);
    const call = generateContentMock.mock.calls[0][0];
    expect(call.systemInstruction).toBe("You are helpful.");
    expect(call.contents.length).toBe(1);
  });

  it("maps 'assistant' role to Gemini's 'model' role", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
    await makeProvider().complete([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const call = generateContentMock.mock.calls[0][0];
    expect(call.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model"]);
  });
});

describe("GeminiProvider — isAvailable/getModels/estimateCost/embed/getDefaultModel", () => {
  it("isAvailable() returns true when generateContent succeeds", async () => {
    generateContentMock.mockResolvedValue(geminiResult());
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when generateContent throws", async () => {
    generateContentMock.mockRejectedValue(new Error("invalid key"));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("getModels() returns the static supported-models list", async () => {
    const models = await makeProvider().getModels();
    expect(models).toContain("gemini-2.0-flash");
  });

  it("estimateCost() is proportional to token counts for a known model", () => {
    const provider = makeProvider();
    const small = provider.estimateCost(1_000_000, 0, "gemini-2.0-pro");
    const large = provider.estimateCost(2_000_000, 0, "gemini-2.0-pro");
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("estimateCost() falls back to flash pricing for an unrecognized model", () => {
    const provider = makeProvider();
    expect(provider.estimateCost(1_000_000, 0, "unknown-model")).toBe(
      provider.estimateCost(1_000_000, 0, "gemini-2.0-flash"),
    );
  });

  it("embed() returns the embedding values", async () => {
    embedContentMock.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
    expect(await makeProvider().embed("text")).toEqual([0.1, 0.2]);
  });

  it("embed() wraps a thrown error as a ProviderError", async () => {
    embedContentMock.mockRejectedValue(new Error("embedding failed"));
    await expect(makeProvider().embed("text")).rejects.toThrow(/embedding failed/);
  });

  it("getDefaultModel() returns the pro model for complex tasks", async () => {
    expect(await makeProvider().getDefaultModel("complex")).toBe("gemini-2.0-pro");
  });

  it("getDefaultModel() returns the flash model for simple tasks", async () => {
    expect(await makeProvider().getDefaultModel("simple")).toBe("gemini-2.0-flash");
  });
});

describe("GeminiProvider — stream()", () => {
  it("yields text chunks then a final done sentinel", async () => {
    async function* fakeStream() {
      yield { text: () => "hel" };
      yield { text: () => "lo" };
    }
    generateContentStreamMock.mockResolvedValue({ stream: fakeStream() });
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo", ""]);
    expect(chunks[chunks.length - 1].done).toBe(true);
  });
});
