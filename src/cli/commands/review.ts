/**
 * Review Command - Review code for quality, security, and best practices
 */

import { Command, Args, Flags } from "@oclif/core";
import { v4 as uuid } from "uuid";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { executeTask } from "../../core/orchestrator/AgentSpawner.js";
import { validateProviders } from "../../utils/healthcheck.js";
import type { Task } from "../../utils/types.js";

export default class ReviewCommand extends Command {
  static description = "Review code for quality, security, and best practices";

  static args = {
    target: Args.string({
      description: 'Target to review (file, directory, or "changes")',
      required: false,
      default: "changes",
    }),
  };

  static flags = {
    focus: Flags.string({
      options: ["quality", "security", "performance", "all"],
      default: "all",
      description: "Focus area for review",
    }),
    format: Flags.string({
      options: ["text", "json", "markdown"],
      default: "text",
      description: "Output format",
    }),
    "no-confirm": Flags.boolean({
      default: false,
      description: "Skip confirmation prompts",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReviewCommand);

    // Validate providers are available
    await validateProviders();

    // Build task description
    let description = `Review code in: ${args.target}\n\n`;
    description += `Focus areas: ${flags.focus}\n\n`;
    description += `Check for:\n`;
    description += `- DRY violations\n`;
    description += `- SOLID principle violations\n`;
    description += `- Security vulnerabilities\n`;
    description += `- Performance issues\n`;
    description += `- Code smells and anti-patterns\n`;
    description += `- Missing error handling\n`;
    description += `- Incomplete error handling\n`;
    description += `- Missing tests or edge cases\n`;

    // Create task
    const task: Task = {
      id: uuid(),
      description,
      complexity: "medium",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        command: "review",
        target: args.target,
        focus: flags.focus,
        format: flags.format,
        noConfirm: flags["no-confirm"],
      },
    };

    this.log(chalk.white(`  Target: ${args.target}`));
    this.log(chalk.gray(`  Focus: ${flags.focus}`));
    this.log(chalk.gray(`  Format: ${flags.format}`));
    this.log("");

    try {
      const result = await executeTask(task);

      if (!result.success) {
        this.log(chalk.red.bold("\n✗ Review failed!\n"));
        this.log(chalk.white(result.output));
      }
    } catch (error) {
      this.error(
        chalk.red(
          `\nError during review: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
