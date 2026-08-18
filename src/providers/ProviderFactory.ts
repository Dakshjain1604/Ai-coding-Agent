/**
 * Provider Factory - Creates and manages LLM provider instances
 * Handles provider selection, caching, and fallback logic
 */

import type { ProviderType, ProviderConfig } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";
import { getConfigManager } from "../utils/config.js";
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

    // Used to always pass a bare {type, enabled:true, models:{}} stub
    // here — apiKey/baseUrl/models from the user's real, configured
    // provider entry (coding-agent.json / `config set`) were never
    // looked up at all, for ANY provider, on this path. Masked by each
    // provider's own process.env fallback for apiKey in the common case
    // (env vars are CLAUDE.md's documented primary configuration
    // method), but ollama-cloud's baseUrl has no such fallback — it was
    // completely unusable through this factory regardless of how a user
    // configured it, since its required baseUrl could never reach the
    // constructor. Now looks up the real entry from AppConfig.providers
    // by type, falling back to the old stub only when no entry exists
    // for that provider type at all.
    const configured = getConfigManager().get().providers.find((p) => p.type === type);
    return this.create(configured ?? { type, enabled: true, models: {} });
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
  ):
    | ClaudeConfig
    | OpenAIConfig
    | GeminiConfig
    | LocalConfig
    | GroqConfig
    | OpenRouterConfig
    | HuggingFaceConfig
    | OllamaCloudConfig {
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
      // These four used to fall through to the `default: return {}` branch
      // below — apiKey/baseUrl/defaultModel from the user's real config
      // were silently discarded for every one of them. Masked in practice
      // by each provider's own process.env fallback (confirmed live: real
      // Groq calls succeeded via GROQ_API_KEY during this session's
      // testing) — but a user configuring apiKey via coding-agent.json/
      // `config set` instead of an env var would have it silently
      // ignored. ollama-cloud was the worst case: its baseUrl has NO env
      // var fallback at all, so it was completely unusable through this
      // factory regardless of how a user configured it.
      case "groq":
        return {
          apiKey: config.apiKey as string | undefined,
          defaultModel: models?.code,
        };
      case "openrouter":
        return {
          apiKey: config.apiKey as string | undefined,
          defaultModel: models?.code,
        };
      case "huggingface":
        return {
          apiKey: config.apiKey as string | undefined,
          defaultModel: models?.code,
        };
      case "ollama-cloud":
        return {
          baseUrl: config.baseUrl as string | undefined,
          apiKey: config.apiKey as string | undefined,
          defaultModel: models?.code,
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
