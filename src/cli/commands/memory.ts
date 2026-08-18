/**
 * Memory Command - remember/forget/show user & project memory
 */

import { Command, Args } from "@oclif/core";
import chalk from "chalk";
import { getMemoryManager } from "../../memory/MemoryManager.js";

export default class MemoryCommand extends Command {
  static description = "Manage CodingAgent memory (preferences & project knowledge)";

  static args = {
    action: Args.string({
      required: true,
      description: "Action to perform (remember, forget, show)",
    }),
    fact: Args.string({
      description: "The fact to remember/forget (remaining words joined)",
    }),
  };

  static strict = false;

  async run(): Promise<void> {
    const { args, argv } = await this.parse(MemoryCommand);
    const memory = getMemoryManager();

    switch (args.action) {
      case "remember": {
        const fact = (argv.slice(1) as string[]).join(" ");
        if (!fact) {
          this.error("Please provide a fact to remember");
        }
        await memory.remember(fact);
        this.log(chalk.green(`Remembered: ${fact}`));
        break;
      }
      case "forget": {
        const fact = (argv.slice(1) as string[]).join(" ");
        if (!fact) {
          this.error("Please provide a fact to forget");
        }
        const removed = await memory.forget(fact);
        this.log(
          removed
            ? chalk.green(`Forgot: ${fact}`)
            : chalk.yellow(`No matching memory found for: ${fact}`),
        );
        break;
      }
      case "show": {
        this.log(chalk.bold.cyan("\nUser preferences:\n"));
        const preferences = await memory.query({ scope: "user" });
        if (preferences.length === 0) {
          this.log(chalk.gray("  (none remembered yet)"));
        } else {
          for (const { entry } of preferences) {
            this.log(chalk.white(`  - ${entry.content}`));
          }
        }

        this.log(chalk.bold.cyan("\nProject knowledge:\n"));
        this.log(chalk.gray(await memory.exportProjectKnowledge()));
        break;
      }
      default:
        this.error(`Unknown action: ${args.action}. Use remember, forget, or show.`);
    }
  }
}
