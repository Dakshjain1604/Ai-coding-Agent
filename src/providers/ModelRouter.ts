/**
 * Model Router - Intelligent routing between providers and models
 * Routes tasks to optimal models based on complexity, cost, and availability
 */

import type { ProviderType } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";
import { ProviderFactory } from "./ProviderFactory.js";
import { BaseProvider } from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import chalk from "chalk";
import { getModelFor, useNvidiaFallback } from "./ProviderRegistry.js";
import { getModelCatalog } from "./ModelCatalog.js";

export type { TaskCategory } from "./ProviderRegistry.js";
import type { TaskCategory } from "./ProviderRegistry.js";
export type CostPreference = "free" | "cheap" | "balanced" | "quality";

export interface RoutingRule {
  taskCategory: TaskCategory;
  provider?: ProviderType;
  model?: string;
  fallback?: ProviderType;
}

export interface RoutingResult {
  provider: BaseProvider;
  model: string;
  estimatedCost: number;
  estimatedLatency: number;
}

export interface RoutingConfig {
  preferLocal: boolean;
  fallbackToPaid: boolean;
  maxPaidApiCalls: number;
  costPreference: CostPreference;
  customRules: RoutingRule[];
}

/** Providers billed per-token — matches canMakePaidCall()'s own counting. */
const PAID_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  "claude",
  "openai",
  "gemini",
]);

/**
 * Default routing rules when local-first is disabled.
 * Priority: Groq (openai/gpt-oss-20b — fast inference, but an 8000 TPM
 * free-tier ceiling per GroqProvider's own clamping) -> OpenRouter
 * (openai/gpt-oss-20b:free, tried across 3 confirmed-working free models
 * via its own `models` fallback array when one is rate-limited — see
 * OpenRouterProvider.OPENROUTER_FREE_TOOL_MODELS) -> paid fallbacks.
 * Groq is deliberately tried first for latency (confirmed live: Groq's
 * free-tier responses are noticeably faster than OpenRouter's, which adds
 * routing overhead to third-party model hosts); OpenRouter is the
 * rate-limit safety net once Groq's small per-minute budget is exhausted,
 * not the primary path. `routeToFallback`'s hardcoded order already
 * agreed with this (local -> groq -> openrouter -> ...) — this table
 * previously didn't, sending every default-rule request to OpenRouter
 * first regardless, and only reaching routeToFallback's groq-first order
 * when OpenRouter was entirely unconfigured. When `preferLocal` is true,
 * ModelRouter builds a local-first variant of these rules instead (see
 * `buildDefaultRules`) — this table is only used as the non-local-first
 * branch.
 */
const CLOUD_FIRST_RULES: RoutingRule[] = [
  {
    taskCategory: "simple",
    provider: "groq",
    model: "openai/gpt-oss-20b",
  },
  {
    taskCategory: "code",
    provider: "groq",
    model: "openai/gpt-oss-20b",
  },
  {
    taskCategory: "complex",
    provider: "groq",
    model: "openai/gpt-oss-20b",
  },
  {
    taskCategory: "reasoning",
    provider: "groq",
    model: "openai/gpt-oss-20b",
  },
  { taskCategory: "embedding", provider: "local", model: "nomic-embed-text" },
];

/**
 * Local-first routing rules — used whenever `preferLocal` is true (the
 * project default). Availability is still checked per-call in route(); if
 * Ollama isn't actually running, route() falls through to routeToFallback(),
 * which also tries local first before any cloud provider.
 */
const LOCAL_FIRST_RULES: RoutingRule[] = [
  { taskCategory: "simple", provider: "local", model: "qwen2.5-coder:latest" },
  { taskCategory: "code", provider: "local", model: "qwen2.5-coder:latest" },
  {
    taskCategory: "complex",
    provider: "local",
    model: "qwen2.5-coder:latest",
  },
  {
    taskCategory: "reasoning",
    provider: "local",
    model: "qwen2.5-coder:latest",
  },
  { taskCategory: "embedding", provider: "local", model: "nomic-embed-text" },
];

/**
 * Model specifications
 */
const MODEL_SPECS: Record<
  string,
  { contextLength: number; cost: number; quality: number; speed: number }
