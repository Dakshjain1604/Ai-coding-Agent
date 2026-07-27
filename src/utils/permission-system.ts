/**
 * Permission System - Controls what operations require user approval
 */

import chalk from "chalk";
import inquirer from "inquirer";
import path from "path";

export type PermissionLevel = "allow" | "prompt" | "deny";

export interface PermissionRule {
  pattern: RegExp;
  level: PermissionLevel;
  description: string;
}

export interface PermissionRequest {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

export class PermissionSystem {
  private rules: PermissionRule[] = [];
  private allowedTools: Set<string> = new Set();

  constructor() {
    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    this.rules = [
      {
        pattern: /^file_write$/,
        level: "prompt",
        description: "Write files",
      },
      { pattern: /^file_read$/, level: "allow", description: "Read files" },
      {
        pattern: /^file_delete$/,
        level: "prompt",
        description: "Delete files",
      },
      {
        pattern: /^shell_exec$/,
        level: "prompt",
        description: "Execute shell commands",
      },
      { pattern: /^git_/, level: "prompt", description: "Git operations" },
      { pattern: /^npm_/, level: "prompt", description: "NPM operations" },
      { pattern: /^test_/, level: "allow", description: "Test operations" },
      {
        pattern: /^directory_create$/,
        level: "prompt",
        description: "Create directories",
      },
      {
        pattern: /^directory_/,
        level: "allow",
        description: "Directory operations",
      },
      {
        pattern: /^workspace_/,
        level: "allow",
        description: "Workspace verification operations",
      },
    ];
  }

  checkPermission(
    toolName: string,
    params: Record<string, unknown>,
  ): {
    allowed: boolean;
    requiresPrompt: boolean;
    description: string;
  } {
    if (this.allowedTools.has(toolName)) {
      return {
        allowed: true,
        requiresPrompt: false,
        description: `Tool ${toolName} permanently allowed`,
      };
    }

    const rule = this.rules.find((r) => r.pattern.test(toolName));

    if (!rule) {
      return {
        allowed: false,
        requiresPrompt: false,
        description: `Unknown tool: ${toolName}`,
      };
    }

    const description = this.buildDescription(toolName, params);

    return {
      allowed: rule.level === "allow",
      requiresPrompt: rule.level === "prompt",
      description,
    };
  }

  private buildDescription(
    toolName: string,
    params: Record<string, unknown>,
  ): string {
    const formatPath = (p?: unknown) =>
      p ? chalk.cyan(path.relative(process.cwd(), p as string)) : "unknown";

    switch (toolName) {
      case "file_write":
        return `Write to ${formatPath(params.path)}`;
      case "file_read":
        return `Read ${formatPath(params.path)}`;
      case "file_delete":
        return `Delete ${formatPath(params.path)}`;
      case "directory_create":
        return `Create directory ${formatPath(params.path)}`;
      case "shell_exec":
        return `Execute: ${chalk.cyan(params.command || "unknown")}`;
      case "git_add":
        return `Git add: ${chalk.cyan(params.files || "all")}`;
      case "git_commit":
        return `Git commit: ${chalk.cyan(params.message || "no message")}`;
      case "npm_install":
        return `Install npm packages`;
      case "npm_run":
        return `Run npm script: ${chalk.cyan(params.script || "unknown")}`;
      default:
        return `Tool: ${toolName}`;
    }
  }

  async requestPermission(request: PermissionRequest): Promise<boolean> {
    const check = this.checkPermission(request.tool, request.params);

    if (check.allowed) return true;
    if (!check.requiresPrompt) return false;

    return this.promptUser(request);
  }

  private async promptUser(request: PermissionRequest): Promise<boolean> {
    console.log(chalk.yellow("\n  ┌─ ") + chalk.bold.yellow("Permission Required"));
    console.log(chalk.gray("  │  Tool:   ") + chalk.white.bold(request.tool));
    console.log(chalk.gray("  │  Action: ") + request.description);

    if (request.params.command) {
      console.log(chalk.gray("  │  Command:"));
      const cmd = request.params.command as string;
      const lines = cmd.split("\n");
      for (const line of lines.slice(0, 5)) {
        console.log(chalk.cyan(`  │    > ${line.slice(0, 60)}`));
      }
      if (lines.length > 5) {
        console.log(chalk.cyan(`  │    > ${chalk.gray("... " + (lines.length - 5) + " more lines")}`));
      }
    }
    console.log(chalk.yellow("  └──────────────────────────────────\n"));

    const choices = [
      {
        name: chalk.green("  [>] Yes (Once)"),
        value: "yes",
      },
      {
        name: chalk.green.bold("  [*] Yes (Always for this session)"),
        value: "always",
      },
      { name: chalk.red("  [ ] No (Deny)"), value: "no" },
    ];

    const answer = await inquirer.prompt([
      {
        type: "list",
        name: "permission",
        message: chalk.yellow("  Allow this operation?"),
        choices: choices,
        default: "no",
        pageSize: 10,
      },
    ]);

    if (answer.permission === "yes" || answer.permission === "always") {
      if (answer.permission === "always") {
        this.allowedTools.add(request.tool);
        console.log(chalk.green(`  ✔ Tool ${request.tool} explicitly allowed for session\n`));
      }
      return true;
    }

    console.log(chalk.red("  ✖ Operation denied\n"));
    return false;
  }

  allowAll(): void {
    for (const rule of this.rules) {
      rule.level = "allow";
    }
  }

  addRule(pattern: string, level: PermissionLevel, description: string): void {
    this.rules.push({ pattern: new RegExp(pattern), level, description });
  }

  listRules(): PermissionRule[] {
    return [...this.rules];
  }
}

let permissionSystemInstance: PermissionSystem | null = null;

export function getPermissionSystem(): PermissionSystem {
  if (!permissionSystemInstance) {
    permissionSystemInstance = new PermissionSystem();
  }
  return permissionSystemInstance;
}
