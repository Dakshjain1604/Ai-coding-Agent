/**
 * Built-in Tools - File system, shell, git, and other core tools
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "fs";
import { join, dirname, basename, extname } from "path";
import { execSync, spawn } from "child_process";
import { getToolRegistry, type ToolDefinition } from "./ToolRegistry.js";
import { getLogger } from "../../utils/logger.js";
import { getConfigManager } from "../../utils/config.js";
import { getTaskManager } from "../../utils/task-manager.js";

const logger = getLogger();

let toolsRegistered = false;

function getOutputDir(): string {
  return getTaskManager().getTaskOutputDir();
}

function resolveOutputPath(relativePath: string): string {
  const outputDir = getOutputDir();
  if (relativePath.startsWith(outputDir)) {
    return relativePath;
  }
  if (relativePath.startsWith("/") || relativePath.includes(":")) {
    return relativePath;
  }
  return join(outputDir, relativePath);
}

// ============================================================================
// File System Tools
// ============================================================================

export const fileRead: ToolDefinition = {
  name: "file_read",
  description: "Read contents of a file",
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
  },
  handler: async (params) => {
    try {
      const filePath = params.path as string;
      const encoding = (params.encoding as BufferEncoding) ?? "utf-8";

      if (!existsSync(filePath)) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      const content = readFileSync(filePath, encoding);
      return { success: true, output: content.toString() };
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
      description: "Write mode: write (overwrite), append",
      required: false,
      default: "write",
      enum: ["write", "append"],
    },
  },
  handler: async (params) => {
    try {
      let filePath = params.path as string;
      const content = params.content as string;
      const mode = (params.mode as "write" | "append") ?? "write";

      filePath = resolveOutputPath(filePath);

      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      if (mode === "append") {
        const existing = existsSync(filePath)
          ? readFileSync(filePath, "utf-8")
          : "";
        writeFileSync(filePath, existing + content);
      } else {
        writeFileSync(filePath, content);
      }

      return { success: true, output: `Successfully wrote to ${filePath}` };
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
  description: "Delete a file",
  parameters: {
    path: {
      type: "string",
      description: "Path to the file to delete",
      required: true,
    },
  },
  handler: async (params) => {
    try {
      const filePath = params.path as string;

      if (!existsSync(filePath)) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      unlinkSync(filePath);
      return { success: true, output: `Successfully deleted ${filePath}` };
    } catch (error) {
      return {
        success: false,
        output: `Error deleting file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const fileMove: ToolDefinition = {
  name: "file_move",
  description: "Move or rename a file",
  parameters: {
    source: {
      type: "string",
      description: "Source file path",
      required: true,
    },
    destination: {
      type: "string",
      description: "Destination file path",
      required: true,
    },
  },
  handler: async (params) => {
    try {
      const source = params.source as string;
      const destination = params.destination as string;

      if (!existsSync(source)) {
        return { success: false, output: `Source file not found: ${source}` };
      }

      // Ensure destination directory exists
      const dir = dirname(destination);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      renameSync(source, destination);
      return {
        success: true,
        output: `Successfully moved ${source} to ${destination}`,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error moving file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const directoryList: ToolDefinition = {
  name: "directory_list",
  description: "List contents of a directory",
  parameters: {
    path: {
      type: "string",
      description: "Directory path to list",
      required: true,
    },
    recursive: {
      type: "boolean",
      description: "List recursively",
      required: false,
      default: false,
    },
  },
  handler: async (params) => {
    try {
      const dirPath = params.path as string;
      const recursive = (params.recursive as boolean) ?? false;

      if (!existsSync(dirPath)) {
        return { success: false, output: `Directory not found: ${dirPath}` };
      }

      const stats = statSync(dirPath);
      if (!stats.isDirectory()) {
        return { success: false, output: `Not a directory: ${dirPath}` };
      }

      const listFiles = (dir: string, prefix = ""): string[] => {
        const items = readdirSync(dir);
        const results: string[] = [];

        for (const item of items) {
          const fullPath = join(dir, item);
          const itemStats = statSync(fullPath);

          if (itemStats.isDirectory()) {
            results.push(`${prefix}${item}/`);
            if (recursive) {
              results.push(...listFiles(fullPath, `${prefix}${item}/`));
            }
          } else {
            results.push(`${prefix}${item}`);
          }
        }

        return results;
      };

      const files = listFiles(dirPath);
      return { success: true, output: files.join("\n") };
    } catch (error) {
      return {
        success: false,
        output: `Error listing directory: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

// ============================================================================
// Shell Tools
// ============================================================================

export const shellExec: ToolDefinition = {
  name: "shell_exec",
  description: "Execute a shell command",
  parameters: {
    command: {
      type: "string",
      description: "Shell command to execute",
      required: true,
    },
    cwd: {
      type: "string",
      description: "Working directory for command execution",
      required: false,
    },
    timeout: {
      type: "number",
      description: "Timeout in milliseconds",
      required: false,
      default: 30000,
    },
  },
  handler: async (params) => {
    try {
      const command = params.command as string;
      const cwd = (params.cwd as string) ?? process.cwd();
      const timeout = (params.timeout as number) ?? 30000;

      logger.debug(`Executing command: ${command}`);

      const output = execSync(command, {
        cwd,
        timeout,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      return { success: true, output: output.toString() };
    } catch (error) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        success: false,
        output:
          execError.stdout ??
          execError.stderr ??
          execError.message ??
          "Unknown error",
        metadata: { error: true },
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
    path: {
      type: "string",
      description: "Repository path",
      required: false,
      default: ".",
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      const output = execSync("git status --porcelain", {
        cwd: path,
        encoding: "utf-8",
      });

      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: path,
        encoding: "utf-8",
      }).trim();

      return {
        success: true,
        output: `Branch: ${branch}\n\n${output || "Clean working directory"}`,
      };
    } catch (error) {
      return {
        success: false,
        output: `Error getting git status: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitLog: ToolDefinition = {
  name: "git_log",
  description: "Get git commit history",
  parameters: {
    path: {
      type: "string",
      description: "Repository path",
      required: false,
      default: ".",
    },
    count: {
      type: "number",
      description: "Number of commits to show",
      required: false,
      default: 10,
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      const count = (params.count as number) ?? 10;

      const output = execSync(`git log --oneline -${count}`, {
        cwd: path,
        encoding: "utf-8",
      });

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: `Error getting git log: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitDiff: ToolDefinition = {
  name: "git_diff",
  description: "Get git diff output",
  parameters: {
    path: {
      type: "string",
      description: "Repository path",
      required: false,
      default: ".",
    },
    file: {
      type: "string",
      description: "Specific file to diff",
      required: false,
    },
    staged: {
      type: "boolean",
      description: "Show staged changes",
      required: false,
      default: false,
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      const file = params.file as string | undefined;
      const staged = (params.staged as boolean) ?? false;

      let command = "git diff";
      if (staged) command += " --staged";
      if (file) command += ` -- ${file}`;

      const output = execSync(command, {
        cwd: path,
        encoding: "utf-8",
      });

      return { success: true, output: output || "No changes" };
    } catch (error) {
      return {
        success: false,
        output: `Error getting git diff: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitAdd: ToolDefinition = {
  name: "git_add",
  description: "Stage files for commit",
  parameters: {
    path: {
      type: "string",
      description: "Repository path",
      required: false,
      default: ".",
    },
    files: {
      type: "array",
      description: 'Files to stage (or ["."] for all)',
      required: true,
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      const files = params.files as string[];

      const command = `git add ${files.join(" ")}`;
      execSync(command, { cwd: path, encoding: "utf-8" });

      return { success: true, output: `Staged ${files.length} file(s)` };
    } catch (error) {
      return {
        success: false,
        output: `Error staging files: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};

export const gitCommit: ToolDefinition = {
  name: "git_commit",
  description: "Create a git commit",
  parameters: {
    path: {
      type: "string",
      description: "Repository path",
      required: false,
      default: ".",
    },
    message: {
      type: "string",
      description: "Commit message",
      required: true,
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      const message = params.message as string;

      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: path,
        encoding: "utf-8",
      });

      return { success: true, output: `Created commit: ${message}` };
    } catch (error) {
      return {
        success: false,
        output: `Error creating commit: ${error instanceof Error ? error.message : "Unknown error"}`,
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
    path: {
      type: "string",
      description: "Project path",
      required: false,
      default: ".",
    },
    command: {
      type: "string",
      description: "Test command (npm test, pytest, etc.)",
      required: false,
      default: "npm test",
    },
    coverage: {
      type: "boolean",
      description: "Generate coverage report",
      required: false,
      default: false,
    },
  },
  handler: async (params) => {
    try {
      const path = (params.path as string) ?? ".";
      let command = (params.command as string) ?? "npm test";
      const coverage = (params.coverage as boolean) ?? false;

      if (coverage && command === "npm test") {
        command = "npm test -- --coverage";
      }

      const output = execSync(command, {
        cwd: path,
        encoding: "utf-8",
        timeout: 120000, // 2 minutes
      });

      // Parse test results
      const passed = (output.match(/passed|\d+ passing/gi) || []).length;
      const failed = (output.match(/failed|\d+ failing/gi) || []).length;

      return {
        success: true,
        output,
        metadata: {
          passed,
          failed,
          total: passed + failed,
        },
      };
    } catch (error) {
      const execError = error as { stdout?: string };
      return {
        success: false,
        output: execError.stdout ?? "Test execution failed",
      };
    }
  },
};

// ============================================================================
// Register All Tools
// ============================================================================

export function registerBuiltInTools(): void {
  // Prevent duplicate registration (singleton pattern)
  if (toolsRegistered) return;
  toolsRegistered = true;

  const registry = getToolRegistry();

  // File system tools
  registry.register(fileRead);
  registry.register(fileWrite);
  registry.register(fileDelete);
  registry.register(fileMove);
  registry.register(directoryList);

  // Register directory_create from file-system module
  try {
    const { createFileSystemTools } = require("./file-system.js");
    const fsTools = createFileSystemTools();
    for (const tool of fsTools) {
      if (!registry.has(tool.name)) {
        registry.register(tool);
      }
    }
  } catch {
    // file-system module tools not available, skip
  }

  // Shell tools
  registry.register(shellExec);

  // Git tools
  registry.register(gitStatus);
  registry.register(gitLog);
  registry.register(gitDiff);
  registry.register(gitAdd);
  registry.register(gitCommit);

  // Test tools
  registry.register(testRun);

  logger.info("Built-in tools registered");
}
