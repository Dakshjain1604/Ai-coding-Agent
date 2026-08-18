/**
 * Code Search Tools
 * Tools for searching and analyzing code
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";

export function createCodeSearchTools(): ToolDefinition[] {
  return [
    {
      name: "search_files",
      description: "Search for files by pattern",
      parameters: {
        directory: {
          type: "string",
          description: "Directory to search in",
          required: false,
          default: ".",
        },
        pattern: {
          type: "string",
          description: "Glob pattern to match files",
          required: true,
        },
        exclude: {
          type: "array",
          description: "Patterns to exclude",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const directory = (params.directory as string) ?? ".";
          const pattern = params.pattern as string;
          const exclude = (params.exclude as string[]) ?? [];

          const files = searchFiles(directory, pattern, exclude);

          return {
            success: true,
            output: files.join("\n") || "No files found",
            metadata: { count: files.length },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error searching files: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "search_content",
      description: "Search for content in files",
      parameters: {
        directory: {
          type: "string",
          description: "Directory to search in",
          required: false,
          default: ".",
        },
        pattern: {
          type: "string",
          description: "Pattern to search for (regex)",
          required: true,
        },
        filePattern: {
          type: "string",
          description: "File pattern to search in",
          required: false,
          default: "*",
        },
        caseSensitive: {
          type: "boolean",
          description: "Case sensitive search",
          required: false,
          default: false,
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return",
          required: false,
          default: 100,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const directory = (params.directory as string) ?? ".";
          const pattern = params.pattern as string;
          const filePattern = (params.filePattern as string) ?? "*";
          const caseSensitive = (params.caseSensitive as boolean) ?? false;
          const maxResults = (params.maxResults as number) ?? 100;

          const results = searchContent(
            directory,
            pattern,
            filePattern,
            caseSensitive,
            maxResults,
          );

          return {
            success: true,
            output: results
              .map((r) => `${r.file}:${r.line}: ${r.content}`)
              .join("\n"),
            metadata: { count: results.length },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error searching content: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "grep",
      description: "Run grep command",
      parameters: {
        pattern: {
          type: "string",
          description: "Pattern to search for",
          required: true,
        },
        path: {
          type: "string",
          description: "Path to search in",
          required: false,
          default: ".",
        },
        recursive: {
          type: "boolean",
          description: "Search recursively",
          required: false,
          default: true,
        },
        caseSensitive: {
          type: "boolean",
          description: "Case sensitive search",
          required: false,
          default: false,
        },
        context: {
          type: "number",
          description: "Lines of context to show",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const pattern = params.pattern as string;
          const path = (params.path as string) ?? ".";
          const recursive = (params.recursive as boolean) ?? true;
          const caseSensitive = (params.caseSensitive as boolean) ?? false;
          const context = params.context as number | undefined;

          if (!existsSync(path)) {
            return { success: true, output: "No matches found" };
          }

          // Pure-JS, no shell involved — grep used to shell out with
          // `pattern`/`path` interpolated into a command string (only `"`
          // in the pattern was escaped; backticks, `$(...)`, `;`, and `|`
          // were not), which was a real, exploitable command-injection
          // vector. This mirrors search_content's already-safe design.
          const matches = grepSearch(pattern, path, {
            recursive,
            caseSensitive,
            context,
          });

          return {
            success: true,
            output: matches.length > 0 ? matches.join("\n") : "No matches found",
          };
        } catch (error) {
          return {
            success: false,
            output: `Error running grep: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "find_usages",
      description: "Find usages of a symbol",
      parameters: {
        symbol: {
          type: "string",
          description: "Symbol to find usages for",
          required: true,
        },
        directory: {
          type: "string",
          description: "Directory to search in",
          required: false,
          default: ".",
        },
        type: {
          type: "string",
          description: "Type of usage (definition, reference, all)",
          required: false,
          default: "all",
          enum: ["definition", "reference", "all"],
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const symbol = params.symbol as string;
          const directory = (params.directory as string) ?? ".";
          const type = (params.type as string) ?? "all";

          // Simple implementation: search for the symbol
          const pattern =
            type === "definition"
              ? `(class|interface|function|const|let|var)\\s+${symbol}`
              : type === "reference"
                ? `${symbol}(?![^\\w])`
                : symbol;

          const results = searchContent(directory, pattern, "*", false, 50);

          return {
            success: true,
            output: results
              .map((r) => `${r.file}:${r.line}: ${r.content}`)
              .join("\n"),
            metadata: { count: results.length },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error finding usages: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "analyze_imports",
      description: "Analyze imports in a file",
      parameters: {
        file: {
          type: "string",
          description: "File to analyze",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const file = params.file as string;

          if (!existsSync(file)) {
            return { success: false, output: `File not found: ${file}` };
          }

          const content = readFileSync(file, "utf-8");
          const imports = analyzeImports(content);

          return {
            success: true,
            output: imports.map((i) => `${i.type}: ${i.module}`).join("\n"),
            metadata: { imports },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error analyzing imports: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "analyze_exports",
      description: "Analyze exports in a file",
      parameters: {
        file: {
          type: "string",
          description: "File to analyze",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const file = params.file as string;

          if (!existsSync(file)) {
            return { success: false, output: `File not found: ${file}` };
          }

          const content = readFileSync(file, "utf-8");
          const exports = analyzeExports(content);

          return {
            success: true,
            output: exports.map((e) => `${e.type}: ${e.name}`).join("\n"),
            metadata: { exports },
          };
        } catch (error) {
          return {
            success: false,
            output: `Error analyzing exports: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "count_lines",
      description: "Count lines of code",
      parameters: {
        directory: {
          type: "string",
          description: "Directory to analyze",
          required: false,
          default: ".",
        },
        extensions: {
          type: "array",
          description: "File extensions to include",
          required: false,
        },
        exclude: {
          type: "array",
          description: "Patterns to exclude",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const directory = (params.directory as string) ?? ".";
          const extensions = (params.extensions as string[]) ?? [
            ".ts",
            ".js",
            ".tsx",
            ".jsx",
          ];
          const exclude = (params.exclude as string[]) ?? [
            "node_modules",
            "dist",
            ".git",
          ];

          const stats = countLines(directory, extensions, exclude);

          return {
            success: true,
            output: `Total lines: ${stats.total}\nFiles: ${stats.files}\nBy extension:\n${Object.entries(
              stats.byExtension,
            )
              .map(([ext, count]) => `  ${ext}: ${count}`)
              .join("\n")}`,
            metadata: stats as unknown as Record<string, unknown>,
          };
        } catch (error) {
          return {
            success: false,
            output: `Error counting lines: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },
  ];
}

// Helper functions
function searchFiles(
  dir: string,
  pattern: string,
  exclude: string[],
): string[] {
  const results: string[] = [];
  const regex = new RegExp(pattern.replace(/\*/g, ".*"));

  // Always skip these regardless of the caller's `exclude` list — without
  // this, an agent calling search_files with no exclude recurses into
  // node_modules on every real project and can hang for minutes.
  const ALWAYS_SKIP = ["node_modules", ".git", "dist", "build"];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      if (ALWAYS_SKIP.includes(entry)) continue;

      const fullPath = join(currentDir, entry);
      const relativePath = fullPath.replace(dir, "").replace(/^\//, "");

      // Check exclusions
      if (exclude.some((e) => relativePath.includes(e) || entry === e)) {
        continue;
      }

      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (regex.test(entry)) {
        results.push(fullPath);
      }
    }
  }

  if (existsSync(dir)) {
    walk(dir);
  }

  return results;
}

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

