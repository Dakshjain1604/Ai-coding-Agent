/**
 * Autonomous Mode - Fully autonomous execution without user interaction
 * Executes tasks independently with self-correction and reporting
 */

import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { getAgentSpawner } from "../../core/orchestrator/AgentSpawner.js";
import { getTaskAnalyzer } from "../../core/orchestrator/TaskAnalyzer.js";
import { getHookManager } from "../../hooks/HookManager.js";
import { registerBuiltinHooks } from "../../hooks/registerBuiltinHooks.js";
import type {
  Task,
  TaskComplexity,
  TaskResult,
  AgentType,
} from "../../utils/types.js";
import { v4 as uuid } from "uuid";

export interface AutonomousConfig {
  maxIterations: number;
  selfCorrect: boolean;
  reportInterval: number;
  verbose: boolean;
}

export interface ExecutionState {
  iteration: number;
  task: Task;
  results: TaskResult[];
  errors: Error[];
  startTime: Date;
  lastUpdate: Date;
}

export class AutonomousMode {
  private logger = getLogger();
  private config: AutonomousConfig;
  private running = false;

  constructor(config?: Partial<AutonomousConfig>) {
    this.config = {
      maxIterations: config?.maxIterations ?? 10,
      selfCorrect: config?.selfCorrect ?? true,
      reportInterval: config?.reportInterval ?? 5,
      verbose: config?.verbose ?? true,
    };
  }

  async execute(task: Task): Promise<TaskResult> {
    this.running = true;
    this.logger.info(`Starting autonomous execution for task: ${task.id}`);

    const state: ExecutionState = {
      iteration: 0,
      task,
      results: [],
      errors: [],
      startTime: new Date(),
      lastUpdate: new Date(),
    };

    this.printStart(task);

    try {
      await this.initializeSystems();

      while (this.running && state.iteration < this.config.maxIterations) {
        state.iteration++;

        if (this.config.verbose) {
          console.log(
            chalk.cyan(
              `\n--- Iteration ${state.iteration}/${this.config.maxIterations} ---\n`,
            ),
          );
        }

        const result = await this.executeIteration(state);

        if (result.success) {
          this.printSuccess(result);
          return result;
        }

        if (!this.config.selfCorrect) {
          this.printFailure(result);
          return result;
        }

        state.results.push(result);

        if (this.config.verbose) {
          console.log(chalk.yellow("Attempting self-correction...\n"));
        }
      }

      const finalResult = this.synthesizeResults(state);
      this.printComplete(state);

      return finalResult;
    } catch (error) {
      this.logger.error("Autonomous execution failed", error as Error);
      throw error;
    }
  }

  private async initializeSystems(): Promise<void> {
    const hookManager = getHookManager();
    hookManager.enable();
    registerBuiltinHooks();
  }

  private async executeIteration(state: ExecutionState): Promise<TaskResult> {
    const spawner = getAgentSpawner();

    let agentType: AgentType = "code";
    if (state.task.complexity === "complex") {
      agentType = "orchestrator";
    }

    const spawned = await spawner.spawn(agentType, state.task);
    return spawner.execute(spawned.id);
  }

  private synthesizeResults(state: ExecutionState): TaskResult {
    const successfulResults = state.results.filter((r) => r.success);

    if (successfulResults.length > 0) {
      return {
        taskId: state.task.id,
        success: true,
        output: `Completed after ${state.iteration} iterations`,
        artifacts: successfulResults.flatMap((r) => r.artifacts || []),
        durationMs: Date.now() - state.startTime.getTime(),
        agentType: "code",
      };
    }

    return {
      taskId: state.task.id,
      success: false,
      output: `Failed after ${state.iteration} iterations`,
      durationMs: Date.now() - state.startTime.getTime(),
      agentType: "code",
    };
  }

  private printStart(task: Task): void {
    console.log(
      chalk.bold.cyan(`
╔════════════════════════════════════════════════════════════╗
║             CodingAgent Autonomous Mode                    ║
╚════════════════════════════════════════════════════════════╝
    `),
    );
    console.log(chalk.gray("Task: ") + chalk.white(task.description));
    console.log(
      chalk.gray("Complexity: ") +
        chalk.white(task.complexity || "auto-detected"),
    );
    console.log(
      chalk.gray("Max iterations: ") +
        chalk.white(String(this.config.maxIterations)),
    );
    console.log(
      chalk.gray("Self-correction: ") +
        chalk.white(this.config.selfCorrect ? "enabled" : "disabled"),
    );
    console.log("");
  }

  private printSuccess(result: TaskResult): void {
    console.log(chalk.green.bold("\n✓ Task completed successfully!\n"));
    console.log(result.output);
    console.log("");
  }

  private printFailure(result: TaskResult): void {
    console.log(chalk.red.bold("\n✗ Task failed\n"));
    console.log(result.output);
    console.log("");
  }

  private printComplete(state: ExecutionState): void {
    const duration = Date.now() - state.startTime.getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);

    console.log(
      chalk.bold.cyan(`
╔════════════════════════════════════════════════════════════╗
║                  Execution Summary                         ║
╚════════════════════════════════════════════════════════════╝
    `),
    );
    console.log(
      chalk.gray("Total iterations: ") + chalk.white(String(state.iteration)),
    );
    console.log(
      chalk.gray("Duration: ") + chalk.white(`${minutes}m ${seconds}s`),
    );
    console.log(
      chalk.gray("Errors: ") + chalk.white(String(state.errors.length)),
    );
    console.log("");
  }

  stop(): void {
    this.running = false;
    this.logger.info("Autonomous execution stopped");
  }
}

export async function startAutonomousMode(
  taskDescription: string,
  complexity?: TaskComplexity,
  config?: Partial<AutonomousConfig>,
): Promise<TaskResult> {
  const task: Task = {
    id: uuid(),
    description: taskDescription,
    complexity: complexity || "complex",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mode = new AutonomousMode(config);
  return mode.execute(task);
}
