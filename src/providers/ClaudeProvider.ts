/**
 * Claude Provider - Anthropic Claude API implementation
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionOptions,
  StreamChunk,
  ProviderType,
} from "../utils/types.js";
import {
  BaseProvider,
  type ChatMessage,
  type ContentBlock,
  type CompletionResult,
  type UsageStats,
  type ProviderCapabilities,
} from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";

export interface ClaudeConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxRetries?: number;
  [key: string]: unknown;
}

export class ClaudeProvider extends BaseProvider {
  private client: Anthropic;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: ClaudeConfig) {
    super("claude", config);

    const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderError("Claude API key not provided", "claude", {
        hint: "Set ANTHROPIC_API_KEY environment variable",
      });
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config?.baseUrl,
      maxRetries: config?.maxRetries ?? 3,
    });

    this.defaultModel = config?.defaultModel ?? "claude-sonnet-4-6";
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Try to make a minimal API call
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: false, // Claude doesn't have a native embedding API
      functionCalling: true,
      vision: true,
      maxContextLength: 200000,
      supportedModels: [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
        "claude-3-sonnet-20240229",
        "claude-3-haiku-20240307",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 4096;

    this.logger.providerCall("claude", model);

    try {
      const systemMessage = messages.find((m) => m.role === "system");
      const otherMessages = messages.filter((m) => m.role !== "system");

      const claudeTools = options?.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object" as const,
          properties: t.parameters.properties || {},
          required: t.parameters.required,
        },
      }));

      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemMessage?.content as string | undefined,
        messages: this.convertMessages(otherMessages),
        temperature: options?.temperature,
        top_p: options?.topP,
        stop_sequences: options?.stopSequences,
        tools: claudeTools && claudeTools.length > 0 ? claudeTools : undefined,
      });

      const content = response.content
        .filter(
          (block): block is Anthropic.TextBlock => block.type === "text",
        )
        .map((block) => block.text)
        .join("");

      const toolCalls = response.content
        .filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          params: (block.input || {}) as Record<string, unknown>,
        }));

      let finishReason: "stop" | "length" | "error" | "tool_calls" = "stop";
      if (response.stop_reason === "tool_use" || (toolCalls && toolCalls.length > 0)) {
        finishReason = "tool_calls";
      } else if (response.stop_reason === "max_tokens") {
        finishReason = "length";
      }

      return {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
        model: response.model,
        finishReason,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      throw new ProviderError(
        `Claude API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "claude",
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

    this.logger.providerCall("claude", model);

    const systemMessage = messages.find((m) => m.role === "system");
    const otherMessages = messages.filter((m) => m.role !== "system");

    const stream = this.client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemMessage?.content as string | undefined,
      messages: this.convertMessages(otherMessages),
      temperature: options?.temperature,
      top_p: options?.topP,
      stop_sequences: options?.stopSequences,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield {
          content: event.delta.text,
          done: false,
        };
      }
    }

    yield { content: "", done: true };
  }

  async embed(_text: string): Promise<number[]> {
    // Claude doesn't provide embeddings API
    // Use a fallback or throw an error
    throw new ProviderError(
      "Claude does not provide an embeddings API",
      "claude",
      { hint: "Use a different provider for embeddings" },
    );
  }

  countTokens(text: string): number {
    // Rough approximation - Claude uses similar tokenization to GPT
    // For accurate counting, use tiktoken or Claude's tokenizer
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    return this.getCapabilities().supportedModels;
  }

  async getDefaultModel(
    taskType: "simple" | "code" | "complex",
  ): Promise<string> {
    const modelMap: Record<string, string> = {
      simple: "claude-haiku-4-5-20251001",
      code: "claude-sonnet-4-6",
      complex: "claude-opus-4-6",
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
      "claude-opus-4-6": { input: 15, output: 75 },
      "claude-sonnet-4-6": { input: 3, output: 15 },
      "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
      "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
      "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
      "claude-3-opus-20240229": { input: 15, output: 75 },
      "claude-3-sonnet-20240229": { input: 3, output: 15 },
      "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
    };

    const price = pricing[model] ?? pricing["claude-sonnet-4-6"];
    return (
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output
    );
  }

  private convertMessages(
    messages: ChatMessage[],
  ): Anthropic.Messages.MessageParam[] {
    return messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: this.convertContent(msg.content),
    })) as Anthropic.Messages.MessageParam[];
  }

  private convertContent(content: string | ContentBlock[]): string | unknown {
    if (typeof content === "string") {
      return content;
    }

    return content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text ?? "" };
      }
      if (block.type === "image" && block.source) {
        return {
          type: "image" as const,
          source: {
            type: block.source.type,
            media_type: block.source.media_type ?? "image/jpeg",
            data: block.source.data ?? "",
          },
        };
      }
      return { type: "text" as const, text: "" };
    });
  }
}
