/**
 * Tool Sets - Per-mode tool availability definitions
 */

import type { AgentMode } from "./system-prompts.js";

export const TOOL_SETS: Record<AgentMode, string[]> = {
  code: [
    "file_read",
    "file_write",
    "file_restore",
    "directory_create",
    "search_files",
    "search_content",
    "grep",
    "find_usages",
    "shell_exec",
    "git_status",
    "git_add",
    "git_commit",
    "git_branch",
    "git_checkout",
    "git_reset",
    "git_remote",
    "git_push",
    "git_pull",
    "workspace_verify",
    "spawn_subagent",
  ],
  debug: [
    "file_read",
    "file_write",
    "file_restore",
    "search_content",
    "grep",
    "find_usages",
    "shell_exec",
    "shell_which",
    "process_list",
    "process_kill",
    "logs_read",
    "git_status",
    "git_diff",
    // Branch/checkout are non-destructive navigation, useful for e.g.
    // "does this bug exist on main too" — git_reset/git_push/git_remote/
    // git_pull stay code-mode-only (write/destructive, not this mode's job).
    "git_branch",
    "git_checkout",
    "workspace_verify",
  ],
  test: [
    "file_read",
    "file_write",
    "file_restore",
    "search_content",
    "grep",
    // test_run already accepts { coverage: true } — no separate
    // coverage_report tool exists (it never did; that was a dangling
    // reference to a tool that was never implemented anywhere).
    "test_run",
    "shell_exec",
    "workspace_verify",
  ],
  review: [
    "file_read",
    "search_content",
    "grep",
    "find_usages",
    "analyze_imports",
    "analyze_exports",
    // count_lines used to be in no mode's list at all — TOOL_SETS is a
    // strict whitelist (see UniversalAgent.ts/ToolRegistry.ts), so a
    // fully implemented, registered, tested tool was permanently
    // unreachable by every agent mode. Placed alongside its sibling
    // passive-analysis tools here.
    "count_lines",
    "git_status",
    "git_diff",
    "workspace_verify",
  ],
  plan: [
    "file_read",
    "directory_create",
    "search_files",
    "search_content",
    "workspace_verify",
    "spawn_subagent",
  ],
};
