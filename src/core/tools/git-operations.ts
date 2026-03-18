/**
 * Git Operations Tools
 * Tools for git repository operations
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

export function createGitTools(): ToolDefinition[] {
  return [
    {
      name: "git_status",
      description: "Get git repository status",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        porcelain: {
          type: "boolean",
          description: "Use machine-readable format",
          required: false,
          default: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const porcelain = (params.porcelain as boolean) ?? true;

          const command = `git status${porcelain ? " --porcelain" : ""}`;
          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "Working tree clean",
            metadata: { porcelain },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error getting git status: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_diff",
      description: "Show git diff",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        staged: {
          type: "boolean",
          description: "Show staged changes",
          required: false,
          default: false,
        },
        file: {
          type: "string",
          description: "Specific file to diff",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const staged = (params.staged as boolean) ?? false;
          const file = params.file as string | undefined;

          let command = "git diff";
          if (staged) command += " --staged";
          if (file) command += ` -- ${file}`;

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "No changes",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error getting git diff: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_log",
      description: "Show git log",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        count: {
          type: "number",
          description: "Number of commits to show",
          required: false,
          default: 10,
        },
        format: {
          type: "string",
          description: "Log format (oneline, short, medium, full)",
          required: false,
          default: "medium",
        },
        author: {
          type: "string",
          description: "Filter by author",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const count = (params.count as number) ?? 10;
          const format = (params.format as string) ?? "medium";
          const author = params.author as string | undefined;

          const formatFlags: Record<string, string> = {
            oneline: "--oneline",
            short: "--short",
            medium: "",
            full: "--format=fuller",
          };

          let command = `git log -n ${count} ${formatFlags[format] ?? ""}`;
          if (author) command += ` --author="${author}"`;

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error getting git log: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_add",
      description: "Stage files for commit",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        files: {
          type: "array",
          description: 'Files to stage (use "." for all)',
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const files = params.files as string[];

          const command = `git add ${files.map((f) => `"${f}"`).join(" ")}`;
          await execAsync(command, { cwd: path });

          return {
            success: true,
            output: `Staged ${files.length} file(s): ${files.join(", ")}`,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error staging files: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_commit",
      description: "Create a git commit",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        message: {
          type: "string",
          description: "Commit message",
          required: true,
        },
        amend: {
          type: "boolean",
          description: "Amend previous commit",
          required: false,
          default: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const message = params.message as string;
          const amend = (params.amend as boolean) ?? false;

          const command = `git commit${amend ? " --amend" : ""} -m "${message.replace(/"/g, '\\"')}"`;
          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error creating commit: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_branch",
      description: "List or create branches",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        create: {
          type: "string",
          description: "Create a new branch with this name",
          required: false,
        },
        checkout: {
          type: "boolean",
          description: "Checkout after creating",
          required: false,
          default: false,
        },
        delete: {
          type: "string",
          description: "Delete branch with this name",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const create = params.create as string | undefined;
          const checkout = (params.checkout as boolean) ?? false;
          const deleteBranch = params.delete as string | undefined;

          let command: string;

          if (create) {
            if (checkout) {
              command = `git checkout -b "${create}"`;
            } else {
              command = `git branch "${create}"`;
            }
          } else if (deleteBranch) {
            command = `git branch -D "${deleteBranch}"`;
          } else {
            command = "git branch -a";
          }

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error with git branch: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_checkout",
      description: "Checkout a branch or commit",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        ref: {
          type: "string",
          description: "Branch name or commit hash",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const ref = params.ref as string;

          const command = `git checkout "${ref}"`;
          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error checking out: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_reset",
      description: "Reset git state",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        mode: {
          type: "string",
          description: "Reset mode (soft, mixed, hard)",
          required: false,
          default: "mixed",
          enum: ["soft", "mixed", "hard"],
        },
        ref: {
          type: "string",
          description: "Reference to reset to",
          required: false,
          default: "HEAD",
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const mode = (params.mode as string) ?? "mixed";
          const ref = (params.ref as string) ?? "HEAD";

          const command = `git reset --${mode} "${ref}"`;
          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "Reset successful",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error resetting: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_remote",
      description: "Manage git remotes",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        action: {
          type: "string",
          description: "Action (list, add, remove)",
          required: true,
          enum: ["list", "add", "remove"],
        },
        name: {
          type: "string",
          description: "Remote name",
          required: false,
        },
        url: {
          type: "string",
          description: "Remote URL (for add)",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const action = params.action as string;
          const name = params.name as string | undefined;
          const url = params.url as string | undefined;

          let command: string;
          switch (action) {
            case "list":
              command = "git remote -v";
              break;
            case "add":
              if (!name || !url)
                throw new Error("name and url required for add");
              command = `git remote add "${name}" "${url}"`;
              break;
            case "remove":
              if (!name) throw new Error("name required for remove");
              command = `git remote remove "${name}"`;
              break;
            default:
              throw new Error(`Unknown action: ${action}`);
          }

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "Remote operation successful",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error with git remote: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_push",
      description: "Push to remote repository",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        remote: {
          type: "string",
          description: "Remote name",
          required: false,
          default: "origin",
        },
        branch: {
          type: "string",
          description: "Branch name",
          required: false,
        },
        force: {
          type: "boolean",
          description: "Force push",
          required: false,
          default: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const remote = (params.remote as string) ?? "origin";
          const branch = params.branch as string | undefined;
          const force = (params.force as boolean) ?? false;

          let command = `git push ${remote}`;
          if (branch) command += ` ${branch}`;
          if (force) command += " --force";

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "Push successful",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error pushing: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "git_pull",
      description: "Pull from remote repository",
      parameters: {
        path: {
          type: "string",
          description: "Path to git repository",
          required: false,
          default: ".",
        },
        remote: {
          type: "string",
          description: "Remote name",
          required: false,
          default: "origin",
        },
        branch: {
          type: "string",
          description: "Branch name",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const remote = (params.remote as string) ?? "origin";
          const branch = params.branch as string | undefined;

          let command = `git pull ${remote}`;
          if (branch) command += ` ${branch}`;

          const { stdout } = await execAsync(command, { cwd: path });

          return {
            success: true,
            output: stdout || "Pull successful",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error pulling: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },
  ];
}
