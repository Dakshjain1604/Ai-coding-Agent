/**
 * Built-in Tools - Core tool implementations
 * File system, shell, git, and other essential tools
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
} from "fs";
import { join, dirname, basename, extname, relative, resolve } from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { getToolRegistry } from "./ToolRegistry.js";
import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import { createCodeSearchTools } from "./code-search.js";
import { createFileSystemTools } from "./file-system.js";
import { createGitTools } from "./git-operations.js";
import { spawnSubagentTool } from "./subagent-tool.js";
import { getLogger } from "../../utils/logger.js";
import { formatFile } from "../../utils/formatter.js";
import { getDependencyGraph } from "../../utils/dependency-graph.js";
import { getMemoryManager } from "../../memory/MemoryManager.js";
import { getRollbackManager } from "../../utils/git-rollback.js";

const execAsync = promisify(exec);
/**
 * For every tool below that isn't shell_exec itself (whose whole purpose
 * IS running an arbitrary command string), user/model-supplied values
 * (commit messages, file paths, search patterns, etc.) must never be
 * interpolated into a shell command string — execAsync() runs commands
 * through `/bin/sh -c "..."`, so a value containing backticks, `$(...)`,
 * `;`, `&&`, or `|` executes as a SEPARATE command regardless of quoting.
 * execFile() with an argv array never invokes a shell at all, so this
 * entire injection class is structurally impossible regardless of what
 * characters a value contains. Confirmed exploitable pre-fix: a git_commit
 * call with message `` pwned`touch /tmp/PWNED` `` created a real file on
 * disk via the OLD execAsync-based implementation.
 */
const execFileAsync = promisify(execFile);

// ============================================================================
// File System Tools
// ============================================================================

