/**
 * Ollama Provider - Local LLM support via Ollama
 * Default provider for cost-optimized operation
 */

import type {
  CompletionOptions,
  StreamChunk,
  ProviderType,
} from "../utils/types.js";
import {
  BaseProvider,
  type Message,
  type CompletionResult,
  type EmbeddingResult,
  type ProviderCapabilities,
} from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";

interface OllamaModelInfo {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    num_predict?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
  };
}

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

export class OllamaProvider extends BaseProvider {
  private baseUrl: string;
  private models: Map<string, OllamaModelInfo> = new Map();
  private modelsLoaded = false;

  constructor(options?: { baseUrl?: string; apiKey?: string }) {
    super("ollama", options);
    this.baseUrl = options?.baseUrl ?? "http://localhost:11434";
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: true,
      functionCalling: false, // Limited support in Ollama
      vision: false,
      maxContextLength: 128000, // Model dependent, conservative default
      supportedModels: ["qwen2.5-coder:latest", "qwen3.5:2b"],
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(
    messages: Message[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? "qwen2.5-coder:latest";
    const prompt = this.messagesToPrompt(messages, options?.systemPrompt);
    const mergedOptions = this.mergeOptions(options) as {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      stop?: string[];
    };

    const request: OllamaGenerateRequest = {
      model,
      prompt,
      stream: false,
      options: {
        num_predict: mergedOptions.max_tokens,
        temperature: mergedOptions.temperature,
        top_p: mergedOptions.top_p,
        stop:
          mergedOptions.stop && mergedOptions.stop.length > 0
            ? mergedOptions.stop
            : undefined,
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          `Ollama completion failed: ${errorText}`,
          "ollama",
          { status: response.status },
        );
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      return {
        content: data.response,
        usage: {
          inputTokens: data.prompt_eval_count ?? this.estimateTokens(prompt),
          outputTokens: data.eval_count ?? this.estimateTokens(data.response),
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
        model: data.model,
        finishReason: data.done ? "stop" : "length",
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Ollama request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama",
        { error },
      );
    }
  }

  async *completeStream(
    messages: Message[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const model = options?.model ?? "qwen2.5-coder:latest";
    const prompt = this.messagesToPrompt(messages, options?.systemPrompt);
    const mergedOptions = this.mergeOptions(options) as {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      stop?: string[];
    };

    const request: OllamaGenerateRequest = {
      model,
      prompt,
      stream: true,
      options: {
        num_predict: mergedOptions.max_tokens,
        temperature: mergedOptions.temperature,
        top_p: mergedOptions.top_p,
        stop:
          mergedOptions.stop && mergedOptions.stop.length > 0
            ? mergedOptions.stop
            : undefined,
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          `Ollama stream failed: ${errorText}`,
          "ollama",
          { status: response.status },
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new ProviderError("No response body", "ollama");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line) as OllamaGenerateResponse;
            yield {
              content: data.response,
              done: data.done,
            };
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Ollama stream failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama",
        { error },
      );
    }
  }

  async embed(text: string, model = "nomic-embed-text"): Promise<number[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          `Ollama embedding failed: ${errorText}`,
          "ollama",
          { status: response.status },
        );
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;
      return data.embedding;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Ollama embedding failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama",
        { error },
      );
    }
  }

  countTokens(text: string): number {
    // Ollama doesn't have a token counting endpoint
    // Use estimation based on character count
    return this.estimateTokens(text);
  }

  async getAvailableModels(): Promise<string[]> {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }
    return Array.from(this.models.keys());
  }

  async hasModel(model: string): Promise<boolean> {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }
    return this.models.has(model);
  }

  private async loadModels(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new ProviderError(
          `Failed to fetch models: ${response.statusText}`,
          "ollama",
        );
      }

      const data = (await response.json()) as { models: OllamaModelInfo[] };
      this.models.clear();

      for (const model of data.models ?? []) {
        this.models.set(model.name, model);
      }

      this.modelsLoaded = true;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Failed to load models: ${error instanceof Error ? error.message : "Unknown error"}`,
        "ollama",
        { error },
      );
    }
  }

  private messagesToPrompt(messages: Message[], systemPrompt?: string): string {
    const parts: string[] = [];

    // Add system prompt first if provided
    if (systemPrompt) {
      parts.push(`System: ${systemPrompt}`);
    }

    for (const message of messages) {
      switch (message.role) {
        case "system":
          parts.push(`System: ${message.content}`);
          break;
        case "user":
          parts.push(`User: ${message.content}`);
          break;
        case "assistant":
          parts.push(`Assistant: ${message.content}`);
          break;
      }
    }

    // Add assistant prompt at the end
    parts.push("Assistant:");

    return parts.join("\n\n");
  }

  async getModels(): Promise<string[]> {
    await this.loadModels();
    return Array.from(this.models.keys());
  }

  estimateCost(
    _inputTokens: number,
    _outputTokens: number,
    _model: string,
  ): number {
    // Ollama is free/local, so cost is 0
    return 0;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private mergeOptions(options?: CompletionOptions): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    if (options?.maxTokens) {
      opts.max_tokens = options.maxTokens;
    }
    if (options?.temperature) {
      opts.temperature = options.temperature;
    }
    if (options?.topP) {
      opts.top_p = options.topP;
    }
    if (options?.stopSequences) {
      opts.stop = options.stopSequences;
    }
    return opts;
  }

  async *stream(
    messages: Message[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const prompt = this.messagesToPrompt(messages, options?.systemPrompt);
    const body: Record<string, unknown> = {
      model: options?.model ?? "qwen2.5-coder:latest",
      prompt,
      stream: true,
      ...this.mergeOptions(options),
    };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Stream request failed: ${response.statusText}`,
        "ollama",
      );
    }

    if (!response.body) {
      throw new ProviderError("No response body", "ollama");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.response) {
              yield { content: data.response, done: false };
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: "", done: true };
  }
}
