/**
 * Tool Sets - Per-mode tool availability definitions
 */

import type { AgentMode } from "./system-prompts.js";

export const TOOL_SETS: Record<AgentMode, string[]> = {
  code: [
    "file_read",
    "file_write",
    "directory_create",
    "shell_exec",
    "git_status",
    "git_add",
    "git_commit",
    "workspace_verify",
  ],
  debug: [
    "file_read",
    "file_write",
    "shell_exec",
    "git_status",
    "git_diff",
    "workspace_verify",
  ],
  test: [
    "file_read",
    "file_write",
    "test_run",
    "coverage_report",
    "shell_exec",
    "workspace_verify",
  ],
  review: ["file_read", "git_status", "git_diff", "workspace_verify"],
  plan: ["file_read", "directory_create", "workspace_verify"],
};
