/**
 * Provider Factory - Creates and manages LLM provider instances
 * Handles provider selection, caching, and fallback logic
 */

import type { ProviderType, ProviderConfig } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";
import { BaseProvider } from "./ProviderInterface.js";
import { ClaudeProvider, type ClaudeConfig } from "./ClaudeProvider.js";
import { OpenAIProvider, type OpenAIConfig } from "./OpenAIProvider.js";
import { GeminiProvider, type GeminiConfig } from "./GeminiProvider.js";
import { LocalProvider, type LocalConfig } from "./LocalProvider.js";
import { GroqProvider, type GroqConfig } from "./GroqProvider.js";
import {
  OpenRouterProvider,
  type OpenRouterConfig,
} from "./OpenRouterProvider.js";
import {
  HuggingFaceProvider,
  type HuggingFaceConfig,
} from "./HuggingFaceProvider.js";
import {
  OllamaCloudProvider,
  type OllamaCloudConfig,
} from "./OllamaCloudProvider.js";
import { ProviderError } from "../utils/types.js";

export interface ProviderOptions {
  preferLocal?: boolean;
  fallbackToPaid?: boolean;
  enableCache?: boolean;
}

type ProviderConstructor<T extends BaseProvider> = new (
  config?: Record<string, unknown>,
) => T;

/**
 * Provider Factory
 * Creates and manages provider instances with intelligent routing
 */
export class ProviderFactory {
  private static instance: ProviderFactory | null = null;
  private providers: Map<ProviderType, BaseProvider> = new Map();
  private availability: Map<ProviderType, boolean> = new Map();
  private options: ProviderOptions;
  private logger = getLogger();

  private constructor(options?: ProviderOptions) {
    this.options = {
      preferLocal: true,
      fallbackToPaid: false,
      enableCache: true,
      ...options,
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(options?: ProviderOptions): ProviderFactory {
    if (!ProviderFactory.instance) {
      ProviderFactory.instance = new ProviderFactory(options);
    }
    return ProviderFactory.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static reset(): void {
    ProviderFactory.instance = null;
  }

  /**
   * Create a provider instance
   */
  async create(config: ProviderConfig): Promise<BaseProvider> {
    const { type, ...restConfig } = config;

    // Check cache first
    if (this.options.enableCache && this.providers.has(type)) {
      return this.providers.get(type)!;
    }

    // Create provider instance
    const provider = this.instantiateProvider(type, restConfig);

    // Cache it
    if (this.options.enableCache) {
      this.providers.set(type, provider);
    }

    return provider;
  }

  /**
   * Get provider by type (creates if not exists)
   */
  async get(type: ProviderType): Promise<BaseProvider> {
    if (this.providers.has(type)) {
      return this.providers.get(type)!;
    }

    // Create with default config
    return this.create({ type, enabled: true, models: {} });
  }

  /**
   * Check if provider is available
   */
  async isAvailable(type: ProviderType): Promise<boolean> {
    if (this.availability.has(type)) {
      return this.availability.get(type)!;
    }

    try {
      const provider = await this.get(type);
      const available = await provider.isAvailable();
      this.availability.set(type, available);
      return available;
    } catch {
      this.availability.set(type, false);
      return false;
    }
  }

  /**
   * Get best available provider for a task type
   * Respects preferLocal and fallbackToPaid settings
   */
  async getBestProvider(
    taskType: "simple" | "code" | "complex",
  ): Promise<BaseProvider> {
    const { preferLocal, fallbackToPaid } = this.options;

    // Priority order based on settings
    const priority: ProviderType[] = preferLocal
      ? ["local", "gemini", "openai", "claude"]
      : ["claude", "openai", "gemini", "local"];

    // Filter out paid APIs if fallbackToPaid is false
    const candidates: ProviderType[] = fallbackToPaid
      ? priority
      : preferLocal
        ? ["local"] // Local only if fallbackToPaid is false
        : priority;

    for (const type of candidates) {
      const available = await this.isAvailable(type);
      if (available) {
        this.logger.info(`Using ${type} provider for ${taskType} task`);
        return this.get(type);
      }
    }

    throw new ProviderError("No available providers found", "local", {
      hint: preferLocal
        ? "Ensure Ollama is running (ollama serve) or enable fallbackToPaid"
        : "Set API keys for paid providers (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY)",
    });
  }

  /**
   * Get all available providers
   */
  async getAvailable(): Promise<BaseProvider[]> {
    const types: ProviderType[] = ["local", "claude", "openai", "gemini"];
    const available: BaseProvider[] = [];

    for (const type of types) {
      if (await this.isAvailable(type)) {
        available.push(await this.get(type));
      }
    }

    return available;
  }

  /**
   * Clear provider cache
   */
  clearCache(): void {
    this.providers.clear();
    this.availability.clear();
  }

  /**
   * Update options
   */
  setOptions(options: Partial<ProviderOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private instantiateProvider(
    type: ProviderType,
    config: Record<string, unknown>,
  ): BaseProvider {
    const providerConstructors: Record<
      ProviderType,
      ProviderConstructor<BaseProvider>
    > = {
      claude: ClaudeProvider,
      openai: OpenAIProvider,
      gemini: GeminiProvider,
      local: LocalProvider,
      ollama: LocalProvider,
      groq: GroqProvider,
      openrouter: OpenRouterProvider,
      huggingface: HuggingFaceProvider,
      "ollama-cloud": OllamaCloudProvider,
    };

    const ProviderClass = providerConstructors[type];
    if (!ProviderClass) {
      throw new ProviderError(`Unknown provider type: ${type}`, type);
    }

    // Cast config to appropriate type
    const typedConfig = this.getConfigForProvider(type, config);

    return new ProviderClass(typedConfig as never) as BaseProvider;
  }

  private getConfigForProvider(
    type: ProviderType,
    config: Record<string, unknown>,
  ): ClaudeConfig | OpenAIConfig | GeminiConfig | LocalConfig {
    const models = config.models as Record<string, string> | undefined;
    switch (type) {
      case "claude":
        return {
          apiKey: config.apiKey as string | undefined,
          baseUrl: config.baseUrl as string | undefined,
          defaultModel: models?.complex,
        };
      case "openai":
        return {
          apiKey: config.apiKey as string | undefined,
          baseUrl: config.baseUrl as string | undefined,
          defaultModel: models?.code,
        };
      case "gemini":
        return {
          apiKey: config.apiKey as string | undefined,
          defaultModel: models?.simple,
        };
      case "local":
      case "ollama":
        return {
          baseUrl: config.baseUrl as string | undefined,
          defaultModel: models?.code,
          provider: "ollama",
        };
      default:
        return {};
    }
  }
}

/**
 * Convenience function to get the factory instance
 */
export function getProviderFactory(options?: ProviderOptions): ProviderFactory {
  return ProviderFactory.getInstance(options);
}

/**
 * Convenience function to create a provider
 */
export async function createProvider(
  config: ProviderConfig,
): Promise<BaseProvider> {
  const factory = ProviderFactory.getInstance();
  return factory.create(config);
}
