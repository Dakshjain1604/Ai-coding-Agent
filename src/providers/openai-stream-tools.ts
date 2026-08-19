/**
 * Shared tool-call delta accumulator for the OpenAI-compatible chat
 * completions streaming format (used by OpenAIProvider, GroqProvider,
 * OpenRouterProvider — all built on the same `openai` SDK client).
 *
 * Streamed tool calls arrive as partial fragments spread across many
 * chunks, keyed by `index` (one entry per parallel tool call the model is
 * building up): the `id` and `function.name` typically arrive whole on the
 * first fragment for that index, while `function.arguments` arrives as
 * incremental JSON-string slices that must be concatenated before parsing.
 */

import type OpenAI from "openai";
import type { ToolCall } from "../utils/types.js";

type DeltaToolCall =
  OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall;

export function accumulateOpenAIToolCallDeltas() {
  const byIndex = new Map<
    number,
    { id?: string; name: string; argsStr: string }
  >();

  return {
    absorb(deltas: DeltaToolCall[]): void {
      for (const d of deltas) {
        const existing = byIndex.get(d.index) ?? {
          id: undefined,
          name: "",
          argsStr: "",
        };
        if (d.id) existing.id = d.id;
        if (d.function?.name) existing.name += d.function.name;
        if (d.function?.arguments) existing.argsStr += d.function.arguments;
        byIndex.set(d.index, existing);
      }
    },

    finalize(): ToolCall[] | undefined {
      if (byIndex.size === 0) return undefined;
      const calls: ToolCall[] = [];
      for (const { id, name, argsStr } of byIndex.values()) {
        let params: Record<string, unknown> = {};
        try {
          params = argsStr ? JSON.parse(argsStr) : {};
        } catch {
          params = {};
        }
        calls.push({ id, name, params });
      }
      return calls;
    },
  };
}
