/**
 * Tests for ClaudeProvider.stream() — previously zero coverage for the
 * streaming path. complete() already forwarded CompletionOptions.tools
 * and parsed tool_use blocks back; stream() never forwarded tools and
 * never accumulated the incremental input_json_delta fragments Claude's
 * streaming API sends for tool_use blocks. Since UniversalAgent streams
 * by default (defaults.streaming = true), this meant native tool calling
 * never worked for Claude in default usage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "../../src/providers/ClaudeProvider.js";
import type { ChatMessage } from "../../src/providers/ProviderInterface.js";

const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { stream: (...args: unknown[]) => streamMock(...args) };
    constructor(_config: unknown) {}
  },
}));

const userMsg: ChatMessage[] = [{ role: "user", content: "hello" }];

beforeEach(() => {
  streamMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function makeProvider(): ClaudeProvider {
  return new ClaudeProvider();
}

describe("ClaudeProvider — stream()", () => {
  it("yields text deltas then a final done sentinel", async () => {
    async function* fakeStream() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
    }
    streamMock.mockReturnValue(fakeStream());
    const chunks: Array<{ content: string; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.content)).toEqual(["hel", "lo", ""]);
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it("forwards tools to the streaming request in Claude tool shape", async () => {
    async function* fakeStream() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
    }
    streamMock.mockReturnValue(fakeStream());
    const tools = [
      {
        name: "search",
        description: "search things",
        parameters: { type: "object" as const, properties: { q: { type: "string" } }, required: ["q"] },
      },
    ];
    for await (const _ of makeProvider().stream(userMsg, { tools })) {
      // drain
    }
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            name: "search",
            description: "search things",
            input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
        ],
      }),
    );
  });

  it("accumulates input_json_delta fragments across content_block_start/delta/stop into a completed toolCalls array", async () => {
    async function* fakeStream() {
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "search", input: {} },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"cats"}' },
      };
      yield { type: "content_block_stop", index: 0 };
    }
    streamMock.mockReturnValue(fakeStream());
    const chunks: Array<{ toolCalls?: unknown; done: boolean }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    const last = chunks[chunks.length - 1];
    expect(last.done).toBe(true);
    expect(last.toolCalls).toEqual([{ id: "call_1", name: "search", params: { q: "cats" } }]);
  });

  it("leaves toolCalls undefined on the final chunk when no tool_use blocks were streamed", async () => {
    async function* fakeStream() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain" } };
    }
    streamMock.mockReturnValue(fakeStream());
    const chunks: Array<{ toolCalls?: unknown }> = [];
    for await (const chunk of makeProvider().stream(userMsg)) {
      chunks.push(chunk);
    }
    expect(chunks[chunks.length - 1].toolCalls).toBeUndefined();
  });
});