function searchContent(
  dir: string,
  pattern: string,
  filePattern: string,
  caseSensitive: boolean,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
  const fileRegex = new RegExp(filePattern.replace(/\*/g, ".*"));

  function walk(currentDir: string) {
    if (results.length >= maxResults) return;

    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = join(currentDir, entry);

      // Skip common non-code directories
      if (["node_modules", ".git", "dist", "build"].includes(entry)) {
        continue;
      }

      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (fileRegex.test(entry)) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          for (
            let i = 0;
            i < lines.length && results.length < maxResults;
            i++
          ) {
            if (regex.test(lines[i])) {
              results.push({
                file: fullPath,
                line: i + 1,
                content: lines[i].trim().slice(0, 200),
              });
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }
  }

  if (existsSync(dir)) {
    walk(dir);
  }

  return results;
}

/**
 * Grep-style search over a single file or a directory tree — the `grep`
 * tool's implementation. Pure JS (no shelling out to a real `grep`
 * binary), so a malicious pattern/path can never do anything beyond what
 * a RegExp/file read can do. Returns pre-formatted "file:line: content"
 * lines (with `-` separators for context lines), same shape grep itself
 * produces with `-C`.
 */
function grepSearch(
  pattern: string,
  targetPath: string,
  options: { recursive: boolean; caseSensitive: boolean; context?: number },
): string[] {
  const regex = new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  const contextSize = options.context ?? 0;
  const output: string[] = [];

  function searchFile(filePath: string) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return; // unreadable/binary file — skip, matching grep's behavior
    }
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;

      const start = Math.max(0, i - contextSize);
      const end = Math.min(lines.length - 1, i + contextSize);
      for (let j = start; j <= end; j++) {
        const marker = j === i ? ":" : "-";
        output.push(`${filePath}${marker}${j + 1}${marker} ${lines[j]}`);
      }
      if (contextSize > 0 && end < lines.length - 1) {
        output.push("--");
      }
    }
  }

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "build"].includes(entry)) continue;
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        if (options.recursive) walk(fullPath);
      } else {
        searchFile(fullPath);
      }
    }
  }

  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    walk(targetPath);
  } else {
    searchFile(targetPath);
  }

  return output;
}

