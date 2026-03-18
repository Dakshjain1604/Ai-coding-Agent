/**
 * Logging utility for CodingAgent
 * Provides structured logging with levels and formatting
 */

import chalk from "chalk";
import { Ora } from "ora";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggerConfig {
  level: LogLevel;
  prefix?: string;
  timestamp: boolean;
  colorize: boolean;
}

export class Logger {
  public level: LogLevel;
  public prefix: string;
  public timestamp: boolean;
  public colorize: boolean;
  public spinner: Ora | null = null;

  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
  };

  constructor(config?: Partial<LoggerConfig>) {
    this.level = config?.level ?? "info";
    this.prefix = config?.prefix ?? "";
    this.timestamp = config?.timestamp ?? false;
    this.colorize = config?.colorize ?? true;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private formatMessage(level: LogLevel, message: string): string {
    const parts: string[] = [];

    if (this.timestamp) {
      parts.push(chalk.gray(`[${new Date().toISOString()}]`));
    }

    if (this.prefix) {
      parts.push(chalk.cyan(`[${this.prefix}]`));
    }

    const levelColors: Record<LogLevel, (s: string) => string> = {
      debug: chalk.gray,
      info: chalk.blue,
      warn: chalk.yellow,
      error: chalk.red,
      silent: chalk.white,
    };

    const levelLabel = level.toUpperCase().padEnd(5);
    parts.push(this.colorize ? levelColors[level](levelLabel) : levelLabel);

    parts.push(message);

    return parts.join(" ");
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      console.debug(this.formatMessage("debug", message), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog("info")) {
      console.info(this.formatMessage("info", message), ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", message), ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog("error")) {
      console.error(this.formatMessage("error", message), ...args);
    }
  }

  success(message: string): void {
    const formatted = this.colorize
      ? chalk.green("✓ ") + message
      : `✓ ${message}`;
    console.log(formatted);
  }

  fail(message: string): void {
    const formatted = this.colorize
      ? chalk.red("✗ ") + message
      : `✗ ${message}`;
    console.log(formatted);
  }

  spinnerStart(text: string): void {
    this.spinner?.stop();
    this.spinner = ora({ text, spinner: "dots" });
    this.spinner.start();
  }

  spinnerSucceed(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    }
  }

  spinnerFail(text?: string): void {
    if (this.spinner) {
      this.spinner.fail(text);
      this.spinner = null;
    }
  }

  spinnerUpdate(text: string): void {
    if (this.spinner) {
      this.spinner.text = text;
    }
  }

  spinnerStop(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  // Agent-specific logging helpers
  agentSpawn(agentType: string, taskId: string): void {
    this.info(
      chalk.magenta(`[Agent]`) +
        ` Spawning ${agentType} agent for task ${taskId}`,
    );
  }

  agentComplete(agentType: string, taskId: string, duration: number): void {
    this.info(
      chalk.magenta(`[Agent]`) +
        ` ${agentType} completed task ${taskId} in ${duration}ms`,
    );
  }

  agentError(agentType: string, taskId: string, error: Error): void {
    this.error(
      chalk.magenta(`[Agent]`) +
        ` ${agentType} failed on task ${taskId}: ${error.message}`,
    );
  }

  // Memory logging
  memoryStore(key: string): void {
    this.debug(chalk.blue(`[Memory]`) + ` Stored: ${key}`);
  }

  memoryRetrieve(key: string): void {
    this.debug(chalk.blue(`[Memory]`) + ` Retrieved: ${key}`);
  }

  // Provider logging
  providerCall(provider: string, model: string): void {
    this.debug(chalk.yellow(`[Provider]`) + ` Calling ${provider}/${model}`);
  }
}

// Singleton instance
let loggerInstance: Logger | null = null;

export function createLogger(config?: Partial<LoggerConfig>): Logger {
  loggerInstance = new Logger(config);
  return loggerInstance;
}

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

// Re-export ora for spinner usage
import ora from "ora";
export { ora };
