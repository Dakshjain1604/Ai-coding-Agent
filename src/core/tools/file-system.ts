/**
 * File System Tools
 * Tools for file operations: read, write, delete, list
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname, basename, extname } from "path";
import { getConfigManager } from "../../utils/config.js";
import { getTaskManager } from "../../utils/task-manager.js";

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

export function createFileSystemTools(): ToolDefinition[] {
  return [
    {
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
          description: "File encoding (utf-8, base64, etc.)",
          required: false,
          default: "utf-8",
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
          return { success: true, output: content.toString() };
        } catch (error) {
          return {
            success: false,
            output: `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
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
          description: "Write mode: write (overwrite), append, or prepend",
          required: false,
          default: "write",
          enum: ["write", "append", "prepend"],
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          let path = params.path as string;
          const content = params.content as string;
          const mode =
            (params.mode as "write" | "append" | "prepend") ?? "write";

          path = resolveOutputPath(path);

          // Ensure directory exists
          const dir = dirname(path);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          let finalContent = content;
          if (mode === "append" && existsSync(path)) {
            finalContent = readFileSync(path, "utf-8") + content;
          } else if (mode === "prepend" && existsSync(path)) {
            finalContent = content + readFileSync(path, "utf-8");
          }

          writeFileSync(path, finalContent, "utf-8");
          return {
            success: true,
            output: `Successfully wrote ${finalContent.length} bytes to ${path}`,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error writing file: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "file_delete",
      description: "Delete a file",
      parameters: {
        path: {
          type: "string",
          description: "Path to the file to delete",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = params.path as string;

          if (!existsSync(path)) {
            return { success: false, output: `File not found: ${path}` };
          }

          unlinkSync(path);
          return { success: true, output: `Successfully deleted ${path}` };
        } catch (error) {
          return {
            success: false,
            output: `Error deleting file: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "file_list",
      description: "List files in a directory",
      parameters: {
        path: {
          type: "string",
          description: "Path to the directory",
          required: true,
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
          required: false,
          default: false,
        },
        pattern: {
          type: "string",
          description: "Glob pattern to filter files",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = params.path as string;
          const recursive = (params.recursive as boolean) ?? false;
          const pattern = params.pattern as string | undefined;

          if (!existsSync(path)) {
            return { success: false, output: `Directory not found: ${path}` };
          }

          const files = recursive
            ? listRecursive(path, pattern)
            : listFlat(path, pattern);

          return {
            success: true,
            output: files.join("\n"),
            metadata: { count: files.length },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error listing directory: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "file_exists",
      description: "Check if a file or directory exists",
      parameters: {
        path: {
          type: "string",
          description: "Path to check",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = params.path as string;
          const exists = existsSync(path);

          if (exists) {
            const stats = statSync(path);
            const type = stats.isDirectory() ? "directory" : "file";
            return {
              success: true,
              output: `Path exists: ${path} (${type})`,
              metadata: { type, size: stats.size },
            };
          }

          return { success: true, output: `Path does not exist: ${path}` };
        } catch (error) {
          return {
            success: false,
            output: `Error checking path: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "file_copy",
      description: "Copy a file",
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
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const source = params.source as string;
          let destination = params.destination as string;

          destination = resolveOutputPath(destination);

          if (!existsSync(source)) {
            return {
              success: false,
              output: `Source file not found: ${source}`,
            };
          }

          // Ensure destination directory exists
          const destDir = dirname(destination);
          if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
          }

          const content = readFileSync(source);
          writeFileSync(destination, content);

          return {
            success: true,
            output: `Successfully copied ${source} to ${destination}`,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error copying file: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
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
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const source = params.source as string;
          let destination = params.destination as string;

          destination = resolveOutputPath(destination);

          if (!existsSync(source)) {
            return {
              success: false,
              output: `Source file not found: ${source}`,
            };
          }

          // Ensure destination directory exists
          const destDir = dirname(destination);
          if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
          }

          // Read, write, delete
          const content = readFileSync(source);
          writeFileSync(destination, content);
          unlinkSync(source);

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
    },

    {
      name: "directory_create",
      description: "Create a directory",
      parameters: {
        path: {
          type: "string",
          description: "Path to the directory to create",
          required: true,
        },
        recursive: {
          type: "boolean",
          description: "Create parent directories if needed",
          required: false,
          default: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          let path = params.path as string;
          const recursive = (params.recursive as boolean) ?? true;

          path = resolveOutputPath(path);

          if (existsSync(path)) {
            return {
              success: true,
              output: `Directory already exists: ${path}`,
            };
          }

          mkdirSync(path, { recursive });
          return {
            success: true,
            output: `Successfully created directory: ${path}`,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error creating directory: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },
  ];
}

// Helper functions
function listFlat(dir: string, pattern?: string): string[] {
  const entries = readdirSync(dir);
  let files = entries.map((e) => join(dir, e));

  if (pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    files = files.filter((f) => regex.test(basename(f)));
  }

  return files;
}

function listRecursive(
  dir: string,
  pattern?: string,
  result: string[] = [],
): string[] {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      listRecursive(fullPath, pattern, result);
    } else {
      if (!pattern || new RegExp(pattern.replace(/\*/g, ".*")).test(fullPath)) {
        result.push(fullPath);
      }
    }
  }

  return result;
}
