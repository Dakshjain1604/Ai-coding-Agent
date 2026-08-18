/**
 * Config Command - Manage CodingAgent configuration
 */

import { Command, Args } from "@oclif/core";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import {
  getConfig,
  setConfig,
  listConfig,
  maskApiKey,
  getConfigManager,
} from "../../utils/config.js";
import type { ProviderConfig } from "../../utils/types.js";

/**
 * config.providers is an array (ProviderConfig[]), not a name-keyed
 * object — `Object.entries(providers)` used to yield ["0", provider],
 * ["1", provider]... so `config list` printed numeric array indices
 * ("0:", "1:") instead of the actual provider name ("claude:", "groq:").
 * Confirmed live before fixing. apiKey is intentionally never included
 * here, even masked — must stay scoped to non-secret fields.
 */
export function formatProviderLines(providers: ProviderConfig[] | undefined): string[] {
  const lines: string[] = [];
  for (const provider of providers ?? []) {
    lines.push(`  ${provider.type}:`);
    lines.push(`    enabled: ${provider.enabled}`);
    lines.push(
      `    models: ${Object.entries(provider.models || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  return lines;
}

export default class ConfigCommand extends Command {
  static description = "Manage CodingAgent configuration";

  static args = {
    action: Args.string({
      required: true,
      description: "Action to perform (get, set, list, init)",
    }),
    key: Args.string({
      description: "Configuration key (for get/set)",
    }),
    value: Args.string({
      description: "Configuration value (for set)",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigCommand);

    switch (args.action) {
      case "get":
        await this.get(args.key);
        break;
      case "set":
        await this.set(args.key, args.value);
        break;
      case "list":
        await this.list();
        break;
      case "init":
        await this.initializeConfig();
        break;
    }
  }

  private async get(key?: string): Promise<void> {
    if (!key) {
      this.error("Please specify a configuration key");
    }

    const config = getConfig();
    const value = key.split(".").reduce((obj: any, k) => obj?.[k], config);

    if (value === undefined) {
      this.log(chalk.yellow(`Configuration key not found: ${key}`));
    } else {
      const display =
        key.endsWith("apiKey") && typeof value === "string"
          ? maskApiKey(value)
          : value;
      this.log(chalk.white(`${key}: ${JSON.stringify(display, null, 2)}`));
    }
  }

  private async set(key?: string, value?: string): Promise<void> {
    if (!key || value === undefined) {
      this.error("Please specify both key and value");
    }

    // setConfig() only ever mutated the in-memory ConfigManager singleton
    // — nothing called .save() afterward, so "Configuration updated"
    // was true only for the remainder of this one-shot CLI process,
    // which exits immediately after printing it. The change was
    // silently discarded every single time; the next `config get`/
    // `config list` (a fresh process) never saw it. Confirmed live: set
    // a providers.N.apiKey, immediately got "Configuration updated",
    // then `config get` on that exact key reported "not found".
    try {
      const parsedValue = JSON.parse(value);
      setConfig(key, parsedValue);
    } catch {
      setConfig(key, value);
    }
    getConfigManager().save();
    this.log(chalk.green(`Configuration updated: ${key} = ${value}`));
  }

  private async list(): Promise<void> {
    const config = listConfig();

    this.log(chalk.bold.cyan("\n⚙️  CodingAgent Configuration\n"));

    this.log(chalk.bold.white("\nProviders:"));
    for (const line of formatProviderLines(config.providers)) {
      this.log(chalk.gray(line));
    }

    this.log(chalk.bold.white("\nDefaults:"));
    this.log(chalk.gray(`  preferLocal: ${config.defaults.preferLocal}`));
    this.log(chalk.gray(`  fallbackToPaid: ${config.defaults.fallbackToPaid}`));
    this.log(
      chalk.gray(
        `  complexityThreshold: ${config.defaults.complexityThreshold}`,
      ),
    );
    this.log(
      chalk.gray(`  maxParallelAgents: ${config.defaults.maxParallelAgents}`),
    );
  }

  private async initializeConfig(): Promise<void> {
    this.log(chalk.bold.cyan("\n📝 Initializing CodingAgent Configuration\n"));

    // Used to just print a success message without ever writing a file —
    // `// Create default config files` documented the intent as a
    // comment, but nothing after it actually did so, despite
    // ConfigManager.save() already existing and doing exactly this.
    // load() populates defaults merged with any existing project config
    // (never destructive — existing values always win the merge), then
    // save() writes it to coding-agent.json.
    const manager = getConfigManager();
    manager.load();
    manager.save();

    this.log(chalk.green("Configuration initialized successfully!"));
    this.log(
      chalk.gray("\nRun `coding-agent config list` to see current settings."),
    );
  }
}
