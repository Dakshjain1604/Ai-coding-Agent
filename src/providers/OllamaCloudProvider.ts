/**
 * OllamaCloud Provider - Connect to any OpenAI-compatible cloud endpoint
 * Use this to connect to cloud services that expose Ollama-compatible APIs
 * Examples: Cloudflare Workers AI, Azure AI, custom endpoints, etc.
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

export interface OllamaCloudConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

export class OllamaCloudProvider extends BaseProvider {
  private client: OpenAI;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: OllamaCloudConfig) {
    super("ollama-cloud", config ?? {});

    const cfg = config ?? {};

    if (!cfg.baseUrl) {
      throw new ProviderError(
        "OllamaCloud baseUrl is required",
        "ollama-cloud",
        {
          hint: "Provide the base URL for the OpenAI-compatible endpoint",
        },
      );
    }

    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
    });

    this.defaultModel = cfg.defaultModel ?? "llama3.2";
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
      functionCalling: false,
      vision: false,
      maxContextLength: 128000,
      supportedModels: [
        "llama3.2",
        "llama3.1",
        "mistral",
        "codellama",
        "phi3",
        "gemma",
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
        `OllamaCloud API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama-cloud",
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
        `OllamaCloud streaming error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama-cloud",
        { model },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    throw new ProviderError(
      "Use provider-specific embedding API",
      "ollama-cloud",
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
    return 0;
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
