/**
 * Provider Interface - Abstract base for all LLM providers
 * Defines the unified interface for model interactions
 */

import type {
  CompletionOptions,
  StreamChunk,
  ProviderType,
  ToolCall,
  ToolSchema,
} from "../utils/types.js";

export type { StreamChunk, ToolCall, ToolSchema };

export type Message = ChatMessage;

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * Message format for chat completions
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

/**
 * Content block for multimodal messages
 */
export interface ContentBlock {
  type: "text" | "image" | "code";
  text?: string;
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  language?: string;
}

/**
 * Usage statistics for API calls
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Completion result
 */
export interface CompletionResult {
  content: string;
  usage: UsageStats;
  model: string;
  finishReason: "stop" | "length" | "error" | "tool_calls";
  toolCalls?: ToolCall[];
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  streaming: boolean;
  embeddings: boolean;
  functionCalling: boolean;
  vision: boolean;
  maxContextLength: number;
  supportedModels: string[];
}

/**
 * Abstract base class for LLM providers
 */
export abstract class BaseProvider {
  protected type: ProviderType;
  protected config: Record<string, unknown>;

  constructor(type: ProviderType, config?: Record<string, unknown>) {
    this.type = type;
    this.config = config ?? {};
  }

  /**
   * Get provider type
   */
  getType(): ProviderType {
    return this.type;
  }

  /**
   * Check if provider is available (API key set, service running, etc.)
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Get provider capabilities
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Complete a prompt and return the result
   */
  abstract complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult>;

  /**
   * Stream completion tokens
   */
  abstract stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk>;

  /**
   * Generate embeddings for text
   */
  abstract embed(text: string): Promise<number[]>;

  /**
   * Count tokens in text
   */
  abstract countTokens(text: string): number;

  /**
   * Get available models
   */
  abstract getModels(): Promise<string[]>;

  /**
   * Get default model for a task type
   */
  async getDefaultModel(
    taskType: "simple" | "code" | "complex",
  ): Promise<string> {
    const models = await this.getModels();
    if (models.length === 0) {
      throw new Error("No models available");
    }
    return models[0];
  }

  /**
   * Estimate cost for a completion
   */
  abstract estimateCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): number;
}

/**
 * Provider factory function type
 */
export type ProviderFactory = () => BaseProvider;
