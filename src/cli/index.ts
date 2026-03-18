/**
 * CodingAgent CLI - Main Entry Point
 */

// Load environment variables from .env file first
import "dotenv/config";

import { Command, Flags } from "@oclif/core";
import { readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";

// Setup global error handling for polished crashes
const printFatalError = (err: Error) => {
  console.log("");
  console.log(chalk.red("  ┌─ ") + chalk.bold.red("System Error"));
  console.log(chalk.gray("  │  ") + chalk.white(err.message));
  if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
    console.log(chalk.gray("  │  ") + chalk.yellow("Recommendation: Ensure your AI provider (e.g., Ollama) is running and accessible."));
  }
  console.log(chalk.red("  └──────────────────────────────────\n"));
  process.exit(1);
};

process.on("uncaughtException", printFatalError);
process.on("unhandledRejection", (reason: any) => {
  printFatalError(reason instanceof Error ? reason : new Error(String(reason)));
});
import {
  RunCommand,
  DebugCommand,
  TestCommand,
  SimplifyCommand,
  ReviewCommand,
  ConfigCommand,
} from "./commands/index.js";
import { startInteractiveMode } from "./modes/interactive.js";

export default class CodingAgentCLI extends Command {
  static description =
    "A robust, multi-agent coding CLI tool for core developers";

  static version = (() => {
    try {
      const packageJson = readFileSync(
        join(import.meta.dirname, "../../package.json"),
        "utf-8",
      );
      return JSON.parse(packageJson).version;
    } catch {
      return "0.0.0";
    }
  })();

  static commands = [
    RunCommand,
    DebugCommand,
    TestCommand,
    SimplifyCommand,
    ReviewCommand,
    ConfigCommand,
  ];

  static flags = {
    interactive: Flags.boolean({
      char: "i",
      description: "Start in interactive mode",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse();

    const hasCommand = args.command && Object.keys(args.command).length > 0;

    if (flags.interactive || !hasCommand) {
      await startInteractiveMode();
      return;
    }
  }
}
