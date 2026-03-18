/**
 * Local Provider - Ollama and local LLM implementation
 * Free, local-first option using Ollama or LM Studio
 */

import ollama from "ollama";
import type { CompletionOptions, StreamChunk } from "../utils/types.js";
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

export interface LocalConfig {
  baseUrl?: string;
  defaultModel?: string;
  provider?: "ollama" | "lmstudio";
  [key: string]: unknown;
}

export class LocalProvider extends BaseProvider {
  private baseUrl: string;
  private defaultModel: string;
  private provider: "ollama" | "lmstudio";
  private logger = getLogger();

  constructor(config?: LocalConfig) {
    super("local", config);

    this.baseUrl = config?.baseUrl ?? "http://localhost:11434";
    this.provider = config?.provider ?? "ollama";
    this.defaultModel = config?.defaultModel ?? "qwen2.5-coder:latest";
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (this.provider === "ollama") {
        const response = await fetch(`${this.baseUrl}/api/tags`);
        return response.ok;
      }
      // LM Studio
      const response = await fetch(`${this.baseUrl}/v1/models`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: true,
      functionCalling: false, // Depends on model
      vision: false, // Depends on model
      maxContextLength: 32000, // Model dependent
      supportedModels: [], // Discovered dynamically
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 4096;

    this.logger.providerCall(this.provider, model);

    try {
      if (this.provider === "ollama") {
        const response = await ollama.chat({
          model,
          messages: this.convertMessages(messages),
          options: {
            num_predict: maxTokens,
            temperature: options?.temperature,
            top_p: options?.topP,
            stop: options?.stopSequences,
          },
        });

        return {
          content: response.message.content,
          usage: {
            inputTokens: response.prompt_eval_count ?? 0,
            outputTokens: response.eval_count ?? 0,
            totalTokens:
              (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
          },
          model,
          finishReason: "stop",
        };
      }

      // LM Studio (OpenAI-compatible API)
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: this.convertMessages(messages),
          max_tokens: maxTokens,
          temperature: options?.temperature,
          top_p: options?.topP,
          stop: options?.stopSequences,
        }),
      });

      if (!response.ok) {
        throw new ProviderError(
          `LM Studio API error: ${response.statusText}`,
          "local",
          { status: response.status },
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      return {
        content: data.choices[0]?.message.content ?? "",
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        model,
        finishReason: this.mapFinishReason(data.choices[0]?.finish_reason),
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `${this.provider} API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "local",
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

    this.logger.providerCall(this.provider, model);

    try {
      if (this.provider === "ollama") {
        const stream = await ollama.chat({
          model,
          messages: this.convertMessages(messages),
          options: {
            num_predict: maxTokens,
            temperature: options?.temperature,
            top_p: options?.topP,
            stop: options?.stopSequences,
          },
          stream: true,
        });

        for await (const chunk of stream) {
          if (chunk.message.content) {
            yield { content: chunk.message.content, done: false };
          }
        }
      } else {
        // LM Studio streaming
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: this.convertMessages(messages),
            max_tokens: maxTokens,
            temperature: options?.temperature,
            top_p: options?.topP,
            stream: true,
          }),
        });

        const reader = response.body?.getReader();
        if (!reader) {
          throw new ProviderError("Failed to get stream reader", "local");
        }

        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          const lines = text
            .split("\n")
            .filter((line) => line.startsWith("data: "));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data) as {
                choices: Array<{ delta: { content?: string } }>;
              };
              const content = parsed.choices[0]?.delta?.content;
              if (content) {
                yield { content, done: false };
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      yield { content: "", done: true };
    } catch (error) {
      throw new ProviderError(
        `${this.provider} streaming error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "local",
        { error },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      if (this.provider === "ollama") {
        const response = await ollama.embeddings({
          model: "nomic-embed-text", // Default embedding model
          prompt: text,
        });
        return response.embedding;
      }

      // LM Studio embedding
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "text-embedding-ada-002", // Compatible model
          input: text,
        }),
      });

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      return data.data[0]?.embedding ?? [];
    } catch (error) {
      throw new ProviderError(
        `Embedding error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "local",
        { error },
      );
    }
  }

  countTokens(text: string): number {
    // Rough approximation for local models
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    try {
      if (this.provider === "ollama") {
        const response = await fetch(`${this.baseUrl}/api/tags`);
        const data = (await response.json()) as {
          models: Array<{ name: string }>;
        };
        return data.models.map((m) => m.name);
      }

      // LM Studio
      const response = await fetch(`${this.baseUrl}/v1/models`);
      const data = (await response.json()) as {
        data: Array<{ id: string }>;
      };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async getDefaultModel(
    taskType: "simple" | "code" | "complex",
  ): Promise<string> {
    // Return default model for task type
    const modelMap: Record<string, string> = {
      simple: "qwen2.5-coder:latest",
      code: "qwen2.5-coder:latest",
      complex: "qwen2.5-coder:latest",
    };
    return modelMap[taskType] ?? this.defaultModel;
  }

  estimateCost(
    _inputTokens: number,
    _outputTokens: number,
    _model: string,
  ): number {
    // Local models are free!
    return 0;
  }

  private convertMessages(
    messages: ChatMessage[],
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : this.contentToString(msg.content),
    }));
  }

  private contentToString(content: ContentBlock[]): string {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }

  private mapFinishReason(
    reason: string | undefined,
  ): "stop" | "length" | "error" {
    if (reason === "stop") return "stop";
    if (reason === "length") return "length";
    return "error";
  }
}
