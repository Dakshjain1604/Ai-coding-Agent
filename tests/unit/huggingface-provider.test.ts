/**
 * Tests for HuggingFaceProvider (providers/HuggingFaceProvider.ts) —
 * previously zero coverage. No bug found in complete()/stream()/embed()
 * themselves; this locks in current behavior (including the honestly
 * reported functionCalling:false) so a future edit can't silently
 * regress it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HuggingFaceProvider } from "../../src/providers/HuggingFaceProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const fetchMock = vi.fn();

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function jsonResponse(body: unknown, ok = true, statusText = "OK") {
  return { ok, statusText, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HUGGINGFACE_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HUGGINGFACE_API_KEY;
});

function makeProvider(overrides?: Record<string, unknown>): HuggingFaceProvider {
  return new HuggingFaceProvider(overrides);
}

describe("HuggingFaceProvider — constructor", () => {
  it("throws a clear error when no API key is available", () => {
    delete process.env.HUGGINGFACE_API_KEY;
    expect(() => new HuggingFaceProvider()).toThrow(/API key/);
  });

  it("accepts an explicit apiKey in config", () => {
    delete process.env.HUGGINGFACE_API_KEY;
    expect(() => new HuggingFaceProvider({ apiKey: "explicit-key" })).not.toThrow();
  });

  it("defaults the model to meta-llama/Llama-3.2-3B-Instruct", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    await makeProvider().complete(userMsg);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("meta-llama/Llama-3.2-3B-Instruct");
  });

  it("uses a configured defaultModel override", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    await makeProvider({ defaultModel: "google/gemma-2-2b-it" }).complete(userMsg);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("google/gemma-2-2b-it");
  });
});

describe("HuggingFaceProvider — complete()", () => {
  it("sends the Authorization bearer header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    await makeProvider().complete(userMsg);
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe("Bearer test-key");
  });

  it("converts chat messages into a role-prefixed prompt", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    await makeProvider().complete([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "hi there" },
      { role: "assistant", content: "hello" },
    ]);
    const opts = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(opts.body);
    expect(body.inputs).toBe("System: Be helpful.\n\nUser: hi there\n\nAssistant: hello");
  });

  it("returns generated_text from an object response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hello world" }));
    const result = await makeProvider().complete(userMsg);
    expect(result.content).toBe("hello world");
  });

  it("returns generated_text from the first element of an array response", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ generated_text: "first" }, { generated_text: "second" }]));
    const result = await makeProvider().complete(userMsg);
    expect(result.content).toBe("first");
  });

  it("returns an empty string when generated_text is missing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const result = await makeProvider().complete(userMsg);
    expect(result.content).toBe("");
  });

  it("always reports finishReason 'stop' (HF inference API doesn't return one)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    const result = await makeProvider().complete(userMsg);
    expect(result.finishReason).toBe("stop");
  });

  it("estimates token usage from character counts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "a".repeat(40) }));
    const result = await makeProvider().complete(userMsg);
    expect(result.usage.outputTokens).toBe(10);
  });

  it("forwards maxTokens as max_new_tokens", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hi" }));
    await makeProvider().complete(userMsg, { maxTokens: 512 });
    const opts = fetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(opts.body).parameters.max_new_tokens).toBe(512);
  });

  it("throws a ProviderError when the HTTP response is not ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, "Service Unavailable"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/Service Unavailable/);
  });

  it("wraps a network-level rejection as a ProviderError", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(makeProvider().complete(userMsg)).rejects.toThrow(/network down/);
  });
});

describe("HuggingFaceProvider — stream()", () => {
  it("yields word-boundary chunks then a final done:true sentinel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generated_text: "hello world" }));
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks[chunks.length - 1]).toEqual({ content: "", done: true });
    expect(chunks.map((c) => c.content).join("")).toBe("hello world");
  });

  it("wraps a thrown error as a ProviderError", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, "Model Loading"));
    const provider = makeProvider();
    await expect(provider.stream(userMsg).next()).rejects.toThrow(/Model Loading/);
  });
});

describe("HuggingFaceProvider — isAvailable/getModels/estimateCost/embed/countTokens", () => {
  it("isAvailable() returns true when the models endpoint responds ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it("isAvailable() returns false when the models endpoint responds not-ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("isAvailable() returns false when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("dns failure"));
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it("getModels() returns the static supported-models list", async () => {
    const models = await makeProvider().getModels();
    expect(models).toContain("Qwen/Qwen2.5-Coder-3B-Instruct");
  });

  it("estimateCost() is always zero", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "meta-llama/Llama-3.2-3B-Instruct")).toBe(0);
  });

  it("embed() returns the raw embedding vector", async () => {
    fetchMock.mockResolvedValue(jsonResponse([0.1, 0.2, 0.3]));
    expect(await makeProvider().embed("text")).toEqual([0.1, 0.2, 0.3]);
  });

  it("embed() throws a ProviderError when the response is not ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, "Too Many Requests"));
    await expect(makeProvider().embed("text")).rejects.toThrow(/Too Many Requests/);
  });

  it("embed() wraps a thrown error as a ProviderError", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    await expect(makeProvider().embed("text")).rejects.toThrow(/timeout/);
  });

  it("countTokens estimates roughly 4 characters per token", () => {
    expect(makeProvider().countTokens("a".repeat(400))).toBe(100);
  });

  it("getCapabilities() honestly reports functionCalling:false", () => {
    expect(makeProvider().getCapabilities().functionCalling).toBe(false);
  });
});
