/**
 * OpenAI Provider - OpenAI API implementation
 */

import OpenAI from "openai";
import type { CompletionOptions, StreamChunk } from "../utils/types.js";
import {
  BaseProvider,
  type ChatMessage,
  type ContentBlock,
  type CompletionResult,
  type ProviderCapabilities,
} from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  organization?: string;
  [key: string]: unknown;
}

export class OpenAIProvider extends BaseProvider {
  private client: OpenAI;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: OpenAIConfig) {
    super("openai", config);

    const isNvidia =
      !config?.apiKey &&
      !process.env.OPENAI_API_KEY &&
      (Boolean(process.env.NVIDIA_API_KEY) || Boolean(process.env.NVAPI_KEY));

    const apiKey =
      config?.apiKey ??
      process.env.OPENAI_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      process.env.NVAPI_KEY;

    if (!apiKey) {
      throw new ProviderError("API key not provided", "openai", {
        hint: "Set OPENAI_API_KEY or NVIDIA_API_KEY environment variable",
      });
    }

    const baseURL =
      config?.baseUrl ??
      (isNvidia ? "https://integrate.api.nvidia.com/v1" : undefined);

    this.client = new OpenAI({
      apiKey,
      baseURL,
      organization: config?.organization,
    });

    this.defaultModel =
      config?.defaultModel ??
      (isNvidia ? "meta/llama-3.3-70b-instruct" : "gpt-4o");
  }

  async isAvailable(): Promise<boolean> {
    if (this.client.apiKey) return true;
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
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
        "o1-preview",
        "o1-mini",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 4096;

    this.logger.providerCall("openai", model);

    try {
      const isNvidia = this.client.baseURL.includes("nvidia");
      const openAiTools = !isNvidia ? options?.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })) : undefined;

      const response = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        top_p: options?.topP,
        stop: options?.stopSequences,
        tools: openAiTools && openAiTools.length > 0 ? openAiTools : undefined,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new ProviderError("No completion choice returned", "openai");
      }

      const toolCalls = choice.message.tool_calls?.map((tc) => {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments);
        } catch {
          params = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          params,
        };
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
        `OpenAI API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "openai",
        { error },
      );
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 4096;

    this.logger.providerCall("openai", model);

    const stream = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: this.convertMessages(messages),
      temperature: options?.temperature,
      top_p: options?.topP,
      stop: options?.stopSequences,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield { content, done: false };
      }
    }

    yield { content: "", done: true };
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      throw new ProviderError(
        `OpenAI embedding error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "openai",
        { error },
      );
    }
  }

  countTokens(text: string): number {
    // Rough approximation
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    return this.getCapabilities().supportedModels;
  }

  async getDefaultModel(
    taskType: "simple" | "code" | "complex",
  ): Promise<string> {
    const modelMap: Record<string, string> = {
      simple: "gpt-4o-mini",
      code: "gpt-4o",
      complex: "o1-preview",
    };
    return modelMap[taskType] ?? this.defaultModel;
  }

  estimateCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): number {
    // Pricing per million tokens (as of 2024)
    const pricing: Record<string, { input: number; output: number }> = {
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
      "gpt-4-turbo": { input: 10, output: 30 },
      "gpt-4": { input: 30, output: 60 },
      "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
      "o1-preview": { input: 15, output: 60 },
      "o1-mini": { input: 3, output: 12 },
    };

    const price = pricing[model] ?? pricing["gpt-4o"];
    return (
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output
    );
  }

  private convertMessages(
    messages: ChatMessage[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === "system") {
        return { role: "system" as const, content: msg.content as string };
      }
      if (typeof msg.content === "string") {
        return { role: msg.role, content: msg.content };
      }
      // Handle multimodal content
      return {
        role: msg.role,
        content: this.convertContentBlocks(msg.content),
      };
    }) as OpenAI.Chat.ChatCompletionMessageParam[];
  }

  private convertContentBlocks(
    blocks: ContentBlock[],
  ): OpenAI.Chat.ChatCompletionContentPart[] {
    return blocks.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text ?? "" };
      }
      if (block.type === "image" && block.source) {
        return {
          type: "image_url" as const,
          image_url: {
            url: block.source.url ?? "",
            detail: "auto" as const,
          },
        };
      }
      return { type: "text" as const, text: "" };
    });
  }

  private mapFinishReason(
    reason: string | null | undefined,
  ): "stop" | "length" | "error" | "tool_calls" {
    if (reason === "stop") return "stop";
    if (reason === "length") return "length";
    if (reason === "tool_calls") return "tool_calls";
    return "error";
  }
}
