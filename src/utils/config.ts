/**
 * Configuration management for CodingAgent
 * Handles loading, validation, and merging of config files
 */

import { load } from "js-yaml";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
import type {
  AppConfig,
  ProviderConfig,
  AgentConfig,
  AgentType,
} from "./types.js";
import { CodingAgentError } from "./types.js";

// ============================================================================
// Config Schemas
// ============================================================================

const ProviderConfigSchema = z.object({
  type: z.enum([
    "ollama",
    "claude",
    "openai",
    "gemini",
    "local",
    "groq",
    "openrouter",
    "huggingface",
    "ollama-cloud",
  ]),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  models: z
    .object({
      simple: z.string().optional(),
      code: z.string().optional(),
      complex: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
});

const AgentConfigSchema = z.object({
  model: z.string(),
  maxTokens: z.number().default(128000),
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().default(50),
  timeout: z.number().default(300000),
});

const DefaultsSchema = z.object({
  preferLocal: z.boolean().default(true),
  fallbackToPaid: z.boolean().default(false),
  maxParallelAgents: z.number().default(5),
  complexityThreshold: z.number().default(0.7),
  maxPaidApiCalls: z.number().default(0),
  outputDir: z.string().default("output"),
  /** Stream LLM tokens to the terminal as they arrive, instead of buffering the full response. */
  streaming: z.boolean().default(true),
});

const AppConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema).default([]),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  defaults: DefaultsSchema.default({}),
});

// ============================================================================
// Config Manager
// ============================================================================

export interface ConfigPaths {
  projectRoot: string;
  projectConfigJson: string;
  projectConfigYaml: string;
  globalConfig: string;
  memoryDir: string;
  plansDir: string;
}

export class ConfigManager {
  private config: AppConfig | null = null;
  private paths: ConfigPaths;

  constructor(projectRoot?: string) {
    this.paths = this.resolvePaths(projectRoot);
  }

  private resolvePaths(projectRoot?: string): ConfigPaths {
    const root = projectRoot ?? process.cwd();
    return {
      projectRoot: root,
      projectConfigJson: join(root, "coding-agent.json"),
      projectConfigYaml: join(root, ".claude", "config.yaml"),
      globalConfig: join(homedir(), ".coding-agent", "config.yaml"),
      memoryDir: join(root, ".claude", "memory"),
      plansDir: join(root, "plans"),
    };
  }

  /**
   * Load configuration from files and merge with defaults
   */
  load(): AppConfig {
    if (this.config) {
      return this.config;
    }

    const defaultConfig = this.getDefaultConfig();

    const globalConfig = this.loadYamlFile(this.paths.globalConfig);

    const projectConfigJson = this.loadJsonFile(this.paths.projectConfigJson);
    const projectConfigYaml = this.loadYamlFile(this.paths.projectConfigYaml);
    const projectConfig = projectConfigJson || projectConfigYaml;

    this.config = this.mergeConfigs(
      defaultConfig,
      globalConfig,
      projectConfig,
    ) as AppConfig;

    const result = AppConfigSchema.safeParse(this.config);
    if (!result.success) {
      throw new CodingAgentError("Invalid configuration", "CONFIG_ERROR", {
        errors: result.error.errors,
      });
    }

    this.config = result.data as AppConfig;
    return this.config;
  }

  /**
   * Get current configuration (loads if not already loaded)
   */
  get(): AppConfig {
    return this.config ?? this.load();
  }

