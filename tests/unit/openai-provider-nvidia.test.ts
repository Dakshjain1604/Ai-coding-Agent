/**
 * Tests for OpenAIProvider's NVIDIA fallback mode (NVIDIA_API_KEY set,
 * OPENAI_API_KEY absent — routes to integrate.api.nvidia.com instead of
 * OpenAI's own endpoint). Confirmed live against NVIDIA's real API with
 * this codebase's real tool schemas:
 *  - The previous default model, "meta/llama-3.3-70b-instruct", hangs
 *    indefinitely (100s+, no response) — never actually reachable.
 *  - Tool calling was previously disabled outright for NVIDIA
 *    (`!isNvidia ? options?.tools... : undefined`) on the assumption it
 *    isn't supported — false: "z-ai/glm-5.2", "meta/llama-3.1-70b-
 *    instruct", and "meta/llama-3.1-8b-instruct" all return correct,
 *    well-formed native tool_calls.
 *  - estimateCost() previously fell through to GPT-4o's real paid pricing
 *    for genuinely free NVIDIA usage (no NVIDIA model IDs were in the
 *    pricing table).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../../src/providers/OpenAIProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(config: { apiKey: string; baseURL?: string }) {
      this.apiKey = config.apiKey;
      this.baseURL = config.baseURL ?? "https://api.openai.com/v1";
    }
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

function chatCompletion(overrides?: Record<string, unknown>) {
  return {
    id: "x",
    model: "z-ai/glm-5.2",
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

beforeEach(() => {
  createMock.mockReset();
  delete process.env.OPENAI_API_KEY;
  process.env.NVIDIA_API_KEY = "test-nvidia-key";
});

afterEach(() => {
  delete process.env.NVIDIA_API_KEY;
});

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider();
}

describe("OpenAIProvider — NVIDIA fallback mode", () => {
  it("uses a confirmed-working default model, not the previously-hanging 'meta/llama-3.3-70b-instruct'", async () => {
    createMock.mockResolvedValue(chatCompletion());
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].model).not.toBe(
      "meta/llama-3.3-70b-instruct",
    );
    expect(createMock.mock.calls[0][0].model).toBe("z-ai/glm-5.2");
  });

  it("forwards tools on complete() for NVIDIA (previously disabled outright)", async () => {
    createMock.mockResolvedValue(chatCompletion());
    const tools = [
      {
        name: "file_write",
        description: "Write a file",
        parameters: { type: "object" as const, properties: { path: { type: "string" } } },
      },
    ];
    await makeProvider().complete(userMsg, { tools });
    expect(createMock.mock.calls[0][0].tools).toEqual([
      {
        type: "function",
        function: { name: "file_write", description: "Write a file", parameters: tools[0].parameters },
      },
    ]);
  });

  it("forwards tools on stream() for NVIDIA (previously disabled outright)", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    const tools = [
      {
        name: "file_write",
        description: "Write a file",
        parameters: { type: "object" as const, properties: { path: { type: "string" } } },
      },
    ];
    for await (const _ of makeProvider().stream(userMsg, { tools })) {
      // drain
    }
    expect(createMock.mock.calls[0][0].tools).toEqual([
      {
        type: "function",
        function: { name: "file_write", description: "Write a file", parameters: tools[0].parameters },
      },
    ]);
  });

  it("estimateCost() is zero for NVIDIA (previously fell through to GPT-4o's real paid pricing)", () => {
    expect(makeProvider().estimateCost(1_000_000, 1_000_000, "z-ai/glm-5.2")).toBe(0);
  });

  it("getCapabilities() reports NVIDIA models, not OpenAI's own model list", () => {
    const caps = makeProvider().getCapabilities();
    expect(caps.supportedModels).toContain("z-ai/glm-5.2");
    expect(caps.supportedModels).not.toContain("gpt-4o");
  });

  it("getDefaultModel() returns valid NVIDIA model ids, not OpenAI-only ones like 'o1-preview'", async () => {
    const provider = makeProvider();
    expect(await provider.getDefaultModel("simple")).toBe("meta/llama-3.1-8b-instruct");
    expect(await provider.getDefaultModel("complex")).toBe("meta/llama-3.1-70b-instruct");
  });

  it("embed() throws an honest NVIDIA-specific error instead of attempting a mismatched OpenAI-shaped call", async () => {
    await expect(makeProvider().embed("text")).rejects.toThrow(/NVIDIA/);
  });

  it("does NOT enter NVIDIA mode when OPENAI_API_KEY is also set", async () => {
    process.env.OPENAI_API_KEY = "sk-real-key";
    createMock.mockResolvedValue(chatCompletion({ model: "gpt-4o" }));
    await makeProvider().complete(userMsg);
    expect(createMock.mock.calls[0][0].model).toBe("gpt-4o");
    delete process.env.OPENAI_API_KEY;
  });
});
