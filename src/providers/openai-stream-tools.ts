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

/**
 * Robust JSON parser for tool call arguments produced by LLMs.
 *
 * LLMs occasionally wrap arguments in markdown code blocks (```json ... ```)
 * or include surrounding text. This function safely extracts and parses the JSON.
 */
export function parseArgumentsJson(rawArgs: string): unknown {
  const trimmed = rawArgs.trim();
  if (trimmed === "") return {};

  try {
    return JSON.parse(trimmed);
  } catch (initialError) {
    // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // fall through
      }
    }

    // 2. Extract substring between first '{' and last '}' if surrounded by extraneous text
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }

    throw initialError;
  }
}

/**
 * Normalizes tool arguments to repair common model generation artifacts.
 *
 * Some models (GLM, Qwen, ChatGLM) use XML-style internal tool calling tokens
 * (<arg_key>key</arg_key><arg_value>value</arg_value>) that can inadvertently
 * leak into string parameter values when inlining arguments.
 * E.g., { command: "create<arg_key>path</arg_key><arg_value>/app/eigen.py", file_text: "..." }
 * This function extracts any inlined keys and restores the proper parameter map.
 */
export function normalizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...args };
  const tagRegex = /<arg_key>([\s\S]*?)<\/arg_key><arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g;

  for (const [key, val] of Object.entries(result)) {
    if (typeof val !== "string" || !val.includes("<arg_key>")) continue;
    const firstTag = val.indexOf("<arg_key>");
    result[key] = val.slice(0, firstTag);
    let match: RegExpExecArray | null;
    tagRegex.lastIndex = firstTag;
    while ((match = tagRegex.exec(val)) !== null) {
      const nestedKey = match[1].trim();
      let nestedVal = match[2];
      if (nestedVal.endsWith("</arg_value>")) {
        nestedVal = nestedVal.slice(0, -"</arg_value>".length);
      }
      result[nestedKey] = nestedVal;
    }
  }

  return result;
}

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
          const parsed = argsStr ? parseArgumentsJson(argsStr) : {};
          params =
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? normalizeArguments(parsed as Record<string, unknown>)
              : {};
        } catch {
          params = {};
        }
        calls.push({ id, name, params, rawArguments: argsStr });
      }
      return calls;
    },
  };
}
