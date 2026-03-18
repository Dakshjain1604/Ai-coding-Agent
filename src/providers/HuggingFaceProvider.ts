/**
 * HuggingFace Provider - Free inference API
 * HuggingFace offers free inference endpoints
 */

import type {
  CompletionOptions,
  StreamChunk,
  ProviderType,
} from "../utils/types.js";
import {
  BaseProvider,
  type ChatMessage,
  type CompletionResult,
  type UsageStats,
  type ProviderCapabilities,
} from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";

export interface HuggingFaceConfig {
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

interface HuggingFaceResponse {
  generated_text?: string;
}

export class HuggingFaceProvider extends BaseProvider {
  private apiKey: string;
  private defaultModel: string;
  private logger = getLogger();
  private baseUrl = "https://api-inference.huggingface.co";

  constructor(config?: HuggingFaceConfig) {
    super("huggingface", config);

    this.apiKey = config?.apiKey ?? process.env.HUGGINGFACE_API_KEY ?? "";
    if (!this.apiKey) {
      throw new ProviderError(
        "HuggingFace API key not provided",
        "huggingface",
        {
          hint: "Get free API key at https://huggingface.co/settings/inference",
        },
      );
    }

    this.defaultModel =
      config?.defaultModel ?? "meta-llama/Llama-3.2-3B-Instruct";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.baseUrl}/models/${this.defaultModel}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
      );
      return response.ok;
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
        "meta-llama/Llama-3.2-3B-Instruct",
        "meta-llama/Llama-3.2-1B-Instruct",
        "Qwen/Qwen2.5-Coder-3B-Instruct",
        "Qwen/Qwen2.5-7B-Instruct",
        "microsoft/Phi-3.5-mini-instruct",
        "google/gemma-2-2b-it",
        "mistralai/Mistral-7B-Instruct-v0.2",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const prompt = this.messagesToPrompt(messages);

    try {
      const response = await fetch(`${this.baseUrl}/models/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            return_full_text: false,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HF API error: ${response.statusText}`);
      }

      const data = (await response.json()) as
        | HuggingFaceResponse
        | HuggingFaceResponse[];
      const content = Array.isArray(data)
        ? (data[0]?.generated_text ?? "")
        : (data.generated_text ?? "");

      const tokenEstimate = Math.ceil(content.length / 4);

      return {
        content,
        usage: {
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: tokenEstimate,
          totalTokens: Math.ceil(prompt.length / 4) + tokenEstimate,
        },
        model,
        finishReason: "stop",
      };
    } catch (error) {
      throw new ProviderError(
        `HuggingFace error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "huggingface",
        { model },
      );
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel;
    const prompt = this.messagesToPrompt(messages);

    try {
      const response = await fetch(`${this.baseUrl}/models/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            return_full_text: false,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HF API error: ${response.statusText}`);
      }

      const data = (await response.json()) as HuggingFaceResponse;
      const content = data.generated_text ?? "";

      // Yield content in chunks
      const chunks = content.split(/(?=\s)/);
      for (const chunk of chunks) {
        yield { content: chunk, done: false };
      }
      yield { content: "", done: true };
    } catch (error) {
      throw new ProviderError(
        `HuggingFace streaming error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "huggingface",
        { model },
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await fetch(
        "https://api-inference.huggingface.co/pipeline/feature-extraction/BAAI/bge-small-en-v1.5",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: text }),
        },
      );

      if (!response.ok) {
        throw new Error(`HF embeddings error: ${response.statusText}`);
      }

      return (await response.json()) as number[];
    } catch (error) {
      throw new ProviderError(
        `HuggingFace embeddings error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "huggingface",
        {},
      );
    }
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

  private messagesToPrompt(messages: ChatMessage[]): string {
    return messages
      .map((msg) => {
        if (msg.role === "system") return `System: ${msg.content}`;
        if (msg.role === "user") return `User: ${msg.content}`;
        return `Assistant: ${msg.content}`;
      })
      .join("\n\n");
  }
}