> = {
  // Ollama (Local) - Free, varying quality
  "qwen2.5-coder:latest": {
    contextLength: 32768,
    cost: 0,
    quality: 0.85,
    speed: 0.85,
  },
  "nomic-embed-text": {
    contextLength: 8192,
    cost: 0,
    quality: 0.8,
    speed: 0.95,
  },
  "codellama:34b": { contextLength: 16384, cost: 0, quality: 0.88, speed: 0.6 },

  // Claude - High quality, expensive
  "claude-opus-4-6": {
    contextLength: 200000,
    cost: 15,
    quality: 0.98,
    speed: 0.5,
  },
  "claude-sonnet-4-6": {
    contextLength: 200000,
    cost: 3,
    quality: 0.95,
    speed: 0.7,
  },
  "claude-haiku-4-5-20251001": {
    contextLength: 200000,
    cost: 0.8,
    quality: 0.88,
    speed: 0.9,
  },

  // OpenAI - Good balance
  "gpt-4o": { contextLength: 128000, cost: 2.5, quality: 0.94, speed: 0.8 },
  "gpt-4o-mini": {
    contextLength: 128000,
    cost: 0.15,
    quality: 0.85,
    speed: 0.95,
  },
  "o1-preview": { contextLength: 128000, cost: 15, quality: 0.97, speed: 0.3 },

  // Gemini - Free tier available
  "gemini-2.0-flash": {
    contextLength: 1000000,
    cost: 0.075,
    quality: 0.9,
    speed: 0.9,
  },
  "gemini-2.0-pro": {
    contextLength: 1000000,
    cost: 1.25,
    quality: 0.93,
    speed: 0.7,
  },

  // Groq - Free tier (6000 tokens/min)
  "openai/gpt-oss-20b": {
    contextLength: 128000,
    cost: 0,
    quality: 0.82,
    speed: 0.98,
  },
  "openai/gpt-oss-120b": {
    contextLength: 128000,
    cost: 0,
    quality: 0.92,
    speed: 0.85,
  },

  // OpenRouter - Free models available. This whole section used to name
  // three model IDs — "google/gemma-2-9b-it:free", "meta-llama/
  // llama-3.2-90b-vision-instruct:free", "stepfun/step-3.5-flash:free" —
  // NONE of which exist in OpenRouter's real, current model catalog
  // (confirmed live against GET /api/v1/models: all three 404/missing).
  // The routing rule using the stepfun one meant every OpenRouter-routed
  // task failed on its very first request by default. Replaced with three
  // models confirmed live, right now, to (a) actually exist and (b)
  // successfully return native tool_calls against this codebase's real
  // tool schemas (see OPENROUTER_FREE_TOOL_MODELS in OpenRouterProvider.ts,
  // the single source of truth this list should be kept in sync with).
  "openai/gpt-oss-20b:free": {
    contextLength: 128000,
    cost: 0,
    quality: 0.82,
    speed: 0.95,
  },
  "nvidia/nemotron-nano-9b-v2:free": {
    contextLength: 128000,
    cost: 0,
    quality: 0.75,
    speed: 0.95,
  },
  "google/gemma-4-31b-it:free": {
    contextLength: 128000,
    cost: 0,
    quality: 0.85,
    speed: 0.8,
  },
};

/**
 * Model Router
 * Routes tasks to optimal models based on configuration and preferences
 */
export class ModelRouter {
  private factory: ProviderFactory;
  private config: RoutingConfig;
  private defaultRules: RoutingRule[];
  private callCount: Map<ProviderType, number> = new Map();
  private logger = getLogger();
  private modelCatalog = getModelCatalog();

  constructor(config?: Partial<RoutingConfig>) {
    this.config = {
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "free",
      customRules: [],
      ...config,
    };

    this.factory = ProviderFactory.getInstance({
      preferLocal: this.config.preferLocal,
      fallbackToPaid: this.config.fallbackToPaid,
    });

    this.defaultRules = this.config.preferLocal
      ? LOCAL_FIRST_RULES
      : CLOUD_FIRST_RULES;
  }

