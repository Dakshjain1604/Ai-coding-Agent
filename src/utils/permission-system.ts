/**
 * Permission System - Controls what operations require user approval
 */

import chalk from "chalk";
import inquirer from "inquirer";
import path, { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getLogger } from "./logger.js";

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
  /** Why this request is being flagged as risky, e.g. from TaskAnalyzer's
   * riskFactors — shown in the prompt so the user sees the actual reason,
   * not just a generic per-tool description. */
  riskReason?: string;
}

/**
 * A shell-command prefix rule, checked before the generic `shell_exec`
 * tool-level rule. `deny` rules match anywhere in the command (they can be
 * chained, e.g. `echo hi && rm -rf /`); `allow`/`prompt` rules match the
 * command's actual prefix, since those are about what the command *is*.
 */
export interface ShellPrefixRule {
  name: string;
  match: (command: string) => boolean;
  level: PermissionLevel;
  reason: string;
}

const DEFAULT_SHELL_PREFIX_RULES: ShellPrefixRule[] = [
  // Deny rules first — checked regardless of position in a compound command.
  {
    name: "recursive-force-delete",
    match: (c) => /\brm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)\b/i.test(c),
    level: "deny",
    reason: "Recursive/forced delete — irreversible and not worth risking on a misparsed path",
  },
  {
    name: "pipe-remote-script-to-shell",
    match: (c) => /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i.test(c),
    level: "deny",
    reason: "Pipes a remote script directly into a shell with no chance to review it first",
  },
  {
    name: "sudo",
    match: (c) => /\bsudo\b/i.test(c),
    level: "deny",
    reason: "Privilege escalation is out of scope for an unattended coding agent",
  },
  {
    name: "chmod-recursive",
    match: (c) => /\bchmod\s+(-\w*R\w*|--recursive)\b/i.test(c),
    level: "deny",
    reason: "Recursive permission change — easy to misapply broadly and hard to fully undo",
  },
  {
    name: "chown-recursive",
    match: (c) => /\bchown\s+(-\w*R\w*|--recursive)\b/i.test(c),
    level: "deny",
    reason: "Recursive ownership change — easy to misapply broadly and hard to fully undo",
  },
  {
    name: "mkfs",
    match: (c) => /\bmkfs\b/i.test(c),
    level: "deny",
    reason: "Formats a filesystem — destroys all data on the target",
  },
  {
    name: "dd",
    match: (c) => /\bdd\b/i.test(c),
    level: "deny",
    reason: "Low-level disk/device write — a wrong target argument destroys data irreversibly",
  },
  // Safe, read-only prefixes — frictionless.
  {
    name: "git-status",
    match: (c) => /^\s*git\s+status\b/i.test(c),
    level: "allow",
    reason: "Read-only git status",
  },
  {
    name: "git-diff",
    match: (c) => /^\s*git\s+diff\b/i.test(c),
    level: "allow",
    reason: "Read-only git diff",
  },
  {
    name: "git-log",
    match: (c) => /^\s*git\s+log\b/i.test(c),
    level: "allow",
    reason: "Read-only git log",
  },
  // Explicit prompts with a clearer, contextual reason than the generic one.
  {
    name: "npm-install",
    match: (c) => /^\s*(npm|pnpm|yarn)\s+(install|add|i)\b/i.test(c),
    level: "prompt",
    reason: "Installs packages — touches the network and the filesystem",
  },
  {
    name: "git-push",
    match: (c) => /^\s*git\s+push\b/i.test(c),
    level: "prompt",
    reason: "Pushes commits to a remote repository",
  },
];

export class PermissionSystem {
  private rules: PermissionRule[] = [];
  private shellPrefixRules: ShellPrefixRule[] = DEFAULT_SHELL_PREFIX_RULES;
  private allowedTools: Set<string> = new Set();
  private readonly permissionsFile: string;

  constructor(projectRoot?: string) {
    this.initializeDefaultRules();
    this.permissionsFile = join(
      projectRoot ?? process.cwd(),
      ".claude",
      "permissions.json",
    );
    this.loadPersistedGrants();
  }

