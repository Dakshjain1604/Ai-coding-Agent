/**
 * Model Router - Intelligent routing between providers and models
 * Routes tasks to optimal models based on complexity, cost, and availability
 */

import type { ProviderType, AppConfig } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";
import { ProviderFactory } from "./ProviderFactory.js";
import { BaseProvider } from "./ProviderInterface.js";
import { ProviderError } from "../utils/types.js";
import chalk from "chalk";

export type TaskCategory =
  | "simple"
  | "code"
  | "complex"
  | "reasoning"
  | "embedding";
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

/**
 * Default routing rules
 * Priority: OpenRouter (stepfun) -> Groq -> Error (no local fallback)
 */
const DEFAULT_RULES: RoutingRule[] = [
  {
    taskCategory: "simple",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
  },
  {
    taskCategory: "code",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
  },
  {
    taskCategory: "complex",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
  },
  {
    taskCategory: "reasoning",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
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
  "llama-3.1-8b-instant": {
    contextLength: 128000,
    cost: 0,
    quality: 0.82,
    speed: 0.98,
  },
  "llama-3.3-70b-versatile": {
    contextLength: 128000,
    cost: 0,
    quality: 0.92,
    speed: 0.85,
  },

  // OpenRouter - Free models available
  "google/gemma-2-9b-it:free": {
    contextLength: 8192,
    cost: 0,
    quality: 0.78,
    speed: 0.9,
  },
  "meta-llama/llama-3.2-90b-vision-instruct:free": {
    contextLength: 128000,
    cost: 0,
    quality: 0.88,
    speed: 0.7,
  },

  // StepFun - Free on OpenRouter
  "stepfun/step-3.5-flash:free": {
    contextLength: 128000,
    cost: 0,
    quality: 0.85,
    speed: 0.9,
  },
};

/**
 * Model Router
 * Routes tasks to optimal models based on configuration and preferences
 */
export class ModelRouter {
  private factory: ProviderFactory;
  private config: RoutingConfig;
  private callCount: Map<ProviderType, number> = new Map();
  private logger = getLogger();

  constructor(config?: Partial<RoutingConfig>) {
    this.factory = ProviderFactory.getInstance({
      preferLocal: config?.preferLocal ?? false,
      fallbackToPaid: config?.fallbackToPaid ?? true,
    });

    this.config = {
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "free",
      customRules: [],
      ...config,
    };
  }

  /**
   * Route a task to the optimal provider and model
   */
  async route(
    taskCategory: TaskCategory,
    estimatedTokens: number = 1000,
    options?: { preferQuality?: boolean; preferSpeed?: boolean },
  ): Promise<RoutingResult> {
    // Check for custom rule first
    const customRule = this.config.customRules.find(
      (r) => r.taskCategory === taskCategory,
    );
    if (customRule && customRule.provider && customRule.model) {
      return this.routeToRule(customRule, estimatedTokens);
    }

    // Check default rules
    const defaultRule = DEFAULT_RULES.find(
      (r) => r.taskCategory === taskCategory,
    );
    if (defaultRule) {
      const providerType = this.resolveProvider(defaultRule.provider!);

      // Check if provider is available
      const available = await this.factory.isAvailable(providerType);
      if (!available) {
        return this.routeToFallback(taskCategory, estimatedTokens);
      }

      const provider = await this.factory.get(providerType);
      const model = defaultRule.model!;
      const spec = MODEL_SPECS[model] ?? {
        contextLength: 8192,
        cost: 0,
        quality: 0.7,
        speed: 0.7,
      };

      // Adjust based on preferences
      const finalModel = options?.preferQuality
        ? this.getBetterModel(taskCategory, providerType)
        : options?.preferSpeed
          ? this.getFasterModel(taskCategory, providerType)
          : model;

      return {
        provider,
        model: finalModel,
        estimatedCost: this.estimateCost(finalModel, estimatedTokens),
        estimatedLatency: this.estimateLatency(finalModel, estimatedTokens),
      };
    }

    // No rule found - use best available
    return this.routeToBest(taskCategory, estimatedTokens);
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
    const spec = MODEL_SPECS[model] ?? {
      contextLength: 8192,
      cost: 0,
      quality: 0.7,
      speed: 0.7,
    };

    return {
      provider,
      model,
      estimatedCost: this.estimateCost(model, estimatedTokens),
      estimatedLatency: this.estimateLatency(model, estimatedTokens),
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

    return {
      provider,
      model,
      estimatedCost: this.estimateCost(model, estimatedTokens),
      estimatedLatency: this.estimateLatency(model, estimatedTokens),
    };
  }

  private async routeToFallback(
    taskCategory: TaskCategory,
    estimatedTokens: number,
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

    const lastFailReason = "";

    for (const providerType of fallbackOrder) {
      try {
        const isAvail = await this.factory.isAvailable(providerType);
        if (isAvail) {
          const provider = await this.factory.get(providerType);
          const model = this.getDefaultModelForCategory(
            providerType,
            taskCategory,
          );

          console.log(chalk.gray(`  • Falling back to ${providerType}...`));

          return {
            provider,
            model,
            estimatedCost: this.estimateCost(model, estimatedTokens),
            estimatedLatency: this.estimateLatency(model, estimatedTokens),
          };
        }
      } catch {
        // Provider not available, continue to next
      }
    }

    throw new ProviderError("No available providers found", "groq", {
      hint: "Configure API keys: GROQ_API_KEY or OPENROUTER_API_KEY",
    });
  }

  private async routeToBest(
    taskCategory: TaskCategory,
    estimatedTokens: number,
  ): Promise<RoutingResult> {
    // Skip local/Ollama entirely - go directly to cloud providers
    // Fallback order: Groq (free) → OpenRouter (free) → Paid providers
    return this.routeToFallback(taskCategory, estimatedTokens);
  }

  private resolveProvider(type: ProviderType): ProviderType {
    // 'ollama' is an alias for 'local'
    return type === "ollama" ? "local" : type;
  }

  private getDefaultModelForCategory(
    providerType: ProviderType,
    taskCategory: TaskCategory,
  ): string {
    const modelMap: Record<ProviderType, Record<TaskCategory, string>> = {
      local: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      claude: {
        simple: "claude-haiku-4-5-20251001",
        code: "claude-sonnet-4-6",
        complex: "claude-opus-4-6",
        reasoning: "claude-opus-4-6",
        embedding: "claude-haiku-4-5-20251001", // Claude doesn't have embeddings
      },
      openai: {
        simple:
          !process.env.OPENAI_API_KEY &&
          (Boolean(process.env.NVIDIA_API_KEY) ||
            Boolean(process.env.NVAPI_KEY))
            ? "meta/llama-3.1-8b-instruct"
            : "gpt-4o-mini",
        code:
          !process.env.OPENAI_API_KEY &&
          (Boolean(process.env.NVIDIA_API_KEY) ||
            Boolean(process.env.NVAPI_KEY))
            ? "meta/llama-3.1-8b-instruct"
            : "gpt-4o",
        complex:
          !process.env.OPENAI_API_KEY &&
          (Boolean(process.env.NVIDIA_API_KEY) ||
            Boolean(process.env.NVAPI_KEY))
            ? "meta/llama-3.1-8b-instruct"
            : "o1-preview",
        reasoning:
          !process.env.OPENAI_API_KEY &&
          (Boolean(process.env.NVIDIA_API_KEY) ||
            Boolean(process.env.NVAPI_KEY))
            ? "meta/llama-3.1-8b-instruct"
            : "o1-preview",
        embedding: "text-embedding-3-small",
      },
      gemini: {
        simple: "gemini-2.0-flash",
        code: "gemini-2.0-flash",
        complex: "gemini-2.0-pro",
        reasoning: "gemini-2.0-pro",
        embedding: "text-embedding-004",
      },
      ollama: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      groq: {
        simple: "llama-3.1-8b-instant",
        code: "llama-3.3-70b-versatile",
        complex: "llama-3.3-70b-versatile",
        reasoning: "llama-3.3-70b-versatile",
        embedding: "text-embedding-3-small",
      },
      openrouter: {
        simple: "stepfun/step-3.5-flash:free",
        code: "stepfun/step-3.5-flash:free",
        complex: "stepfun/step-3.5-flash:free",
        reasoning: "stepfun/step-3.5-flash:free",
        embedding: "google/gemma-2-9b-it:free",
      },
      huggingface: {
        simple: "meta-llama/Llama-3.2-1B-Instruct",
        code: "meta-llama/Llama-3.2-3B-Instruct",
        complex: "Qwen/Qwen2.5-7B-Instruct",
        reasoning: "Qwen/Qwen2.5-7B-Instruct",
        embedding: "BAAI/bge-small-en-v1.5",
      },
      "ollama-cloud": {
        simple: "llama3.2",
        code: "llama3.2",
        complex: "llama3.1",
        reasoning: "llama3.1",
        embedding: "nomic-embed-text",
      },
    };

    return (
      modelMap[providerType]?.[taskCategory] ?? modelMap.local[taskCategory]
    );
  }

  private getBetterModel(
    taskCategory: TaskCategory,
    providerType: ProviderType,
  ): string {
    const qualityMap: Record<ProviderType, Record<TaskCategory, string>> = {
      local: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      claude: {
        simple: "claude-sonnet-4-6",
        code: "claude-opus-4-6",
        complex: "claude-opus-4-6",
        reasoning: "claude-opus-4-6",
        embedding: "claude-haiku-4-5-20251001",
      },
      openai: {
        simple: "gpt-4o",
        code: "o1-preview",
        complex: "o1-preview",
        reasoning: "o1-preview",
        embedding: "text-embedding-3-large",
      },
      gemini: {
        simple: "gemini-2.0-pro",
        code: "gemini-2.0-pro",
        complex: "gemini-2.0-pro",
        reasoning: "gemini-2.0-pro",
        embedding: "text-embedding-004",
      },
      ollama: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      groq: {
        simple: "llama-3.3-70b-versatile",
        code: "llama-3.3-70b-versatile",
        complex: "llama-3.3-70b-versatile",
        reasoning: "llama-3.3-70b-versatile",
        embedding: "text-embedding-3-small",
      },
      openrouter: {
        simple: "meta-llama/llama-3.1-70b-instruct",
        code: "meta-llama/llama-3.1-70b-instruct",
        complex: "meta-llama/llama-3.1-70b-instruct",
        reasoning: "meta-llama/llama-3.1-70b-instruct",
        embedding: "google/gemma-2-9b-8192-it",
      },
      huggingface: {
        simple: "Qwen/Qwen2.5-Coder-3B-Instruct",
        code: "Qwen/Qwen2.5-7B-Instruct",
        complex: "Qwen/Qwen2.5-7B-Instruct",
        reasoning: "Qwen/Qwen2.5-7B-Instruct",
        embedding: "BAAI/bge-small-en-v1.5",
      },
      "ollama-cloud": {
        simple: "llama3.2",
        code: "llama3.2",
        complex: "llama3.1",
        reasoning: "llama3.1",
        embedding: "nomic-embed-text",
      },
    };

    return (
      qualityMap[providerType]?.[taskCategory] ??
      this.getDefaultModelForCategory(providerType, taskCategory)
    );
  }

  private getFasterModel(
    taskCategory: TaskCategory,
    providerType: ProviderType,
  ): string {
    const speedMap: Record<ProviderType, Record<TaskCategory, string>> = {
      local: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      claude: {
        simple: "claude-haiku-4-5-20251001",
        code: "claude-haiku-4-5-20251001",
        complex: "claude-sonnet-4-6",
        reasoning: "claude-sonnet-4-6",
        embedding: "claude-haiku-4-5-20251001",
      },
      openai: {
        simple: "gpt-4o-mini",
        code: "gpt-4o-mini",
        complex: "gpt-4o",
        reasoning: "gpt-4o",
        embedding: "text-embedding-3-small",
      },
      gemini: {
        simple: "gemini-2.0-flash",
        code: "gemini-2.0-flash",
        complex: "gemini-2.0-flash",
        reasoning: "gemini-2.0-flash",
        embedding: "text-embedding-004",
      },
      ollama: {
        simple: "qwen2.5-coder:latest",
        code: "qwen2.5-coder:latest",
        complex: "qwen2.5-coder:latest",
        reasoning: "qwen2.5-coder:latest",
        embedding: "nomic-embed-text",
      },
      groq: {
        simple: "llama-3.1-8b-instant",
        code: "llama-3.1-8b-instant",
        complex: "llama-3.3-70b-versatile",
        reasoning: "llama-3.1-8b-instant",
        embedding: "text-embedding-3-small",
      },
      openrouter: {
        simple: "google/gemma-2-9b-8192-it",
        code: "google/gemma-2-9b-8192-it",
        complex: "meta-llama/llama-3.1-8b-instruct",
        reasoning: "google/gemma-2-9b-8192-it",
        embedding: "google/gemma-2-9b-8192-it",
      },
      huggingface: {
        simple: "meta-llama/Llama-3.2-1B-Instruct",
        code: "meta-llama/Llama-3.2-1B-Instruct",
        complex: "Qwen/Qwen2.5-Coder-3B-Instruct",
        reasoning: "meta-llama/Llama-3.2-1B-Instruct",
        embedding: "BAAI/bge-small-en-v1.5",
      },
      "ollama-cloud": {
        simple: "llama3.2",
        code: "llama3.2",
        complex: "llama3.2",
        reasoning: "llama3.2",
        embedding: "nomic-embed-text",
      },
    };

    return (
      speedMap[providerType]?.[taskCategory] ??
      this.getDefaultModelForCategory(providerType, taskCategory)
    );
  }

  private estimateCost(model: string, tokens: number): number {
    const spec = MODEL_SPECS[model];
    if (!spec || spec.cost === 0) return 0;
    return (tokens / 1_000_000) * spec.cost;
  }

  private estimateLatency(model: string, tokens: number): number {
    const spec = MODEL_SPECS[model];
    if (!spec) return 5000; // Default 5 seconds

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