  /**
   * Route a task to the optimal provider and model
   */
  async route(
    taskCategory: TaskCategory,
    estimatedTokens: number = 1000,
    options?: {
      preferQuality?: boolean;
      preferSpeed?: boolean;
      // Providers to skip even if otherwise available — for re-routing
      // after a provider passed its availability probe but then failed on
      // an actual request (isAvailable() caches its result and won't
      // re-probe, so without this a naive retry just re-selects the same
      // provider that just failed).
      exclude?: ProviderType[];
    },
  ): Promise<RoutingResult> {
    // Check for custom rule first — but only actually use it if it doesn't
    // route to a paid provider we're out of budget for; canMakePaidCall()/
    // recordCall() used to have zero callers anywhere, so maxPaidApiCalls
    // never actually capped anything regardless of what a user configured.
    const customRule = this.config.customRules.find(
      (r) => r.taskCategory === taskCategory,
    );
    if (
      customRule &&
      customRule.provider &&
      customRule.model &&
      !options?.exclude?.includes(customRule.provider)
    ) {
      const resolvedCustomProvider = this.resolveProvider(customRule.provider);
      if (!this.isPaidProvider(resolvedCustomProvider) || this.canMakePaidCall()) {
        // Unlike the default-rule branch just below, this never checked
        // isAvailable() before handing back the provider — a custom rule
        // pointing at an unconfigured/unreachable provider would return a
        // RoutingResult that fails on the first actual LLM call instead of
        // falling through to the default rule / fallback chain here, the
        // same way an unavailable default-rule provider already does.
        // Falls through (rather than jumping straight to routeToFallback)
        // to stay consistent with the paid-budget-exceeded case just
        // below, which also gives the default rule a chance first.
        if (await this.factory.isAvailable(resolvedCustomProvider)) {
          return this.routeToRule(customRule, estimatedTokens);
        }
        this.logger.debug(
          `Custom rule for ${taskCategory} skipped: ${resolvedCustomProvider} is not available`,
        );
      } else {
        this.logger.debug(
          `Custom rule for ${taskCategory} skipped: paid API call limit reached for ${resolvedCustomProvider}`,
        );
      }
    }

    // Check default rules (local-first or cloud-first, per this.config.preferLocal)
    const defaultRule = this.defaultRules.find(
      (r) => r.taskCategory === taskCategory,
    );
    if (defaultRule && !options?.exclude?.includes(defaultRule.provider!)) {
      const providerType = this.resolveProvider(defaultRule.provider!);

      if (this.isPaidProvider(providerType) && !this.canMakePaidCall()) {
        return this.routeToFallback(
          taskCategory,
          estimatedTokens,
          options?.exclude,
          options?.preferQuality,
        );
      }

      // Check if provider is available
      const available = await this.factory.isAvailable(providerType);
      if (!available) {
        return this.routeToFallback(
          taskCategory,
          estimatedTokens,
          options?.exclude,
          options?.preferQuality,
        );
      }

      const provider = await this.factory.get(providerType);
      const model = defaultRule.model!;

      // Adjust based on preferences
      const finalModel = options?.preferQuality
        ? this.getBetterModel(taskCategory, providerType)
        : options?.preferSpeed
          ? this.getFasterModel(taskCategory, providerType)
          : model;

      this.recordCall(providerType);
      return {
        provider,
        model: finalModel,
        estimatedCost: await this.estimateCost(finalModel, estimatedTokens),
        estimatedLatency: await this.estimateLatency(
          finalModel,
          estimatedTokens,
        ),
      };
    }

    // No rule found - use best available
    return this.routeToBest(
      taskCategory,
      estimatedTokens,
      options?.exclude,
      options?.preferQuality,
    );
  }

  /**
   * Route to a specific provider and model
   */
  async routeTo(
    providerType: ProviderType,
    model: string,
    estimatedTokens: number = 1000,
  ): Promise<RoutingResult> {
    const available = await this.factory.isAvailable(providerType);
    if (!available) {
      throw new ProviderError(
        `Provider ${providerType} is not available`,
        providerType,
      );
    }

    const provider = await this.factory.get(providerType);

    return {
      provider,
      model,
      estimatedCost: await this.estimateCost(model, estimatedTokens),
      estimatedLatency: await this.estimateLatency(model, estimatedTokens),
    };
  }

  /**
   * Get available models for a provider
   */
  async getAvailableModels(providerType: ProviderType): Promise<string[]> {
    const provider = await this.factory.get(providerType);
    return provider.getModels();
  }

  /**
   * Check if can make a paid API call
   */
  canMakePaidCall(): boolean {
    if (this.config.fallbackToPaid && this.config.maxPaidApiCalls === 0) {
      return true; // Unlimited
    }

    const totalPaidCalls =
      (this.callCount.get("claude") ?? 0) +
      (this.callCount.get("openai") ?? 0) +
      (this.callCount.get("gemini") ?? 0);

    return totalPaidCalls < this.config.maxPaidApiCalls;
  }

