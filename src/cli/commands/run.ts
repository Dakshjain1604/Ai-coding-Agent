/**
 * Run Command - Execute a task using the coding agent
 */

import { Command, Args, Flags } from "@oclif/core";
import { v4 as uuid } from "uuid";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { getTaskAnalyzer } from "../../core/orchestrator/TaskAnalyzer.js";
import { executeTask } from "../../core/orchestrator/AgentSpawner.js";
import { validateProviders } from "../../utils/healthcheck.js";
import { getPermissionSystem } from "../../utils/permission-system.js";
import type { Task, TaskComplexity } from "../../utils/types.js";

export default class RunCommand extends Command {
  static description = "Execute a task using the coding agent";

  static args = {
    task: Args.string({
      description: "Task description",
      required: true,
    }),
  };

  static flags = {
    mode: Flags.string({
      // "autonomous" removed: it selected AutonomousMode, which was fully
      // unreachable dead code (no caller anywhere ever instantiated it)
      // and is now deleted outright rather than wired up — its
      // "self-correction" loop didn't actually incorporate a failed
      // iteration's output into the next attempt, so it would have needed
      // a real redesign, not just a wiring fix, to be worth exposing.
      options: ["auto", "interactive"],
      default: "auto",
      description: "Execution mode",
    }),
    complexity: Flags.string({
      options: ["simple", "medium", "complex"],
      description: "Force a specific complexity level",
    }),
    "no-confirm": Flags.boolean({
      default: false,
      description: "Skip confirmation prompts",
    }),
    model: Flags.string({
      description: "Force a specific model",
    }),
  };

  private logger = getLogger();

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RunCommand);

    if (flags["no-confirm"]) {
      getPermissionSystem().allowAll();
    }

    // Create task
    const task: Task = {
      id: uuid(),
      description: args.task,
      complexity: (flags.complexity as TaskComplexity) || "simple",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        mode: flags.mode,
        forcedModel: flags.model,
        noConfirm: flags["no-confirm"],
      },
    };

    // Analyze task complexity if not forced
    if (!flags.complexity) {
      const analyzer = getTaskAnalyzer();
      const analysis = analyzer.analyze(task);
      task.complexity = analysis.complexity;
    }

    // Execute based on mode
    try {
      // Execute the task
      const result = await executeTask(task);

      // Display results
      if (result.success) {
        if (result.artifacts && result.artifacts.length > 0) {
          this.log(chalk.gray("\n  Artifacts:"));
          for (const artifact of result.artifacts) {
            this.log(chalk.gray(`    - ${artifact}`));
          }
        }
      } else {
        this.log(chalk.red.bold("\n✗ Task failed!\n"));
        this.log(chalk.white(result.output));
      }
    } catch (error) {
      this.error(
        chalk.red(
          `\nError executing task: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