  /**
   * Load previously-persisted "always allow" grants from
   * .claude/permissions.json into the in-memory fast-path Set. Corrupt or
   * missing files are treated as "no grants yet" — never fatal.
   */
  private loadPersistedGrants(): void {
    if (!existsSync(this.permissionsFile)) return;
    try {
      const raw = readFileSync(this.permissionsFile, "utf-8");
      const data = JSON.parse(raw) as { alwaysAllow?: string[] };
      for (const tool of data.alwaysAllow ?? []) {
        this.allowedTools.add(tool);
      }
    } catch (err) {
      // Corrupt permissions file — start fresh rather than crash the agent,
      // but this silently drops the user's previously-granted "always allow"
      // rules, so it's worth a warning rather than a silent skip.
      getLogger().warn(
        `Ignoring unreadable permissions file at ${this.permissionsFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private persistGrants(): void {
    try {
      const dir = dirname(this.permissionsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        this.permissionsFile,
        JSON.stringify({ alwaysAllow: [...this.allowedTools] }, null, 2),
        "utf-8",
      );
    } catch {
      // Persistence failure shouldn't block the grant from working for the
      // rest of this session — it just won't survive a restart.
    }
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
        pattern: /^file_restore$/,
        level: "prompt",
        description: "Restore a file from its pre-write backup",
      },
      {
        pattern: /^file_exists$/,
        level: "allow",
        description: "Check if a file or directory exists",
      },
      {
        pattern: /^file_copy$/,
        level: "prompt",
        description: "Copy a file",
      },
      {
        pattern: /^file_move$/,
        level: "prompt",
        description: "Move or rename a file (deletes the source)",
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
      // Code-search tools are read-only — same trust level as file_read.
      {
        pattern:
          /^(search_files|search_content|grep|find_usages|analyze_imports|analyze_exports|count_lines)$/,
        level: "allow",
        description: "Code search / analysis",
      },
      // spawn_subagent itself just decomposes work — the actual risk is in
      // whatever tools the resulting child agent calls, each of which is
      // separately permission-checked (and shell_exec is always withheld
      // from children regardless — see ParallelOrchestrator).
      {
        pattern: /^spawn_subagent$/,
        level: "allow",
        description: "Delegate a subtask to a sub-agent",
      },
      {
        pattern: /^shell_which$/,
        level: "allow",
        description: "Locate an executable on PATH — read-only",
      },
      {
        pattern: /^process_list$/,
        level: "allow",
        description: "List running processes — read-only",
      },
      {
        pattern: /^process_kill$/,
        level: "prompt",
        description: "Kill a running process",
      },
      {
        pattern: /^logs_read$/,
        level: "allow",
        description: "Read a log file — read-only",
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

    // Prefix rules take priority over the generic shell_exec rule below —
    // a read-only `git status` should never prompt, and a `rm -rf` should
    // never be allowed through purely because the user once approved
    // shell_exec in general.
    if (toolName === "shell_exec" && typeof params.command === "string") {
      const prefixResult = this.checkShellPrefix(params.command);
      if (prefixResult) return prefixResult;
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

  /**
   * Checks a shell_exec command against the prefix-rule table. Returns
   * null if no rule matches (caller falls through to the generic
   * shell_exec rule, which currently means "prompt").
   */
  private checkShellPrefix(
    command: string,
  ): { allowed: boolean; requiresPrompt: boolean; description: string } | null {
    for (const rule of this.shellPrefixRules) {
      if (rule.match(command)) {
        return {
          allowed: rule.level === "allow",
          requiresPrompt: rule.level === "prompt",
          description: rule.reason,
        };
      }
    }
    return null;
  }

  /** Add or override a shell-command prefix rule (checked in insertion order, first match wins). */
  addShellPrefixRule(rule: ShellPrefixRule): void {
    this.shellPrefixRules = [rule, ...this.shellPrefixRules];
  }

  listShellPrefixRules(): ShellPrefixRule[] {
    return [...this.shellPrefixRules];
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
      case "file_restore":
        return `Restore ${formatPath(params.path)} from backup`;
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
    console.log(
      chalk.yellow("\n  ┌─ ") + chalk.bold.yellow("Permission Required"),
    );
    console.log(chalk.gray("  │  Tool:   ") + chalk.white.bold(request.tool));
    console.log(chalk.gray("  │  Action: ") + request.description);
    if (request.riskReason) {
      console.log(chalk.gray("  │  Why:    ") + chalk.yellow(request.riskReason));
    }

    if (request.params.command) {
      console.log(chalk.gray("  │  Command:"));
      const cmd = request.params.command as string;
      const lines = cmd.split("\n");
      for (const line of lines.slice(0, 5)) {
        console.log(chalk.cyan(`  │    > ${line.slice(0, 60)}`));
      }
      if (lines.length > 5) {
        console.log(
          chalk.cyan(
            `  │    > ${chalk.gray("... " + (lines.length - 5) + " more lines")}`,
          ),
        );
      }
    }
    console.log(chalk.yellow("  └──────────────────────────────────\n"));

    const choices = [
      {
        name: chalk.green("  [>] Yes (Once)"),
        value: "yes",
      },
      {
        name: chalk.green.bold("  [*] Yes (Always — remembered across runs)"),
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
        this.persistGrants();
        console.log(
          chalk.green(
            `  ✔ Tool ${request.tool} allowed — remembered for future runs (.claude/permissions.json)\n`,
          ),
        );
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
