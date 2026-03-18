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
  type UsageStats,
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

    this.defaultModel = config?.defaultModel ?? "llama-3.3-70b-versatile";
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
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "llama-3.1-8b-instant",
        "llama3-70b-8192",
        "llama3-8b-8192",
        "mixtral-8x7b-32768",
        "gemma2-9b-it",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens ?? 4096,
        stream: false,
      });

      const choice = response.choices[0];
      return {
        content: choice.message.content ?? "",
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
        model: response.model,
        finishReason: choice.finish_reason as "stop" | "length",
      };
    } catch (error) {
      throw new ProviderError(
        `Groq API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "groq",
        { model },
      );
    }
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
      "llama-3.3-70b-versatile": { input: 0, output: 0 },
      "llama-3.1-70b-versatile": { input: 0, output: 0 },
      "llama-3.1-8b-instant": { input: 0, output: 0 },
      "mixtral-8x7b-32768": { input: 0, output: 0 },
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
