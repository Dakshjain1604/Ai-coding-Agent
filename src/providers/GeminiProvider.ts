/**
 * Gemini Provider - Google Gemini API implementation
 */

import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  Part,
} from "@google/generative-ai";
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

export interface GeminiConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

export class GeminiProvider extends BaseProvider {
  private genAI: GoogleGenerativeAI;
  private defaultModel: string;
  private logger = getLogger();

  constructor(config?: GeminiConfig) {
    super("gemini", config);

    const apiKey =
      config?.apiKey ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ProviderError("Gemini API key not provided", "gemini", {
        hint: "Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable",
      });
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.defaultModel = config?.defaultModel ?? "gemini-2.0-flash";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.defaultModel });
      await model.generateContent("Hi");
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
      maxContextLength: 1000000, // Gemini has a large context
      supportedModels: [
        "gemini-2.0-flash",
        "gemini-2.0-pro",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-1.5-flash-8b",
      ],
    };
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 8192;

    this.logger.providerCall("gemini", model);

    try {
      const genModel = this.genAI.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: options?.temperature,
          topP: options?.topP,
          stopSequences: options?.stopSequences,
        },
      });

      const { contents, systemInstruction } = this.convertMessages(messages);

      const result = await genModel.generateContent({
        contents,
        systemInstruction,
      });

      const response = result.response;
      const text = response.text();

      return {
        content: text,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
        },
        model,
        finishReason: this.mapFinishReason(
          response.candidates?.[0]?.finishReason,
        ),
      };
    } catch (error) {
      throw new ProviderError(
        `Gemini API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "gemini",
        { error },
      );
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<StreamChunk> {
    const model = options?.model ?? this.defaultModel;
    const maxTokens = options?.maxTokens ?? 8192;

    this.logger.providerCall("gemini", model);

    const genModel = this.genAI.getGenerativeModel({
      model,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: options?.temperature,
        topP: options?.topP,
      },
    });

    const { contents, systemInstruction } = this.convertMessages(messages);

    const result = await genModel.generateContentStream({
      contents,
      systemInstruction,
    });

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        yield { content: text, done: false };
      }
    }

    yield { content: "", done: true };
  }

  async embed(text: string): Promise<number[]> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: "text-embedding-004",
      });
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (error) {
      throw new ProviderError(
        `Gemini embedding error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "gemini",
        { error },
      );
    }
  }

  countTokens(text: string): number {
    // Rough approximation - Gemini uses similar tokenization
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    return this.getCapabilities().supportedModels;
  }

  async getDefaultModel(
    taskType: "simple" | "code" | "complex",
  ): Promise<string> {
    const modelMap: Record<string, string> = {
      simple: "gemini-2.0-flash",
      code: "gemini-2.0-flash",
      complex: "gemini-2.0-pro",
    };
    return modelMap[taskType] ?? this.defaultModel;
  }

  estimateCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
  ): number {
    // Pricing per million tokens (as of 2024)
    // Gemini Flash is free tier eligible
    const pricing: Record<string, { input: number; output: number }> = {
      "gemini-2.0-flash": { input: 0.075, output: 0.3 },
      "gemini-2.0-pro": { input: 1.25, output: 5 },
      "gemini-1.5-flash": { input: 0.075, output: 0.3 },
      "gemini-1.5-pro": { input: 1.25, output: 5 },
      "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
    };

    const price = pricing[model] ?? pricing["gemini-2.0-flash"];
    return (
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output
    );
  }

  private convertMessages(messages: ChatMessage[]): {
    contents: Content[];
    systemInstruction?: string;
  } {
    const contents: Content[] = [];
    let systemInstruction: string | undefined;

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = msg.content as string;
        continue;
      }

      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: this.convertContent(msg.content),
      });
    }

    return { contents, systemInstruction };
  }

  private convertContent(content: string | ContentBlock[]): Part[] {
    if (typeof content === "string") {
      return [{ text: content }];
    }

    return content.map((block) => {
      if (block.type === "text") {
        return { text: block.text ?? "" };
      }
      if (block.type === "image" && block.source?.type === "base64") {
        return {
          inlineData: {
            mimeType: block.source.media_type ?? "image/jpeg",
            data: block.source.data ?? "",
          },
        };
      }
      return { text: "" };
    });
  }

  private mapFinishReason(
    reason: string | undefined,
  ): "stop" | "length" | "error" {
    if (reason === "STOP") return "stop";
    if (reason === "MAX_TOKENS") return "length";
    return "error";
  }
}
