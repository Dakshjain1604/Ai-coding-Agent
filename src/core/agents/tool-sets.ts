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
  ],
  debug: ["file_read", "file_write", "shell_exec", "git_status", "git_diff"],
  test: [
    "file_read",
    "file_write",
    "test_run",
    "coverage_report",
    "shell_exec",
  ],
  review: ["file_read", "git_status", "git_diff"],
  plan: ["file_read", "directory_create"],
};
