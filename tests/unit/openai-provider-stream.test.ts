/**
 * Tests for OpenAIProvider.stream() — previously zero coverage for the
 * streaming path. complete() already forwarded CompletionOptions.tools
 * and parsed tool_calls back; stream() never forwarded tools at all and
 * never accumulated the incremental delta.tool_calls fragments the
 * OpenAI streaming API sends, unlike the non-streaming path. Since
 * UniversalAgent streams by default (defaults.streaming = true), this
 * meant native tool calling never worked for OpenAI in default usage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "../../src/providers/OpenAIProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL = "https://api.openai.com/v1";
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
    }
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

beforeEach(() => {
  createMock.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider();
}

describe("OpenAIProvider — stream()", () => {
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
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo", ""]);
    expect(chunks[chunks.length - 1].done).toBe(true);
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

  it("does not send a tools field on the streaming request when no tools are requested", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    createMock.mockResolvedValue(fakeStream());
    for await (const _ of makeProvider().stream(userMsg)) {
      // drain
    }
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
  });
});