  /**
   * Get a specific config value by key (e.g., "defaults.preferLocal")
   */
  getConfigValue(key: string): unknown {
    const config = this.get();
    const keys = key.split(".");
    let value: any = config;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) return undefined;
    }
    return value;
  }

  /**
   * Set a specific config value by key
   */
  setConfigValue(key: string, value: unknown): void {
    const config = this.get();
    const keys = key.split(".");
    let obj: any = config;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }

    obj[keys[keys.length - 1]] = value;
    this.config = config;
  }

  /**
   * Get configuration paths
   */
  getPaths(): ConfigPaths {
    return { ...this.paths };
  }

  /**
   * Update configuration
   */
  update(updates: Partial<AppConfig>): void {
    const current = this.get();
    this.config = { ...current, ...updates };
  }

  /**
   * Save configuration to project file
   */
  save(): void {
    if (!this.config) {
      return;
    }

    const jsonContent = JSON.stringify(this.config, null, 2);
    writeFileSync(this.paths.projectConfigJson, jsonContent, "utf-8");
  }

  /**
   * Get provider configuration by type
   */
  getProvider(type: string): ProviderConfig | undefined {
    return this.get().providers.find((p) => p.type === type);
  }

  /**
   * Get agent configuration by type
   */
  getAgent(type: AgentType): AgentConfig {
    const config = this.get();
    const agentDefaults = this.getDefaultAgentConfig();
    return {
      ...agentDefaults,
      ...config.agents[type],
    } as AgentConfig;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private getDefaultConfig(): AppConfig {
    return {
      providers: [
        {
          type: "ollama",
          baseUrl: "http://localhost:11434",
          models: {
            simple: "qwen2.5-coder:latest",
            code: "qwen2.5-coder:latest",
            complex: "qwen2.5-coder:latest",
          },
          enabled: true,
        },
        {
          type: "openai",
          models: {},
          enabled: true,
        },
        {
          type: "claude",
          models: {},
          enabled: true,
        },
        {
          type: "gemini",
          models: {},
          enabled: true,
        },
        {
          type: "groq",
          models: {},
          enabled: true,
        },
        {
          type: "openrouter",
          models: {},
          enabled: true,
        },
      ],
      agents: {
        orchestrator: {
          type: "orchestrator",
          model: "qwen2.5-coder:latest",
          maxTokens: 200000,
          tools: ["planning", "file_system", "git"],
          maxIterations: 50,
          timeout: 600000,
        },
        code: {
          type: "code",
          model: "qwen2.5-coder:latest",
          maxTokens: 128000,
          tools: ["file_system", "shell", "git"],
          maxIterations: 50,
          timeout: 300000,
        },
        test: {
          type: "test",
          model: "qwen2.5-coder:latest",
          maxTokens: 128000,
          tools: ["test_runner", "file_system"],
          maxIterations: 30,
          timeout: 300000,
        },
        debug: {
          type: "debug",
          model: "qwen2.5-coder:latest",
          maxTokens: 200000,
          tools: ["logs", "shell", "file_system"],
          maxIterations: 30,
          timeout: 300000,
        },
        plan: {
          type: "plan",
          model: "qwen2.5-coder:latest",
          maxTokens: 200000,
          tools: ["file_system", "git"],
          maxIterations: 20,
          timeout: 300000,
        },
        review: {
          type: "review",
          model: "qwen2.5-coder:latest",
          maxTokens: 128000,
          tools: ["diff", "linter", "file_system"],
          maxIterations: 20,
          timeout: 180000,
        },
      },
      defaults: {
        preferLocal: true,
        fallbackToPaid: false,
        maxParallelAgents: 5,
        complexityThreshold: 0.7,
        maxPaidApiCalls: 0,
        outputDir: "output",
        streaming: true,
      },
    };
  }

  private getDefaultAgentConfig(): Omit<AgentConfig, "model"> {
    return {
      type: "code",
      maxTokens: 128000,
      tools: ["file_system", "shell"],
      maxIterations: 50,
      timeout: 300000,
    };
  }

  private loadYamlFile(path: string): Record<string, unknown> | null {
    try {
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, "utf-8");
      return load(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private loadJsonFile(path: string): Record<string, unknown> | null {
    try {
      if (!existsSync(path)) {
        return null;
      }
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private mergeConfigs(
    ...configs: (Record<string, unknown> | null)[]
  ): AppConfig {
    const merged: Record<string, unknown> = {};

    for (const config of configs) {
      if (!config) continue;
      for (const [key, value] of Object.entries(config)) {
        if (value !== null && value !== undefined) {
          // Deep merge for objects, replace for primitives
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
          ) {
            merged[key] = this.deepMerge(
              (merged[key] as Record<string, unknown>) ?? {},
              value as Record<string, unknown>,
            );
          } else {
            // For arrays and primitives, use the newer value
            merged[key] = value;
          }
        }
      }
    }

    return merged as unknown as AppConfig;
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        result[key] = this.deepMerge(
          (result[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

}

/**
 * Mask a secret value for display — never for storage or provider routing,
 * which both need the real value. Short values are fully masked since a
 * partial reveal would leak most of a short key.
 */
export function maskApiKey(key?: string): string {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// Singleton instance
let configManagerInstance: ConfigManager | null = null;

export function createConfigManager(projectRoot?: string): ConfigManager {
  configManagerInstance = new ConfigManager(projectRoot);
  return configManagerInstance;
}

export function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManager();
  }
  return configManagerInstance;
}

/**
 * Get a configuration value by key
 */
export function getConfig(key?: string): unknown {
  const manager = getConfigManager();
  const config = manager.get();

  if (!key) return config;

  const keys = key.split(".");
  let value: any = config;
  for (const k of keys) {
    value = value?.[k];
    if (value === undefined) return undefined;
  }
  return value;
}

/**
 * Set a configuration value by key
 */
export function setConfig(key: string, value: unknown): void {
  const manager = getConfigManager();
  const config = manager.get();

  const keys = key.split(".");
  let obj: any = config;

  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }

  obj[keys[keys.length - 1]] = value;
  manager.update(config);
}

/**
 * List all configuration
 */
export function listConfig(): AppConfig {
  return getConfigManager().get();
}
