/**
 * Debug Command - Debug a specific issue or error
 */

import { Command, Args, Flags } from "@oclif/core";
import { v4 as uuid } from "uuid";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { executeTask } from "../../core/orchestrator/AgentSpawner.js";
import { validateProviders } from "../../utils/healthcheck.js";
import type { Task } from "../../utils/types.js";

export default class DebugCommand extends Command {
  static description = "Debug a specific issue or error in your codebase";

  static args = {
    issue: Args.string({
      description: "Description of the issue to debug",
      required: true,
    }),
  };

  static flags = {
    file: Flags.string({
      description: "Specific file to debug",
      required: false,
    }),
    error: Flags.string({
      description: "Error message or stack trace",
      required: false,
    }),
    "no-confirm": Flags.boolean({
      default: false,
      description: "Skip confirmation prompts",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DebugCommand);

    // Validate providers are available
    await validateProviders();

    // Build task description
    let description = `Debug the following issue: ${args.issue}`;
    if (flags.file) {
      description += `\n\nTarget file: ${flags.file}`;
    }
    if (flags.error) {
      description += `\n\nError/Stack trace:\n${flags.error}`;
    }

    // Create task
    const task: Task = {
      id: uuid(),
      description,
      complexity: "medium",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        command: "debug",
        targetFile: flags.file,
        error: flags.error,
        noConfirm: flags["no-confirm"],
      },
    };

    this.log(chalk.white(`  Issue: ${args.issue}`));
    if (flags.file) {
      this.log(chalk.gray(`  File: ${flags.file}`));
    }
    this.log("");

    try {
      const result = await executeTask(task);

      if (!result.success) {
        this.log(chalk.red.bold("\n✗ Debug failed!\n"));
        this.log(chalk.white(result.output));
      }
    } catch (error) {
      this.error(
        chalk.red(
          `\nError during debug: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