export const fileRead: ToolDefinition = {
  name: "file_read",
  description: "Read the contents of a file",
  parameters: {
    path: {
      type: "string",
      description: "Path to the file to read",
      required: true,
    },
    encoding: {
      type: "string",
      description: "File encoding (utf-8, binary)",
      required: false,
      default: "utf-8",
    },
    offset: {
      type: "number",
      description: "Line number to start reading from",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum number of lines to read",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const path = params.path as string;
      const encoding = (params.encoding as BufferEncoding) ?? "utf-8";

      if (!existsSync(path)) {
        return { success: false, output: `File not found: ${path}` };
      }

      const content = readFileSync(path, encoding);

      if (params.offset || params.limit) {
        const lines = content.split("\n");
        const offset = (params.offset as number) ?? 0;
        const limit = (params.limit as number) ?? lines.length;
        const selected = lines.slice(offset, offset + limit);
        return { success: true, output: selected.join("\n") };
      }

      return { success: true, output: content };
    } catch (error) {
      return {
        success: false,
        output: `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const fileWrite: ToolDefinition = {
  name: "file_write",
  description: "Write content to a file",
  parameters: {
    path: {
      type: "string",
      description: "Path to the file to write",
      required: true,
    },
    content: {
      type: "string",
      description: "Content to write to the file",
      required: true,
    },
    mode: {
      type: "string",
      description: "Write mode: write, append, prepend",
      required: false,
      default: "write",
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const path = params.path as string;
      const content = params.content as string;
      const mode = (params.mode as string) ?? "write";

      // Ensure directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      let finalContent = content;
      if (mode === "append" && existsSync(path)) {
        finalContent = readFileSync(path, "utf-8") + "\n" + content;
      } else if (mode === "prepend" && existsSync(path)) {
        finalContent = content + "\n" + readFileSync(path, "utf-8");
      }

      // Snapshot before overwriting an existing file — this is the ACTIVE
      // file_write implementation (the one in file-system.ts is only
      // registered for file_exists/file_copy/file_move/file_restore, this
      // one wins for file_write/file_delete/file_read/file_list — see
      // registerBuiltinTools()'s FS_EXTRAS comment). file_write operates
      // on the real project tree by default, with no other undo path.
      getRollbackManager().snapshot(path);
      writeFileSync(path, finalContent, "utf-8");

      // Auto-format post write
      try {
        await formatFile(path);
      } catch {
        // Formatter is optional
      }

      // Check dependent files via AST dependency graph
      let depMsg = "";
      try {
        const graph = getDependencyGraph();
        // The graph only builds once (lazily) and never rebuilds on its
        // own — without invalidating first, every write after the first
        // one in a session would silently report dependents from a
        // pre-edit snapshot of the tree, missing the very changes that
        // just happened.
        graph.invalidate();
        const dependents = graph.getDependentFiles(path);
        if (dependents.length > 0) {
          depMsg = ` (Dependent files flagged for audit: ${dependents.map((f) => basename(f)).join(", ")})`;
        }
      } catch {
        // Dependency graph check is optional
      }

      return { success: true, output: `File written: ${path}${depMsg}` };
    } catch (error) {
      return {
        success: false,
        output: `Error writing file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const fileDelete: ToolDefinition = {
  name: "file_delete",
  description: "Delete a file or directory",
  parameters: {
    path: {
      type: "string",
      description: "Path to the file or directory to delete",
      required: true,
    },
    recursive: {
      type: "boolean",
      description: "Delete recursively if directory",
      required: false,
      default: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const path = params.path as string;
      const recursive = (params.recursive as boolean) ?? false;

      if (!existsSync(path)) {
        return { success: false, output: `Path not found: ${path}` };
      }

      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (recursive) {
          rmSync(path, { recursive: true });
        } else {
          return {
            success: false,
            output: `Cannot delete non-empty directory without recursive=true`,
          };
        }
        // Recursive directory deletes aren't snapshotted — that would mean
        // backing up an entire subtree, a bigger feature than the
        // single-file safety net this phase adds. Single-file deletes
        // (the common case) are fully covered below.
      } else {
        getRollbackManager().snapshot(path);
        unlinkSync(path);
      }

      return { success: true, output: `Deleted: ${path}` };
    } catch (error) {
      return {
        success: false,
        output: `Error deleting: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const fileList: ToolDefinition = {
  name: "file_list",
  description: "List files in a directory",
  parameters: {
    path: {
      type: "string",
      description: "Directory path to list",
      required: true,
    },
    pattern: {
      type: "string",
      description: "Glob pattern to filter files",
      required: false,
    },
    recursive: {
      type: "boolean",
      description: "List recursively",
      required: false,
      default: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const path = params.path as string;
      const pattern = params.pattern as string | undefined;
      const recursive = (params.recursive as boolean) ?? false;

      if (!existsSync(path)) {
        return { success: false, output: `Directory not found: ${path}` };
      }

      const files = listFiles(path, pattern, recursive);
      return { success: true, output: files.join("\n") };
    } catch (error) {
      return {
        success: false,
        output: `Error listing files: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

function listFiles(
  dir: string,
  pattern?: string,
  recursive?: boolean,
): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...listFiles(fullPath, pattern, recursive));
    } else if (entry.isFile()) {
      if (!pattern || matchesPattern(entry.name, pattern)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function matchesPattern(filename: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(filename);
}

// ============================================================================
// Shell Tools
// ============================================================================

export const shellExec: ToolDefinition = {
  name: "shell_exec",
  description: "Execute a shell command",
  parameters: {
    command: {
      type: "string",
      description: "Command to execute",
      required: true,
    },
    cwd: { type: "string", description: "Working directory", required: false },
    timeout: {
      type: "number",
      description: "Timeout in milliseconds",
      required: false,
      default: 30000,
    },
    env: {
      type: "object",
      description: "Environment variables",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const command = params.command as string;
      const cwd = params.cwd as string | undefined;
      const timeout = (params.timeout as number) ?? 30000;
      const env = params.env as Record<string, string> | undefined;

      const result = await execAsync(command, {
        cwd,
        timeout,
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        success: true,
        output:
          result.stdout || result.stderr || "Command executed successfully",
        metadata: { stdout: result.stdout, stderr: result.stderr },
      };
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        message: string;
      };
      return {
        success: false,
        output: err.stderr || err.message,
        metadata: { stdout: err.stdout, stderr: err.stderr },
      };
    }
  },
};

export const shellWhich: ToolDefinition = {
  name: "shell_which",
  description: "Find the location of an executable on PATH",
  parameters: {
    name: {
      type: "string",
      description: "Name of the executable to find",
      required: true,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const name = params.name as string;
      const finder = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(finder, [name]);
      return { success: true, output: stdout.trim() };
    } catch {
      return {
        success: false,
        output: `Executable not found: ${params.name}`,
      };
    }
  },
};

export const processList: ToolDefinition = {
  name: "process_list",
  description: "List running processes",
  parameters: {
    filter: {
      type: "string",
      description: "Filter processes by name",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const filter = params.filter as string | undefined;
      const { stdout } =
        process.platform === "win32"
          ? await execFileAsync("tasklist")
          : await execFileAsync("ps", ["aux"]);

      // Filtering happens here, in JS, rather than piping through a
      // second shelled-out `grep ${filter}` — that used to let a filter
      // value like "; touch /tmp/x #" run as its own shell command.
      const output = filter
        ? stdout
            .split("\n")
            .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
            .join("\n")
        : stdout;

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: `Error listing processes: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const processKill: ToolDefinition = {
  name: "process_kill",
  description: "Kill a process by PID",
  parameters: {
    pid: { type: "number", description: "Process ID to kill", required: true },
    signal: {
      type: "string",
      description: "Signal to send (SIGTERM, SIGKILL, etc.)",
      required: false,
      default: "SIGTERM",
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const pid = params.pid as number;
      const signal = (params.signal as string) ?? "SIGTERM";
      process.kill(pid, signal as NodeJS.Signals);
      return { success: true, output: `Sent ${signal} to process ${pid}` };
    } catch (error) {
      return {
        success: false,
        output: `Error killing process: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const logsRead: ToolDefinition = {
  name: "logs_read",
  description: "Read log file contents",
  parameters: {
    path: { type: "string", description: "Path to log file", required: true },
    lines: {
      type: "number",
      description: "Number of lines to read from end",
      required: false,
      default: 100,
    },
    filter: {
      type: "string",
      description: "Filter lines by pattern",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const path = params.path as string;
      const lines = (params.lines as number) ?? 100;
      const filter = params.filter as string | undefined;

      if (!existsSync(path)) {
        return { success: false, output: `Log file not found: ${path}` };
      }

      // Reads the file directly rather than shelling out to
      // tail/grep/powershell — removes the injection surface entirely
      // (both `path` and `filter` used to be interpolated unescaped into
      // a shell command), and works identically on every platform.
      let allLines = readFileSync(path, "utf-8").split("\n");
      // A trailing newline (the common case for a real log file) produces
      // a trailing "" element from split("\n") — without dropping it,
      // `lines: N` would return the last N-1 real lines plus a blank one,
      // one short of what `tail -n N` actually returns.
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines = allLines.slice(0, -1);
      }
      const tail = allLines.slice(-lines);

      let filterRegex: RegExp | undefined;
      if (filter) {
        try {
          filterRegex = new RegExp(filter);
        } catch {
          return {
            success: false,
            output: `Invalid filter pattern: ${filter}`,
          };
        }
      }

      const result = filterRegex
        ? tail.filter((line) => filterRegex!.test(line))
        : tail;

      return { success: true, output: result.join("\n") };
    } catch (error) {
      return {
        success: false,
        output: `Error reading logs: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

// ============================================================================
// Git Tools
// ============================================================================

export const gitStatus: ToolDefinition = {
  name: "git_status",
  description: "Get git repository status",
  parameters: {
    cwd: { type: "string", description: "Repository path", required: false },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const { stdout } = await execAsync("git status --porcelain", { cwd });

      if (!stdout.trim()) {
        return { success: true, output: "Working tree clean" };
      }

      const lines = stdout.trim().split("\n");
      const files = lines.map((line) => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        return `${status}: ${file}`;
      });

      return { success: true, output: files.join("\n") };
    } catch (error) {
      return {
        success: false,
        output: `Not a git repository or error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitLog: ToolDefinition = {
  name: "git_log",
  description: "Get git commit history",
  parameters: {
    cwd: { type: "string", description: "Repository path", required: false },
    limit: {
      type: "number",
      description: "Maximum number of commits",
      required: false,
      default: 10,
    },
    file: {
      type: "string",
      description: "Filter by file path",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const limit = (params.limit as number) ?? 10;
      const file = params.file as string | undefined;

      const args = ["log", "--oneline", "-n", String(limit)];
      if (file) args.push("--", file);

      const { stdout } = await execFileAsync("git", args, { cwd });
      return { success: true, output: stdout || "No commits found" };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitAdd: ToolDefinition = {
  name: "git_add",
  description: "Stage files for commit",
  parameters: {
    files: { type: "array", description: "Files to stage", required: true },
    cwd: { type: "string", description: "Repository path", required: false },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const files = (params.files as string[]) ?? ["."];

      await execFileAsync("git", ["add", ...files], { cwd });

      return { success: true, output: `Staged ${files.length} file(s)` };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitCommit: ToolDefinition = {
  name: "git_commit",
  description: "Create a git commit",
  parameters: {
    message: { type: "string", description: "Commit message", required: true },
    cwd: { type: "string", description: "Repository path", required: false },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const message = params.message as string;

      const { stdout } = await execFileAsync("git", ["commit", "-m", message], { cwd });

      return { success: true, output: stdout };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitDiff: ToolDefinition = {
  name: "git_diff",
  description: "Show git diff",
  parameters: {
    cwd: { type: "string", description: "Repository path", required: false },
    staged: {
      type: "boolean",
      description: "Show staged changes",
      required: false,
      default: false,
    },
    file: {
      type: "string",
      description: "Filter by file path",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const staged = (params.staged as boolean) ?? false;
      const file = params.file as string | undefined;

      const args = ["diff"];
      if (staged) args.push("--staged");
      if (file) args.push("--", file);

      const { stdout } = await execFileAsync("git", args, { cwd });
      return { success: true, output: stdout || "No changes" };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

// ============================================================================
// Memory Tools
// ============================================================================

export const memoryStore: ToolDefinition = {
  name: "memory_store",
  description: "Store information in memory",
  parameters: {
    key: {
      type: "string",
      description: "Key for the memory entry",
      required: true,
    },
    value: { type: "string", description: "Value to store", required: true },
    type: {
      type: "string",
      description: "Memory type (pattern, decision, preference)",
      required: false,
      default: "pattern",
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const memory = getMemoryManager();

      const key = params.key as string;
      const value = params.value as string;
      const type = (params.type as string) ?? "pattern";

      await memory.store(type as any, `${key}: ${value}`, { key });

      return { success: true, output: `Stored: ${key}` };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const memoryRetrieve: ToolDefinition = {
  name: "memory_retrieve",
  description: "Retrieve information from memory",
  parameters: {
    query: { type: "string", description: "Search query", required: true },
    limit: {
      type: "number",
      description: "Maximum results",
      required: false,
      default: 5,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const memory = getMemoryManager();

      const query = params.query as string;
      const limit = (params.limit as number) ?? 5;

      const results = await memory.search(query, limit);

      if (results.length === 0) {
        return { success: true, output: "No results found" };
      }

      const output = results
        .map((r) => `[${r.entry.type}] ${r.entry.content}`)
        .join("\n\n");

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

// ============================================================================
// Test Tools
// ============================================================================

export const testRun: ToolDefinition = {
  name: "test_run",
  description: "Run tests in a project",
  parameters: {
    cwd: { type: "string", description: "Project directory", required: false },
    pattern: {
      type: "string",
      description: "Test pattern to run",
      required: false,
    },
    coverage: {
      type: "boolean",
      description: "Generate coverage report",
      required: false,
      default: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const cwd = (params.cwd as string) ?? process.cwd();
      const pattern = params.pattern as string | undefined;
      const coverage = (params.coverage as boolean) ?? false;

      // Detect test framework
      let bin = "npm";
      let args = ["test"];
      if (
        existsSync(join(cwd, "vitest.config.ts")) ||
        existsSync(join(cwd, "vitest.config.js"))
      ) {
        bin = "npx";
        args = ["vitest", "run"];
        if (coverage) args.push("--coverage");
        if (pattern) args.push("--grep", pattern);
      } else if (
        existsSync(join(cwd, "jest.config.ts")) ||
        existsSync(join(cwd, "jest.config.js"))
      ) {
        bin = "npx";
        args = ["jest"];
        if (coverage) args.push("--coverage");
        if (pattern) args.push("--testNamePattern", pattern);
      }

      const { stdout, stderr } = await execFileAsync(bin, args, {
        cwd,
        timeout: 120000,
      });

      return {
        success: true,
        output: stdout || stderr,
        metadata: { stdout, stderr },
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        success: false,
        output: err.stderr || err.stdout || "Test execution failed",
        metadata: { stdout: err.stdout, stderr: err.stderr },
      };
    }
  },
};

function hasLintScript(cwd: string): boolean {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg?.scripts?.lint === "string";
  } catch {
    return false;
  }
}

export const workspaceVerify: ToolDefinition = {
  name: "workspace_verify",
  description:
    "Verify workspace integrity across ALL files: runs TypeScript type-checking (tsc -p .) and unit tests to ensure no broken dependencies or imports exist across the codebase. Also runs lint when risk is high.",
  parameters: {
    cwd: {
      type: "string",
      description: "Working directory for workspace verification",
      required: false,
    },
    runTests: {
      type: "boolean",
      description: "Whether to run test suite alongside typechecking",
      required: false,
      default: true,
    },
    risk: {
      type: "string",
      description:
        "Task risk level ('low'|'medium'|'high') — 'high' also runs lint if the target project has a lint script.",
      required: false,
    },
    runLint: {
      type: "boolean",
      description: "Force the lint check regardless of risk level",
      required: false,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const cwd =
      (params.cwd as string) ?? (params.path as string) ?? process.cwd();
    const runTests = (params.runTests as boolean) ?? true;
    const risk = params.risk as string | undefined;
    const shouldLint =
      ((risk === "high" || params.runLint === true) && hasLintScript(cwd));
    const logs: string[] = [];
    // Tracked per-check (not one shared flag) so a failure in one check
    // can't misreport an unrelated check's status field.
    let compilationStatus: "PASSED (0 errors)" | "FAILED" | "SKIPPED (no tsconfig.json)" =
      "SKIPPED (no tsconfig.json)";
    let testsStatus: "PASSED" | "FAILED" | "SKIPPED" = "SKIPPED";
    let lintStatus: "PASSED" | "FAILED" | "SKIPPED" = "SKIPPED";

    // 1. TypeScript compilation check
    if (existsSync(join(cwd, "tsconfig.json"))) {
      try {
        await execAsync("npx tsc -p . --noEmit", { cwd, timeout: 60000 });
        logs.push("✔ TypeScript compilation check: PASSED (0 errors)");
        compilationStatus = "PASSED (0 errors)";
      } catch (error) {
        compilationStatus = "FAILED";
        const err = error as { stdout?: string; stderr?: string };
        logs.push(
          `✖ TypeScript compilation check: FAILED\n${err.stdout || err.stderr || String(error)}`,
        );
      }
    }

    // 2. Unit tests check
    if (runTests && existsSync(join(cwd, "package.json"))) {
      try {
        await execAsync("npm test", { cwd, timeout: 120000 });
        logs.push("✔ Test suite check: PASSED");
        testsStatus = "PASSED";
      } catch (error) {
        testsStatus = "FAILED";
        const err = error as { stdout?: string; stderr?: string };
        logs.push(
          `✖ Test suite check: FAILED\n${err.stdout || err.stderr || String(error)}`,
        );
      }
    }

    // 3. Lint check — only for high-risk tasks (or an explicit override),
    // and only if the target project actually defines a lint script.
    if (shouldLint) {
      try {
        await execAsync("npm run lint", { cwd, timeout: 60000 });
        logs.push("✔ Lint check: PASSED");
        lintStatus = "PASSED";
      } catch (error) {
        lintStatus = "FAILED";
        const err = error as { stdout?: string; stderr?: string };
        logs.push(
          `✖ Lint check: FAILED\n${err.stdout || err.stderr || String(error)}`,
        );
      }
    }

    const overallSuccess =
      compilationStatus !== "FAILED" &&
      testsStatus !== "FAILED" &&
      lintStatus !== "FAILED";

    const resultPayload = {
      status: overallSuccess ? "success" : "failed",
      tool: "workspace_verify",
      compilation: compilationStatus,
      tests: testsStatus,
      lint: lintStatus,
      risk: risk ?? "unspecified",
      details: logs,
    };

    return {
      success: overallSuccess,
      output: JSON.stringify(resultPayload, null, 2),
      metadata: resultPayload,
    };
  },
};

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all built-in tools
 */
export function registerBuiltinTools(
  registry: import("./ToolRegistry.js").ToolRegistry,
): void {
  // File system tools
  registry.register(fileRead);
  registry.register(fileWrite);
  registry.register(fileDelete);
  registry.register(fileList);

  // Shell tools
  registry.register(shellExec);
  registry.register(shellWhich);
  registry.register(processList);
  registry.register(processKill);
  registry.register(logsRead);

  // Git tools
  registry.register(gitStatus);
  registry.register(gitLog);
  registry.register(gitAdd);
  registry.register(gitCommit);
  registry.register(gitDiff);

  // Memory tools
  registry.register(memoryStore);
  registry.register(memoryRetrieve);

  // Test & Verification tools
  registry.register(testRun);
  registry.register(workspaceVerify);

  // Code search tools (search_files, search_content, grep, find_usages,
  // analyze_imports, analyze_exports, count_lines) — previously defined but
  // never registered, so the only way to search code was an LLM-improvised
  // shell_exec call.
  for (const tool of createCodeSearchTools()) {
    registry.register(tool);
  }

  // file_exists/file_copy/file_move/directory_create/file_restore — the
  // file_read/file_write/file_delete/file_list this file used to ALSO
  // define here were removed after the duplication caused a real bug (see
  // file-system.ts's file header): this file's own fileWrite/fileDelete
  // above are the ones actually reachable through the tool registry.
  for (const tool of createFileSystemTools()) {
    registry.register(tool);
  }

  // git_branch/git_checkout/git_reset/git_remote/git_push/git_pull —
  // previously defined but never registered anywhere, so the agent had no
  // way to create/switch branches, push, pull, or reset at all (only
  // status/diff/log/add/commit, registered individually above).
  for (const tool of createGitTools()) {
    registry.register(tool);
  }

  // Sub-agent delegation (see core/orchestrator/ParallelOrchestrator.ts).
  // Only granted to `code`/`plan` modes via TOOL_SETS — see tool-sets.ts.
  registry.register(spawnSubagentTool);
}

let builtinToolsRegistered = false;

/**
 * Idempotent convenience wrapper around registerBuiltinTools() for the
 * common case of registering onto the process-wide default registry once
 * per process. Tests that need a fresh/custom registry should call
 * registerBuiltinTools(registry) directly instead.
 */
export function ensureBuiltinToolsRegistered(): void {
  if (builtinToolsRegistered) return;
  builtinToolsRegistered = true;

  registerBuiltinTools(getToolRegistry());
  getLogger().info("Built-in tools registered");
}
