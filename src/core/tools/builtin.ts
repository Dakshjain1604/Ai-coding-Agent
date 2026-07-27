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
import { execSync, exec } from "child_process";
import { promisify } from "util";
import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";

const execAsync = promisify(exec);

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

      writeFileSync(path, finalContent, "utf-8");

      // Auto-format post write
      try {
        const { formatFile } = await import("../../utils/formatter.js");
        await formatFile(path);
      } catch {
        // Formatter is optional
      }

      // Check dependent files via AST dependency graph
      let depMsg = "";
      try {
        const { getDependencyGraph } = await import("../../utils/dependency-graph.js");
        const dependents = getDependencyGraph().getDependentFiles(path);
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
      } else {
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

      let command = `git log --oneline -n ${limit}`;
      if (file) {
        command += ` -- "${file}"`;
      }

      const { stdout } = await execAsync(command, { cwd });
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

      const command = `git add ${files.map((f) => `"${f}"`).join(" ")}`;
      await execAsync(command, { cwd });

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

      const command = `git commit -m "${message.replace(/"/g, '\\"')}"`;
      const { stdout } = await execAsync(command, { cwd });

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

      let command = "git diff";
      if (staged) command += " --staged";
      if (file) command += ` -- "${file}"`;

      const { stdout } = await execAsync(command, { cwd });
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
      const { getMemoryManager } =
        await import("../../memory/MemoryManager.js");
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
      const { getMemoryManager } =
        await import("../../memory/MemoryManager.js");
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
      let command = "npm test";
      if (
        existsSync(join(cwd, "vitest.config.ts")) ||
        existsSync(join(cwd, "vitest.config.js"))
      ) {
        command = "npx vitest run";
        if (coverage) command += " --coverage";
        if (pattern) command += ` --grep "${pattern}"`;
      } else if (
        existsSync(join(cwd, "jest.config.ts")) ||
        existsSync(join(cwd, "jest.config.js"))
      ) {
        command = "npx jest";
        if (coverage) command += " --coverage";
        if (pattern) command += ` --testNamePattern="${pattern}"`;
      }

      const { stdout, stderr } = await execAsync(command, {
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

export const workspaceVerify: ToolDefinition = {
  name: "workspace_verify",
  description:
    "Verify workspace integrity across ALL files: runs TypeScript type-checking (tsc -p .) and unit tests to ensure no broken dependencies or imports exist across the codebase.",
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
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const cwd = (params.cwd as string) ?? (params.path as string) ?? process.cwd();
    const runTests = (params.runTests as boolean) ?? true;
    const logs: string[] = [];
    let overallSuccess = true;

    // 1. TypeScript compilation check
    if (existsSync(join(cwd, "tsconfig.json"))) {
      try {
        await execAsync("npx tsc -p . --noEmit", { cwd, timeout: 60000 });
        logs.push("✔ TypeScript compilation check: PASSED (0 errors)");
      } catch (error) {
        overallSuccess = false;
        const err = error as { stdout?: string; stderr?: string };
        logs.push(`✖ TypeScript compilation check: FAILED\n${err.stdout || err.stderr || String(error)}`);
      }
    }

    // 2. Unit tests check
    if (runTests && existsSync(join(cwd, "package.json"))) {
      try {
        await execAsync("npm test", { cwd, timeout: 120000 });
        logs.push("✔ Test suite check: PASSED");
      } catch (error) {
        overallSuccess = false;
        const err = error as { stdout?: string; stderr?: string };
        logs.push(`✖ Test suite check: FAILED\n${err.stdout || err.stderr || String(error)}`);
      }
    }

    const resultPayload = {
      status: overallSuccess ? "success" : "failed",
      tool: "workspace_verify",
      compilation: existsSync(join(cwd, "tsconfig.json"))
        ? overallSuccess
          ? "PASSED (0 errors)"
          : "FAILED"
        : "SKIPPED (no tsconfig.json)",
      tests: runTests && existsSync(join(cwd, "package.json"))
        ? overallSuccess
          ? "PASSED"
          : "FAILED"
        : "SKIPPED",
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
}
