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
import { accumulateOpenAIToolCallDeltas } from "./openai-stream-tools.js";

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  organization?: string;
  [key: string]: unknown;
}

/**
 * NVIDIA's OpenAI-compatible catalog (integrate.api.nvidia.com) rotates
 * models — every model ID it returns from GET /v1/models comes back with a
 * `deprecation` response header pointing at a real, near-term date (e.g.
 * confirmed live: "z-ai/glm-5.2" carries "deprecation: 2026-08-25...").
 * Treat this list as illustrative, not permanent, same caveat as
 * OpenRouter's paid-model catalog in OpenRouterProvider.ts.
 */
const NVIDIA_MODELS = [
  "z-ai/glm-5.2",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
];

export class OpenAIProvider extends BaseProvider {
  private client: OpenAI;
  private defaultModel: string;
  private isNvidia: boolean;
  private logger = getLogger();

  constructor(config?: OpenAIConfig) {
    super("openai", config);

    const isNvidia =
      !config?.apiKey &&
      !process.env.OPENAI_API_KEY &&
      (Boolean(process.env.NVIDIA_API_KEY) || Boolean(process.env.NVAPI_KEY));
    this.isNvidia = isNvidia;

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

    // The previous default, "meta/llama-3.3-70b-instruct", is confirmed
    // live to hang indefinitely on this platform (100s+ with no response
    // at all) — it was never actually exercised against the real API.
    // "z-ai/glm-5.2" is confirmed live: responds in ~3.5s and returns
    // correct native tool_calls against this codebase's real 20-tool
    // schema set.
    this.defaultModel =
      config?.defaultModel ?? (isNvidia ? "z-ai/glm-5.2" : "gpt-4o");
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
    if (this.isNvidia) {
      return {
        streaming: true,
        // NVIDIA's catalog has dedicated embedding models
        // (nvidia/nv-embed-v1 etc.) but this client isn't pointed at that
        // endpoint shape — same "not actually supported through this
        // client" situation as OpenRouter's embed().
        embeddings: false,
        functionCalling: true,
        vision: false,
        maxContextLength: 128000,
        supportedModels: NVIDIA_MODELS,
      };
    }
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
      // Previously skipped entirely for NVIDIA (`!isNvidia ? ... :
      // undefined`) on the assumption its endpoint doesn't support native
      // tool calling — confirmed live that assumption was simply wrong:
      // NVIDIA's OpenAI-compatible endpoint returns correct, well-formed
      // tool_calls for both "z-ai/glm-5.2" and "meta/llama-3.1-70b-
      // instruct" against this codebase's real 20-tool schema set.
      const openAiTools = options?.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

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

    // See complete()'s comment — forwarding tools to NVIDIA is correct,
    // confirmed live.
    const openAiTools = options?.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: this.convertMessages(messages),
      temperature: options?.temperature,
      top_p: options?.topP,
      stop: options?.stopSequences,
      stream: true,
      tools: openAiTools && openAiTools.length > 0 ? openAiTools : undefined,
    });

    const toolCalls = accumulateOpenAIToolCallDeltas();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { content: delta.content, done: false };
      }
      if (delta?.tool_calls) {
        toolCalls.absorb(delta.tool_calls);
      }
    }

    yield { content: "", done: true, toolCalls: toolCalls.finalize() };
  }

  async embed(text: string): Promise<number[]> {
    if (this.isNvidia) {
      // "text-embedding-3-small" is an OpenAI-only model id — calling it
      // against NVIDIA's endpoint would fail with a confusing raw
      // "model not found"-style error rather than an honest one.
      throw new ProviderError(
        "Embeddings not supported through this NVIDIA client",
        "openai",
        { hint: "NVIDIA's dedicated embedding models (e.g. nvidia/nv-embed-v1) need a different request shape than this client sends." },
      );
    }
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
    if (this.isNvidia) {
      // The previous OpenAI-only model IDs here (gpt-4o-mini/gpt-4o/
      // o1-preview) aren't valid against NVIDIA's endpoint at all.
      const nvidiaModelMap: Record<string, string> = {
        simple: "meta/llama-3.1-8b-instruct",
        code: "z-ai/glm-5.2",
        complex: "meta/llama-3.1-70b-instruct",
      };
      return nvidiaModelMap[taskType] ?? this.defaultModel;
    }
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
    // NVIDIA's API catalog access (this codebase only ever reaches it via
    // the free evaluation tier) is free — the OpenAI pricing table below
    // would otherwise silently apply GPT-4o's real paid per-token rates
    // to genuinely free NVIDIA usage, since none of NVIDIA's model IDs
    // are in that table and the fallback (`pricing["gpt-4o"]`) is a real
    // priced entry, not zero.
    if (this.isNvidia) return 0;

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
