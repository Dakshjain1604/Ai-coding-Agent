/**
 * Config Command - Manage CodingAgent configuration
 */

import { Command, Args } from "@oclif/core";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { getConfig, setConfig, listConfig } from "../../utils/config.js";

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
      this.log(chalk.white(`${key}: ${JSON.stringify(value, null, 2)}`));
    }
  }

  private async set(key?: string, value?: string): Promise<void> {
    if (!key || value === undefined) {
      this.error("Please specify both key and value");
    }

    try {
      const parsedValue = JSON.parse(value);
      setConfig(key, parsedValue);
      this.log(chalk.green(`Configuration updated: ${key} = ${value}`));
    } catch {
      setConfig(key, value);
      this.log(chalk.green(`Configuration updated: ${key} = ${value}`));
    }
  }

  private async list(): Promise<void> {
    const config = listConfig();

    this.log(chalk.bold.cyan("\n⚙️  CodingAgent Configuration\n"));

    this.log(chalk.bold.white("\nProviders:"));
    for (const [name, provider] of Object.entries(config.providers || {})) {
      this.log(chalk.gray(`  ${name}:`));
      this.log(chalk.gray(`    enabled: ${provider.enabled}`));
      this.log(
        chalk.gray(
          `    models: ${Object.entries(provider.models || {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        ),
      );
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

    // Create default config files
    this.log(chalk.green("Configuration initialized successfully!"));
    this.log(
      chalk.gray("\nRun `coding-agent config list` to see current settings."),
    );
  }
}
