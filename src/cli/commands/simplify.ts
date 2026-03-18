/**
 * Simplify Command - Review changed code for reuse, quality, and efficiency, then fix issues
 */

import { Command, Args, Flags } from "@oclif/core";
import { v4 as uuid } from "uuid";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { executeTask } from "../../core/orchestrator/AgentSpawner.js";
import { validateProviders } from "../../utils/healthcheck.js";
import type { Task } from "../../utils/types.js";

export default class SimplifyCommand extends Command {
  static description =
    "Review changed code for reuse, quality, and efficiency, then fix any issues found";

  static args = {
    target: Args.string({
      description: 'Target to simplify (file, directory, or "changes")',
      required: false,
      default: "changes",
    }),
  };

  static flags = {
    "dry-run": Flags.boolean({
      default: false,
      description: "Show what would be changed without making changes",
    }),
    "no-confirm": Flags.boolean({
      default: false,
      description: "Skip confirmation prompts",
    }),
    "check-only": Flags.boolean({
      default: false,
      description: "Only check and report issues without fixing",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SimplifyCommand);

    // Validate providers are available
    await validateProviders();

    // Build task description
    let description = `Review and simplify code in: ${args.target}\n\n`;
    description += `Check for the following improvements:\n`;
    description += `- DRY violations - flag any repeated code patterns\n`;
    description += `- Code quality issues\n`;
    description += `- Efficiency improvements\n`;
    description += `- Unused code or imports\n`;
    description += `- Over-engineered solutions that can be simplified\n`;

    if (flags["dry-run"]) {
      description += `\nNote: This is a dry run - do not make changes, just report what would be changed.`;
    }
    if (flags["check-only"]) {
      description += `\nNote: Check only mode - report issues but do not fix them.`;
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
        command: "simplify",
        target: args.target,
        dryRun: flags["dry-run"],
        checkOnly: flags["check-only"],
        noConfirm: flags["no-confirm"],
      },
    };

    this.log(chalk.white(`  Target: ${args.target}`));
    if (flags["dry-run"]) {
      this.log(chalk.gray("  Mode: Dry run"));
    } else if (flags["check-only"]) {
      this.log(chalk.gray("  Mode: Check only"));
    } else {
      this.log(chalk.gray("  Mode: Fix issues"));
    }
    this.log("");

    try {
      const result = await executeTask(task);

      if (!result.success) {
        this.log(chalk.red.bold("\n✗ Simplify failed!\n"));
        this.log(chalk.white(result.output));
      }
    } catch (error) {
      this.error(
        chalk.red(
          `\nError during simplify: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
