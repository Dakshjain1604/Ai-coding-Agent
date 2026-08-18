/**
 * OpenRouter Provider - Access to free and paid models
 * OpenRouter aggregates many providers with free tier access
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

export interface OpenRouterConfig {
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

export class OpenRouterProvider extends BaseProvider {
  private client: OpenAI;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: OpenRouterConfig) {
    super("openrouter", config);

    const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new ProviderError("OpenRouter API key not provided", "openrouter", {
        hint: "Get free API key at https://openrouter.ai/settings",
      });
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    this.defaultModel = config?.defaultModel ?? "google/gemma-2-9b-8192-it";
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
      embeddings: true,
      functionCalling: true,
      vision: true,
      maxContextLength: 128000,
      supportedModels: [
        // Free models
        "google/gemma-2-9b-8192-it",
        "google/gemma-2-27b-it",
        "meta-llama/llama-3.1-8b-instruct",
        "meta-llama/llama-3.1-70b-instruct",
        "mistralai/mistral-7b-instruct",
        "deepseek/deepseek-chat",
        // Paid models (also available)
        "openai/gpt-4o",
        "anthropic/claude-3.5-sonnet",
        "google/gemini-pro-1.5",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;

    try {
      // OpenRouter's API is OpenAI-compatible and most of its models
      // support native tool calling (this client IS the OpenAI SDK) —
      // this used to never forward `tools` or parse `tool_calls` back at
      // all, despite getCapabilities() already (incorrectly) claiming
      // functionCalling: true. OpenRouter is one of ModelRouter's two
      // primary free-tier fallback providers, so this silently forced
      // every OpenRouter-routed task onto the strictly more fragile
      // text-based ```tool block parser instead of the reliable native
      // mechanism Claude/OpenAI already get to use.
      const openRouterTools = options?.tools?.map((t) => ({
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
        tools: openRouterTools && openRouterTools.length > 0 ? openRouterTools : undefined,
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
        `OpenRouter API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "openrouter",
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
        `OpenRouter streaming error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "openrouter",
        { model },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    // OpenRouter supports embeddings through their API
    throw new ProviderError(
      "Use provider-specific embedding API",
      "openrouter",
      {},
    );
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
    // Free models on OpenRouter
    const freeModels = [
      "google/gemma-2-9b-8192-it",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-7b-instruct",
    ];
    if (freeModels.includes(model)) {
      return 0;
    }
    // Paid models - use approximate rates
    return ((inputTokens + outputTokens) / 1_000_000) * 0.5;
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
