/**
 * Rollback Command - list and restore files from their pre-write backups
 * (see utils/git-rollback.ts for why this exists: file-mutating tools
 * operate on the real project tree by default, with no other undo path).
 */

import { Command, Args, Flags } from "@oclif/core";
import chalk from "chalk";
import inquirer from "inquirer";
import { relative } from "path";
import { getRollbackManager } from "../../utils/git-rollback.js";

export default class RollbackCommand extends Command {
  static description =
    "List or restore files from the backups CodingAgent took before writing/deleting them";

  static args = {
    path: Args.string({
      description: "Path to restore (omit with --list to see what's recoverable)",
    }),
  };

  static flags = {
    list: Flags.boolean({
      char: "l",
      default: false,
      description: "List files that have a recoverable backup",
    }),
    yes: Flags.boolean({
      char: "y",
      default: false,
      description: "Restore without prompting for confirmation",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RollbackCommand);
    const rollback = getRollbackManager();

    if (flags.list || !args.path) {
      const files = rollback.listBackedUpFiles();
      if (files.length === 0) {
        this.log(chalk.yellow("No recoverable backups."));
        return;
      }
      this.log(chalk.bold.cyan(`\n${files.length} file(s) with a recoverable backup:\n`));
      for (const file of files) {
        this.log(`  ${relative(process.cwd(), file)}`);
      }
      if (!args.path) {
        this.log(chalk.gray("\nRun `coding-agent rollback <path>` to restore one."));
      }
      return;
    }

    const path = args.path;
    if (!rollback.hasBackup(path)) {
      this.error(`No backup found for ${path} — nothing to restore.`);
    }

    const backup = rollback.peekBackup(path);
    if (backup) {
      const { readFileSync, existsSync } = await import("fs");
      const currentContent = existsSync(path) ? readFileSync(path, "utf-8") : "";
      this.log(rollback.generateDiffPreview(path, currentContent, backup.content));
    }

    if (!flags.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Restore ${path} from backup? This overwrites its current content.`,
          default: false,
        },
      ]);
      if (!confirm) {
        this.log(chalk.yellow("Aborted."));
        return;
      }
    }

    const restored = rollback.rollback(path);
    if (restored) {
      this.log(chalk.green(`✓ Restored ${path} from backup.`));
    } else {
      this.error(`Failed to restore ${path}.`);
    }
  }
}
