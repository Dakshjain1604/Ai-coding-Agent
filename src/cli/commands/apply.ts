/**
 * Apply Command - Preview and apply agent-generated changes to source tree
 */

import { Command, Args, Flags } from "@oclif/core";
import chalk from "chalk";
import inquirer from "inquirer";
import { generateUnifiedDiff, applyDiff } from "../../utils/diff-merge.js";
import { getTaskManager } from "../../utils/task-manager.js";
import { join } from "path";

export default class ApplyCommand extends Command {
  static description =
    "Preview and apply agent-generated changes to your source tree";
  static args = {
    taskId: Args.string({
      description: "Task ID to apply (e.g., task_abc123)",
      required: true,
    }),
  };

  static flags = {
    "dry-run": Flags.boolean({
      default: false,
      description: "Show diff without applying",
    }),
    yes: Flags.boolean({
      char: "y",
      default: false,
      description: "Apply all changes without prompting",
    }),
    exclude: Flags.string({
      description: "Glob pattern of files to skip",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ApplyCommand);
    const taskManager = getTaskManager();
    const task = taskManager.getTask(args.taskId);

    if (!task) {
      this.error(`Task ${args.taskId} not found`);
    }

    const outputDir = task.outputDir || join(process.cwd(), "output", args.taskId);
    const sourceDir = process.cwd();

    this.log(chalk.bold.cyan(`\n📂 Applying changes from: ${args.taskId}\n`));

    const diffs = await generateUnifiedDiff(outputDir, sourceDir);

    if (diffs.length === 0) {
      this.log(chalk.yellow("No changes to apply."));
      return;
    }

    this.log(chalk.bold(`${diffs.length} file(s) changed:\n`));

    for (const diff of diffs) {
      const status = diff.isNew
        ? chalk.green("new")
        : `${chalk.green(`+${diff.additions}`)} ${chalk.red(`-${diff.deletions}`)}`;
      this.log(`  ${diff.path} (${status})`);
    }

    if (flags["dry-run"]) {
      this.log(chalk.bold("\n--- Dry Run ---\n"));
      for (const diff of diffs) {
        this.log(`\n--- ${diff.path}`);
        this.log(diff.unified);
      }
      return;
    }

    if (!flags.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: "Apply these changes to your source tree?",
          default: false,
        },
      ]);
      if (!confirm) {
        this.log(chalk.yellow("\nAborted."));
        return;
      }
    }

    for (const diff of diffs) {
      if (flags.exclude && diff.path.match(new RegExp(flags.exclude))) {
        this.log(
          chalk.gray(`  Skipping ${diff.path} (matched exclude pattern)`),
        );
        continue;
      }
      await applyDiff(diff, sourceDir);
      this.log(chalk.green(`  ✓ Applied: ${diff.path}`));
    }

    this.log(
      chalk.green.bold(`\n✓ Applied ${diffs.length} change(s) successfully.`),
    );
  }
}
