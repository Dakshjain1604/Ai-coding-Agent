/**
 * Groq Provider - Fast inference with free tier
 * Groq offers free API access with impressive speed
 */

import OpenAI from "openai";
import type { CompletionOptions, StreamChunk } from "../utils/types.js";
import {
  BaseProvider,
  type ChatMessage,
  type CompletionResult,
  type ProviderCapabilities,
} from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";
import { accumulateOpenAIToolCallDeltas } from "./openai-stream-tools.js";

export interface GroqConfig {
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

/**
 * Groq's free tier enforces an 8000 TPM (tokens per minute) ceiling per
 * model that — per live testing — counts the reserved `max_tokens` output
 * budget together with the input prompt against the SAME 8000 total, not
 * as separate input/output budgets. Callers upstream (BaseAgent) size
 * `maxTokens` from SystemAnalyzer's LOCAL machine capacity (up to 64000 on
 * an "optimal" machine), which has nothing to do with Groq's own
 * account-level quota — a request built from that local sizing alone can
 * reserve the model's entire per-minute budget before a single input
 * token is counted, failing with 413 "Request too large" even for a
 * trivially small prompt. Clamp here, not in SystemAnalyzer, since this
 * ceiling is a fact about Groq specifically, not about local resources.
 */
const FREE_TIER_MAX_OUTPUT_TOKENS = 2048;

function clampMaxTokens(requested?: number): number {
  return Math.min(requested ?? 4096, FREE_TIER_MAX_OUTPUT_TOKENS);
}

export class GroqProvider extends BaseProvider {
  private client: OpenAI;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: GroqConfig) {
    super("groq", config);

    const apiKey = config?.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new ProviderError("Groq API key not provided", "groq", {
        hint: "Get free API key at https://console.groq.com",
      });
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });

    this.defaultModel = config?.defaultModel ?? "openai/gpt-oss-20b";
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: false,
      functionCalling: true,
      vision: false,
      maxContextLength: 128000,
      supportedModels: [
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.6-27b",
        "groq/compound",
        "groq/compound-mini",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;

    try {
      // Groq's API is OpenAI-compatible and supports native tool calling
      // (this client IS the OpenAI SDK) — this used to never forward
      // `tools` or parse `tool_calls` back at all, despite getCapabilities()
      // already (incorrectly) claiming functionCalling: true. Groq is one
      // of ModelRouter's two primary free-tier fallback providers, so this
      // silently forced every Groq-routed task onto the strictly more
      // fragile text-based ```tool block parser instead of the reliable
      // native mechanism Claude/OpenAI already get to use.
      const groqTools = options?.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const response = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        max_tokens: clampMaxTokens(options?.maxTokens),
        stream: false,
        tools: groqTools && groqTools.length > 0 ? groqTools : undefined,
        // Explicit "auto" rather than leaving tool_choice unset — Groq's
        // reasoning ("harmony"-format) models are documented to sometimes
        // mishandle an implicit default, occasionally producing a tool
        // call the server itself then rejects with "Tool choice is none,
        // but model called a tool" (confirmed live during real-task
        // testing). Only relevant when tools are actually being offered.
        tool_choice:
          groqTools && groqTools.length > 0 ? "auto" : undefined,
      });

      const choice = response.choices[0];

      const toolCalls = choice.message.tool_calls?.map((tc) => {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments);
        } catch {
          params = {};
        }
        return { id: tc.id, name: tc.function.name, params };
      });

      return {
        content: choice.message.content ?? "",
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
        model: response.model,
        finishReason: this.mapFinishReason(choice.finish_reason),
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      throw new ProviderError(
        `Groq API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "groq",
        { model },
      );
    }
  }

  private mapFinishReason(
    reason: string | null | undefined,
  ): "stop" | "length" | "error" | "tool_calls" {
    if (reason === "stop") return "stop";
    if (reason === "length") return "length";
    if (reason === "tool_calls") return "tool_calls";
    return "error";
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel;

    try {
      const groqTools = options?.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const response = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        max_tokens: clampMaxTokens(options?.maxTokens),
        stream: true,
        tools: groqTools && groqTools.length > 0 ? groqTools : undefined,
        // See the same field in complete() above for why this is explicit.
        tool_choice:
          groqTools && groqTools.length > 0 ? "auto" : undefined,
      });

      const toolCalls = accumulateOpenAIToolCallDeltas();

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield {
            content: delta.content,
            done: false,
          };
        }
        if (delta?.tool_calls) {
          toolCalls.absorb(delta.tool_calls);
        }
      }

      yield { content: "", done: true, toolCalls: toolCalls.finalize() };
    } catch (error) {
      throw new ProviderError(
        `Groq streaming error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "groq",
        { model },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    throw new ProviderError("Embeddings not supported for Groq", "groq", {});
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    return this.getCapabilities().supportedModels;
  }

  estimateCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): number {
    const rates: Record<string, { input: number; output: number }> = {
      "openai/gpt-oss-120b": { input: 0, output: 0 },
      "openai/gpt-oss-20b": { input: 0, output: 0 },
      "qwen/qwen3.6-27b": { input: 0, output: 0 },
    };
    const rate = rates[model] ?? { input: 0, output: 0 };
    return (
      (inputTokens / 1_000_000) * rate.input +
      (outputTokens / 1_000_000) * rate.output
    );
  }

  private convertMessages(
    messages: ChatMessage[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
    }));
  }
}
