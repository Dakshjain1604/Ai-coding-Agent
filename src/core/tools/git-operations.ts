/**
 * Git Operations Tools — branch/checkout/reset/remote/push/pull.
 *
 * This file used to ALSO define git_status/git_diff/git_log/git_add/
 * git_commit — a second, never-registered implementation of tool names
 * builtin.ts already defines and registers (see that file's file header
 * for the file-mutation-tool version of this exact story). Removed to
 * avoid recreating that duplication trap; only the six tools with no
 * equivalent elsewhere remain here.
 *
 * Every handler uses execFile() with an argv array, never a shell string
 * — see builtin.ts's execFileAsync comment for why: a command built via
 * string interpolation (the ORIGINAL shape of every handler in this file,
 * before this rewrite) is trivially exploitable by a message/ref/URL
 * containing shell metacharacters, regardless of quoting.
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function createGitTools(): ToolDefinition[] {
  return [
    {
      name: "git_branch",
      description: "List, create, or delete branches",
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
          description: "Delete branch with this name (safe delete — refuses if unmerged)",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = (params.path as string) ?? ".";
          const create = params.create as string | undefined;
          const checkout = (params.checkout as boolean) ?? false;
          const deleteBranch = params.delete as string | undefined;

          let args: string[];
          if (create) {
            args = checkout ? ["checkout", "-b", create] : ["branch", create];
          } else if (deleteBranch) {
            // -d (not -D): refuses to delete a branch with unmerged
            // commits rather than silently discarding them. A caller
            // wanting to force-delete an unmerged branch should use
            // shell_exec explicitly — this tool defaults to the safe path.
            args = ["branch", "-d", deleteBranch];
          } else {
            args = ["branch", "-a"];
          }

          const { stdout } = await execFileAsync("git", args, { cwd: path });
          return { success: true, output: stdout || "Done" };
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

          const { stdout } = await execFileAsync("git", ["checkout", ref], { cwd: path });
          return { success: true, output: stdout || `Checked out ${ref}` };
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
      description:
        "Reset git state. mode:'hard' DISCARDS uncommitted working-tree changes irreversibly — use 'mixed' (default) or 'soft' unless a hard reset is genuinely intended.",
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

          const { stdout } = await execFileAsync(
            "git",
            ["reset", `--${mode}`, ref],
            { cwd: path },
          );
          return { success: true, output: stdout || "Reset successful" };
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
      description: "List, add, or remove git remotes",
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

          let args: string[];
          switch (action) {
            case "list":
              args = ["remote", "-v"];
              break;
            case "add":
              if (!name || !url) {
                return {
                  success: false,
                  output: "name and url are required for action 'add'",
                };
              }
              args = ["remote", "add", name, url];
              break;
            case "remove":
              if (!name) {
                return {
                  success: false,
                  output: "name is required for action 'remove'",
                };
              }
              args = ["remote", "remove", name];
              break;
            default:
              return { success: false, output: `Unknown action: ${action}` };
          }

          const { stdout } = await execFileAsync("git", args, { cwd: path });
          return { success: true, output: stdout || "Remote operation successful" };
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
      description:
        "Push to remote repository. force:true OVERWRITES remote history — never use it against a shared/main branch without explicit confirmation.",
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

          const args = ["push", remote];
          if (branch) args.push(branch);
          if (force) args.push("--force");

          const { stdout } = await execFileAsync("git", args, { cwd: path });
          return { success: true, output: stdout || "Push successful" };
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

          const args = ["pull", remote];
          if (branch) args.push(branch);

          const { stdout } = await execFileAsync("git", args, { cwd: path });
          return { success: true, output: stdout || "Pull successful" };
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
