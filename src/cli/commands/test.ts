/**
 * Test Command - Run tests or generate tests for code
 */

import { Command, Args, Flags } from "@oclif/core";
import { v4 as uuid } from "uuid";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { executeTask } from "../../core/orchestrator/AgentSpawner.js";
import { validateProviders } from "../../utils/healthcheck.js";
import type { Task } from "../../utils/types.js";

export default class TestCommand extends Command {
  static description = "Run tests or generate tests for your code";

  static args = {
    target: Args.string({
      description: 'Target to test (file, function, or "all")',
      required: false,
      default: "all",
    }),
  };

  static flags = {
    type: Flags.string({
      options: ["unit", "integration", "e2e", "all"],
      default: "all",
      description: "Type of tests to run",
    }),
    generate: Flags.boolean({
      default: false,
      description: "Generate tests instead of running them",
    }),
    coverage: Flags.boolean({
      default: false,
      description: "Run with coverage report",
    }),
    "no-confirm": Flags.boolean({
      default: false,
      description: "Skip confirmation prompts",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TestCommand);

    const action = flags.generate ? "Generate" : "Run";

    // Validate providers are available
    await validateProviders();

    // Build task description
    let description = "";
    if (flags.generate) {
      description = `Generate ${flags.type} tests for: ${args.target}`;
    } else {
      description = `Run ${flags.type} tests for: ${args.target}`;
    }

    if (flags.coverage) {
      description += " with coverage report";
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
        command: "test",
        target: args.target,
        testType: flags.type,
        generate: flags.generate,
        coverage: flags.coverage,
        noConfirm: flags["no-confirm"],
      },
    };

    this.log(chalk.white(`  Target: ${args.target}`));
    this.log(chalk.gray(`  Type: ${flags.type}`));
    if (flags.generate) {
      this.log(chalk.gray("  Mode: Generate"));
    } else {
      this.log(chalk.gray("  Mode: Run"));
    }
    this.log("");

    try {
      const result = await executeTask(task);

      if (!result.success) {
        this.log(chalk.red.bold("\n✗ Tests failed!\n"));
        this.log(chalk.white(result.output));
      }
    } catch (error) {
      this.error(
        chalk.red(
          `\nError with tests: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