  /**
   * Record a call to a provider
   */
  recordCall(providerType: ProviderType): void {
    const current = this.callCount.get(providerType) ?? 0;
    this.callCount.set(providerType, current + 1);
  }

  /**
   * Get call statistics
   */
  getStats(): Record<ProviderType, number> {
    return {
      local: this.callCount.get("local") ?? 0,
      ollama: this.callCount.get("local") ?? 0,
      claude: this.callCount.get("claude") ?? 0,
      openai: this.callCount.get("openai") ?? 0,
      gemini: this.callCount.get("gemini") ?? 0,
      groq: this.callCount.get("groq") ?? 0,
      openrouter: this.callCount.get("openrouter") ?? 0,
      huggingface: this.callCount.get("huggingface") ?? 0,
      "ollama-cloud": this.callCount.get("ollama-cloud") ?? 0,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RoutingConfig>): void {
    this.config = { ...this.config, ...config };
    this.factory.setOptions({
      preferLocal: config.preferLocal,
      fallbackToPaid: config.fallbackToPaid,
    });
    if (config.preferLocal !== undefined) {
      this.defaultRules = this.config.preferLocal
        ? LOCAL_FIRST_RULES
        : CLOUD_FIRST_RULES;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async routeToRule(
    rule: RoutingRule,
    estimatedTokens: number,
  ): Promise<RoutingResult> {
    const providerType = this.resolveProvider(rule.provider!);
    const provider = await this.factory.get(providerType);
    const model = rule.model!;

    this.recordCall(providerType);
    return {
      provider,
      model,
      estimatedCost: await this.estimateCost(model, estimatedTokens),
      estimatedLatency: await this.estimateLatency(model, estimatedTokens),
    };
  }

  private async routeToFallback(
    taskCategory: TaskCategory,
    estimatedTokens: number,
    exclude?: ProviderType[],
    preferQuality?: boolean,
  ): Promise<RoutingResult> {
    // Fallback order: Local → Groq (free) → OpenRouter (free) → Paid providers
    const fallbackOrder: ProviderType[] = [
      "local",
      "groq",
      "openrouter",
      "gemini",
      "openai",
      "claude",
    ];

    for (const providerType of fallbackOrder) {
      if (exclude?.includes(providerType)) continue;
      if (this.isPaidProvider(providerType) && !this.canMakePaidCall()) {
        this.logger.debug(
          `${providerType} skipped: paid API call limit reached`,
        );
        continue;
      }
      try {
        const isAvail = await this.factory.isAvailable(providerType);
        if (!isAvail) {
          this.logger.debug(`${providerType} unavailable, trying next fallback`);
          continue;
        }

        const provider = await this.factory.get(providerType);
        // Previously always the default tier, regardless of the caller's
        // preferQuality — meaning EVERY fallback (both the top-level
        // "primary provider unavailable" case and attemptDynamicFallback's
        // mid-task provider swap) silently dropped a reasoning/complex
        // task back to the fast/small model even when the primary routing
        // decision had correctly asked for the quality tier. Confirmed
        // live: a real SWE-bench debug-mode task correctly requested
        // preferQuality, but Groq's daily quota forced a fallback to
        // OpenRouter, which landed on its default -20b model instead of
        // the quality-tier one, with no path to have done otherwise.
        const model = preferQuality
          ? this.getBetterModel(taskCategory, providerType)
          : this.getDefaultModelForCategory(providerType, taskCategory);

        console.log(chalk.gray(`  • Falling back to ${providerType}...`));

        this.recordCall(providerType);
        return {
          provider,
          model,
          estimatedCost: await this.estimateCost(model, estimatedTokens),
          estimatedLatency: await this.estimateLatency(
            model,
            estimatedTokens,
          ),
        };
      } catch (err) {
        this.logger.debug(
          `${providerType} threw during fallback routing, trying next: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    throw new ProviderError("No available providers found", "groq", {
      hint: "Configure API keys: GROQ_API_KEY or OPENROUTER_API_KEY",
    });
  }

  private async routeToBest(
    taskCategory: TaskCategory,
    estimatedTokens: number,
    exclude?: ProviderType[],
    preferQuality?: boolean,
  ): Promise<RoutingResult> {
    // No default/custom rule matched this category — delegate to the same
    // local-first fallback order used when a rule's provider is unavailable.
    return this.routeToFallback(taskCategory, estimatedTokens, exclude, preferQuality);
  }

  private resolveProvider(type: ProviderType): ProviderType {
    // 'ollama' is an alias for 'local'
    return type === "ollama" ? "local" : type;
  }

  private isPaidProvider(type: ProviderType): boolean {
    // "openai" is a real, genuinely-paid provider UNLESS it's actually
    // running in NVIDIA fallback mode (OPENAI_API_KEY absent, an NVIDIA
    // key present — see OpenAIProvider.ts's constructor and
    // ProviderRegistry.useNvidiaFallback(), the same detection reused
    // here). Both cases share the same ProviderType, so this is the one
    // place that has to tell them apart. Without this: the app's own
    // `fallbackToPaid: false` safety default (config.ts) — a deliberate
    // guard against silently spending real money — also silently blocks
    // NVIDIA's genuinely free tier, confirmed live: an NVIDIA-only
    // environment (no other provider keys configured) got "No available
    // providers found" even though the NVIDIA key worked perfectly when
    // tested directly.
    if (type === "openai" && useNvidiaFallback()) return false;
    return PAID_PROVIDER_TYPES.has(type);
  }

  /**
   * Model selection for all three tiers now lives in ProviderRegistry.ts —
   * this used to be three ~90-line near-duplicate switch tables here.
   */
  private getDefaultModelForCategory(
    providerType: ProviderType,
    taskCategory: TaskCategory,
  ): string {
    return getModelFor(providerType, "default", taskCategory);
  }

  private getBetterModel(
    taskCategory: TaskCategory,
    providerType: ProviderType,
  ): string {
    return getModelFor(providerType, "quality", taskCategory);
  }

  private getFasterModel(
    taskCategory: TaskCategory,
    providerType: ProviderType,
  ): string {
    return getModelFor(providerType, "speed", taskCategory);
  }

  /**
   * Resolves a model's cost/context spec: the fetched+cached ModelCatalog
   * first, MODEL_SPECS (hand-maintained, always available) as the offline
   * fallback. Catalog data doesn't carry quality/speed scores, so those
   * always come from MODEL_SPECS regardless of catalog availability.
   */
  private async resolveModelSpec(model: string): Promise<{
    contextLength: number;
    cost: number;
    quality: number;
    speed: number;
  }> {
    const fallback = MODEL_SPECS[model] ?? {
      contextLength: 8192,
      cost: 0,
      quality: 0.7,
      speed: 0.7,
    };

    try {
      const catalogEntry = await this.modelCatalog.getModel(model);
      if (catalogEntry) {
        return {
          contextLength: catalogEntry.contextLength,
          cost: catalogEntry.costInputPerM,
          quality: fallback.quality,
          speed: fallback.speed,
        };
      }
    } catch {
      // ModelCatalog is designed to never throw, but cost/latency
      // estimation must never be what breaks routing regardless.
    }

    return fallback;
  }

  /** Real per-model context length — MODEL_SPECS fallback if the catalog has nothing for this model. */
  async getContextLength(model: string): Promise<number> {
    const spec = await this.resolveModelSpec(model);
    return spec.contextLength;
  }

  private async estimateCost(model: string, tokens: number): Promise<number> {
    const spec = await this.resolveModelSpec(model);
    if (spec.cost === 0) return 0;
    return (tokens / 1_000_000) * spec.cost;
  }

  private async estimateLatency(
    model: string,
    tokens: number,
  ): Promise<number> {
    const spec = await this.resolveModelSpec(model);

    // Rough estimate: base latency + token processing time
    const baseLatency = 500; // 0.5 seconds base
    const tokenFactor = 1 / spec.speed; // Slower models take longer
    const estimatedMs = baseLatency + tokens * tokenFactor * 2;

    return Math.round(estimatedMs);
  }
}

// Singleton instance
let modelRouterInstance: ModelRouter | null = null;

export function getModelRouter(config?: Partial<RoutingConfig>): ModelRouter {
  if (!modelRouterInstance) {
    modelRouterInstance = new ModelRouter(config);
  }
  return modelRouterInstance;
}

export function resetModelRouter(): void {
  modelRouterInstance = null;
}
