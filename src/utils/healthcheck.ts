/**
 * Provider Health Check
 * Validates provider availability at startup with clear error messages
 */

import { getProviderFactory } from "../providers/ProviderFactory.js";
import { getConfigManager } from "../utils/config.js";
import chalk from "chalk";
import type { ProviderConfig } from "../utils/types.js";

export interface HealthCheckResult {
  healthy: boolean;
  provider: string;
  available: boolean;
  message: string;
  suggestions?: string[];
}

export interface ProviderHealthStatus {
  overall: boolean;
  checks: HealthCheckResult[];
  primaryProvider: string;
}

/**
 * Check health of all configured providers
 */
export async function checkProviderHealth(): Promise<ProviderHealthStatus> {
  const config = getConfigManager().get();
  const factory = getProviderFactory({
    preferLocal: true,
    fallbackToPaid: false,
  });

  const checks: HealthCheckResult[] = [];
  let primaryProvider = "local";

  // Check Ollama/Local provider first (default)
  const localCheck = await checkLocalProvider(factory);
  checks.push(localCheck);
  if (localCheck.available) {
    primaryProvider = "local";
  }

  // Check Claude if enabled
  const claudeEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "claude",
  )?.enabled;
  let claudeCheck: HealthCheckResult | null = null;
  if (claudeEnabled) {
    claudeCheck = await checkCloudProvider(
      factory,
      "claude",
      "ANTHROPIC_API_KEY",
    );
    checks.push(claudeCheck);
    if (!localCheck.available && claudeCheck.available) {
      primaryProvider = "claude";
    }
  }

  // Check OpenAI if enabled
  const openaiEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "openai",
  )?.enabled;
  if (openaiEnabled) {
    const openaiCheck = await checkCloudProvider(
      factory,
      "openai",
      "OPENAI_API_KEY",
    );
    checks.push(openaiCheck);
    if (
      !localCheck.available &&
      !claudeCheck?.available &&
      openaiCheck.available
    ) {
      primaryProvider = "openai";
    }
  }

  // Check Gemini if enabled
  const geminiEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "gemini",
  )?.enabled;
  if (geminiEnabled) {
    const geminiCheck = await checkCloudProvider(
      factory,
      "gemini",
      "GOOGLE_API_KEY",
    );
    checks.push(geminiCheck);
  }

  // Check Groq if enabled (free tier!)
  const groqEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "groq",
  )?.enabled;
  let groqCheck: HealthCheckResult | null = null;
  if (groqEnabled) {
    groqCheck = await checkCloudProvider(factory, "groq", "GROQ_API_KEY");
    checks.push(groqCheck);
    if (
      !localCheck.available &&
      !claudeCheck?.available &&
      groqCheck.available
    ) {
      primaryProvider = "groq";
    }
  }

  // Check OpenRouter if enabled (free models!)
  const openrouterEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "openrouter",
  )?.enabled;
  let openrouterCheck: HealthCheckResult | null = null;
  if (openrouterEnabled) {
    openrouterCheck = await checkCloudProvider(
      factory,
      "openrouter",
      "OPENROUTER_API_KEY",
    );
    checks.push(openrouterCheck);
    if (
      !localCheck.available &&
      !claudeCheck?.available &&
      !groqCheck?.available &&
      openrouterCheck.available
    ) {
      primaryProvider = "openrouter";
    }
  }

  // Check HuggingFace if enabled (free tier!)
  const huggingfaceEnabled = config.providers.find(
    (p: ProviderConfig) => p.type === "huggingface",
  )?.enabled;
  if (huggingfaceEnabled) {
    const hfCheck = await checkCloudProvider(
      factory,
      "huggingface",
      "HUGGINGFACE_API_KEY",
    );
    checks.push(hfCheck);
  }

  const healthy = checks.some((c) => c.available);

  return {
    overall: healthy,
    checks,
    primaryProvider,
  };
}

async function checkLocalProvider(
  factory: ReturnType<typeof getProviderFactory>,
): Promise<HealthCheckResult> {
  try {
    const available = await factory.isAvailable("local");
    if (available) {
      return {
        healthy: true,
        provider: "local (Ollama)",
        available: true,
        message: "Local provider is available",
      };
    }

    return {
      healthy: false,
      provider: "local (Ollama)",
      available: false,
      message: "Ollama is not running or has no models available",
      suggestions: [
        "Start Ollama: ollama serve",
        "Pull a model: ollama pull qwen2.5-coder:latest",
        "List models: ollama list",
      ],
    };
  } catch (error) {
    return {
      healthy: false,
      provider: "local (Ollama)",
      available: false,
      message: `Failed to connect to Ollama: ${error instanceof Error ? error.message : "Unknown error"}`,
      suggestions: [
        "Make sure Ollama is installed: https://ollama.ai",
        "Start Ollama: ollama serve",
        "Check Ollama is running on http://localhost:11434",
      ],
    };
  }
}

async function checkCloudProvider(
  factory: ReturnType<typeof getProviderFactory>,
  type: "claude" | "openai" | "gemini" | "groq" | "openrouter" | "huggingface",
  envVar: string,
): Promise<HealthCheckResult> {
  try {
    const available = await factory.isAvailable(type);

    if (available) {
      return {
        healthy: true,
        provider: type,
        available: true,
        message: `${type} provider is available`,
      };
    }

    return {
      healthy: false,
      provider: type,
      available: false,
      message: `API key not found or ${type} is not available`,
      suggestions: [
        `Set ${envVar} environment variable`,
        `Get API key from ${getApiKeyUrl(type)}`,
      ],
    };
  } catch (error) {
    return {
      healthy: false,
      provider: type,
      available: false,
      message: `Failed to connect to ${type}: ${error instanceof Error ? error.message : "Unknown error"}`,
      suggestions: [
        `Check your ${envVar} is correct`,
        "Ensure you have API access enabled",
      ],
    };
  }
}

function getApiKeyUrl(type: string): string {
  switch (type) {
    case "claude":
      return "https://console.anthropic.com/settings/keys";
    case "openai":
      return "https://platform.openai.com/api-keys";
    case "gemini":
      return "https://aistudio.google.com/app/apikey";
    default:
      return "the provider's website";
  }
}

/**
 * Print health check results to console
 */
export function printProviderHealth(status: ProviderHealthStatus): void {
  console.log(chalk.bold("\n🔍 Provider Health Check\n"));

  for (const check of status.checks) {
    if (check.available) {
      console.log(chalk.green(`  ✓ ${check.provider}: ${check.message}`));
    } else {
      console.log(chalk.red(`  ✗ ${check.provider}: ${check.message}`));
      if (check.suggestions) {
        for (const suggestion of check.suggestions) {
          console.log(chalk.gray(`    → ${suggestion}`));
        }
      }
    }
  }

  console.log("");
  if (status.overall) {
    console.log(chalk.green.bold(`  Using: ${status.primaryProvider}`));
  } else {
    console.log(chalk.red.bold("  ⚠ No providers available!"));
    console.log(chalk.gray("    Please fix the issues above or set up Ollama"));
  }
  console.log("");
}

/**
 * Validate providers before executing a task
 * Throws descriptive error if no providers available
 */
export async function validateProviders(): Promise<void> {
  const status = await checkProviderHealth();

  if (!status.overall) {
    printProviderHealth(status);
    throw new Error(
      "No LLM providers available. Please set up Ollama or configure API keys.\n" +
        "Run 'ollama serve' to start local models, or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY",
    );
  }
}
