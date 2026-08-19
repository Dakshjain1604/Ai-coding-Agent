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
import { accumulateOpenAIToolCallDeltas } from "./openai-stream-tools.js";

export interface OpenRouterConfig {
  apiKey?: string;
  defaultModel?: string;
  [key: string]: unknown;
}

/**
 * Curated, confirmed-live-working free models that actually support native
 * tool calling on OpenRouter — verified directly against OpenRouter's real
 * API with this codebase's real tool schemas (post the `items`-on-array-
 * params fix in ToolRegistry.ts). "google/gemma-2-9b-8192-it" (the
 * previous default) doesn't exist on OpenRouter at all and every other
 * hardcoded model this codebase referenced ("stepfun/step-3.5-flash:free"
 * in ModelRouter.ts) 404s — "This model is unavailable for free. ... use
 * this slug instead: stepfun/step-3.5-flash" (the PAID version, which
 * then 402s with no credits). Neither had ever been exercised against the
 * real API before.
 *
 * Ordering matters: index 0 becomes `defaultModel` below AND is tried
 * first in buildModelsList()'s server-side fallback list.
 * "openai/gpt-oss-20b:free" used to be first — moved after real live
 * evidence (6+ separate SWE-bench task runs) showed it reliably returns
 * completely empty completions on real tool-heavy conversations, while
 * "google/gemma-4-31b-it:free" produced real content every time it was
 * reached in the SAME runs. See ProviderRegistry.ts's "openrouter" entry
 * for the full account. "nvidia/nemotron-nano-9b-v2:free" has never
 * actually been exercised by real traffic in any observed run — kept
 * last, unverified either way.
 */
export const OPENROUTER_FREE_TOOL_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
];

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

    this.defaultModel = config?.defaultModel ?? OPENROUTER_FREE_TOOL_MODELS[0];
  }

  /**
   * OpenRouter's free (":free"-suffixed) models each draw from a per-model
   * shared upstream pool across ALL of OpenRouter's free-tier users, not a
   * per-account quota — confirmed live: google/gemma-4-31b-it:free
   * returned 429 "temporarily rate-limited upstream ... shared pool"
   * within a handful of requests, with this account's OWN usage nowhere
   * near any documented per-key limit. A single free model is therefore a
   * fragile choice regardless of which one you pick.
   *
   * OpenRouter's own `models` request field (an ordered list, tried in
   * sequence server-side on error, all within ONE round trip) is the
   * intended mechanism for this — confirmed live: passing the primary
   * model plus 2 backups, with the primary artificially rate-limited,
   * returned a successful completion from the second model with no
   * client-side retry loop and no added latency beyond the one failed
   * attempt OpenRouter's own routing already had to make. Only build this
   * list for genuinely free models — an explicit request for a specific
   * PAID model must never be silently redirected to a different (and
   * inferior) model on failure.
   */
  private buildModelsList(model: string): string[] | undefined {
    if (!model.endsWith(":free")) return undefined;
    return [model, ...OPENROUTER_FREE_TOOL_MODELS.filter((m) => m !== model)];
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
      // embed() below always throws — OpenRouter doesn't proxy an
      // embeddings endpoint the way it does chat completions, so this
      // must be false, not true (was previously misreporting itself as
      // capable of something it categorically cannot do).
      embeddings: false,
      functionCalling: true,
      vision: true,
      maxContextLength: 128000,
      supportedModels: [
        // Free (":free"-suffixed) models — confirmed live against
        // OpenRouter's real /models endpoint and confirmed to actually
        // return native tool_calls against this codebase's real tool
        // schemas. See OPENROUTER_FREE_TOOL_MODELS, the source of truth
        // this list is kept in sync with.
        ...OPENROUTER_FREE_TOOL_MODELS,
        // Low-cost paid models (the previous list called these "free" —
        // none carry a ":free" suffix, so on OpenRouter's own naming
        // convention they never were; "mistralai/mistral-7b-instruct",
        // listed here previously, no longer exists at all).
        "meta-llama/llama-3.1-8b-instruct",
        "deepseek/deepseek-chat",
        // Paid models (also available) — these IDs drift as providers
        // release new model generations faster than a hardcoded list can
        // track; treat this section as illustrative, not authoritative
        // (supportedModels is advisory only — nothing validates a
        // requested model against it before sending a real request).
        "openai/gpt-4o",
        "anthropic/claude-sonnet-5",
        "google/gemini-3.5-flash",
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
        // OpenRouter-specific field, not in the OpenAI SDK's request type —
        // see buildModelsList's comment for why this is the right fix for
        // free-tier rate limiting rather than a client-side retry loop.
        ...({ models: this.buildModelsList(model) } as Record<string, unknown>),
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
        // response.model reflects whichever model in the `models` list
        // actually served the request, not necessarily the primary one.
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
        ...({ models: this.buildModelsList(model) } as Record<string, unknown>),
        messages: this.convertMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
        tools:
          openRouterTools && openRouterTools.length > 0
            ? openRouterTools
            : undefined,
      });

      const toolCalls = accumulateOpenAIToolCallDeltas();

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield {
            content: delta.content,
            done: false,
          };
        }
        if (delta?.tool_calls) {
          toolCalls.absorb(delta.tool_calls);
        }
      }

      yield { content: "", done: true, toolCalls: toolCalls.finalize() };
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
    // A model is free on OpenRouter iff its ID carries the ":free" suffix
    // — the previous check here was a hardcoded list of three model IDs,
    // none of which actually carried ":free" (so none were genuinely
    // free), and one of which ("mistralai/mistral-7b-instruct") no longer
    // exists on OpenRouter at all. Suffix-checking is also self-updating:
    // it stays correct as OPENROUTER_FREE_TOOL_MODELS gains/loses entries,
    // rather than needing to be kept in sync by hand.
    if (model.endsWith(":free")) {
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
