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

export interface GroqConfig {
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
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
        max_tokens: options?.maxTokens ?? 4096,
        stream: false,
        tools: groqTools && groqTools.length > 0 ? groqTools : undefined,
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
      const response = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
      });

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield {
            content: delta.content,
            done: false,
          };
        }
      }
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