interface ImportInfo {
  type: "import" | "require" | "dynamic";
  module: string;
  names?: string[];
}

function analyzeImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // ES imports
  const importRegex =
    /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({ type: "import", module: match[1] });
  }

  // CommonJS requires
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push({ type: "require", module: match[1] });
  }

  return imports;
}

interface ExportInfo {
  type: "named" | "default" | "all";
  name: string;
}

function analyzeExports(content: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // Named exports
  const namedRegex = /export\s+(?:const|let|var|function|class)\s+(\w+)/g;
  let match;
  while ((match = namedRegex.exec(content)) !== null) {
    exports.push({ type: "named", name: match[1] });
  }

  // Default exports
  const defaultRegex = /export\s+default\s+(?:\w+)?/g;
  if (defaultRegex.test(content)) {
    exports.push({ type: "default", name: "default" });
  }

  // Export all
  const allRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = allRegex.exec(content)) !== null) {
    exports.push({ type: "all", name: match[1] });
  }

  return exports;
}

interface LineStats {
  total: number;
  files: number;
  byExtension: Record<string, number>;
}

function countLines(
  dir: string,
  extensions: string[],
  exclude: string[],
): LineStats {
  const stats: LineStats = {
    total: 0,
    files: 0,
    byExtension: {},
  };

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);

      // Check exclusions
      if (exclude.some((e) => fullPath.includes(e) || entry === e)) {
        continue;
      }

      const stats_entry = statSync(fullPath);

      if (stats_entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = extname(entry);
        if (extensions.includes(ext)) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split("\n").length;

            stats.total += lines;
            stats.files++;
            stats.byExtension[ext] = (stats.byExtension[ext] ?? 0) + lines;
          } catch {
            // Skip files that can't be read
          }
        }
      }
    }
  }

  if (existsSync(dir)) {
    walk(dir);
  }

  return stats;
}
