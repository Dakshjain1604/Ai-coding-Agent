/**
 * File System Tools
 *
 * Only file_exists/file_copy/file_move/directory_create/file_restore live
 * here — file_read/file_write/file_delete/file_list ALSO used to be
 * defined here, but registerBuiltinTools() (builtin.ts) only ever
 * registered this file's versions of the tools NOT already defined
 * directly in builtin.ts itself (see the FS_EXTRAS allowlist there), so
 * those four were 100% dead code: never reachable through the real
 * ToolRegistry, only through calling createFileSystemTools() directly.
 * Confirmed the hard way — the rollback-safety-net snapshot() call was
 * first added to this file's file_write/file_delete and silently never
 * ran in the real agent loop, because builtin.ts's own fileWrite/
 * fileDelete are what's actually registered and used. Removed rather than
 * left to rot as a second, drifting implementation of the same tool names.
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from "fs";
import { join, dirname, relative, isAbsolute, sep } from "path";
import { getTaskManager } from "../../utils/task-manager.js";
import { getRollbackManager } from "../../utils/git-rollback.js";

function getOutputDir(): string {
  return getTaskManager().getTaskOutputDir();
}

/**
 * Resolves a relative path against the sandbox output directory, or
 * passes an already-absolute path through unchanged. The relative-path
 * branch is supposed to guarantee the result stays inside outputDir —
 * confirmed live that it didn't: `join(outputDir, "../../../../tmp/x")`
 * resolves OUTSIDE outputDir entirely (path.join doesn't clamp `..`
 * segments to a base directory), so directory_create({path: "../../../
 * ../tmp/ESCAPED"}) wrote a real directory straight into the user's home
 * folder in one live reproduction. Now rejects any relative path whose
 * resolved form escapes outputDir, instead of silently honoring it.
 */
function resolveOutputPath(relativePath: string): string {
  const outputDir = getOutputDir();
  // Path-boundary-aware, not a raw string prefix check — the old
  // `relativePath.startsWith(outputDir)` also treated a sibling directory
  // that merely shares outputDir as a string prefix (e.g. "output-old"
  // when outputDir is "output") as if it were already inside the sandbox.
  if (relativePath === outputDir || relativePath.startsWith(outputDir + sep)) {
    return relativePath;
  }
  if (relativePath.startsWith("/") || relativePath.includes(":")) {
    return relativePath;
  }

  const resolved = join(outputDir, relativePath);
  const rel = relative(outputDir, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `Path traversal blocked: "${relativePath}" resolves outside the sandboxed output directory (${outputDir})`,
    );
  }
  return resolved;
}

export function createFileSystemTools(): ToolDefinition[] {
  return [
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

          // Read, write, delete — snapshot the source before it's removed
          // so an undo can restore the file at its original location.
          const content = readFileSync(source);
          getRollbackManager().snapshot(source);
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
      name: "file_restore",
      description:
        "Restore a file to its content from before the last file_write/file_delete/file_move that touched it. Use this to self-correct after a write that turned out to be wrong. Fails if no backup exists for the path.",
      parameters: {
        path: {
          type: "string",
          description: "Path to the file to restore",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = params.path as string;
          const rollback = getRollbackManager();

          if (!rollback.hasBackup(path)) {
            return {
              success: false,
              output: `No backup found for ${path} — nothing to restore.`,
            };
          }

          const restored = rollback.rollback(path);
          return restored
            ? { success: true, output: `Successfully restored ${path} from backup.` }
            : { success: false, output: `Failed to restore ${path} — the write-back itself failed.` };
        } catch (error) {
          return {
            success: false,
            output: `Error restoring file: ${error instanceof Error ? error.message : "Unknown error"}`,
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
