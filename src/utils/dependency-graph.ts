/**
 * AST & Import Dependency Graph Analyzer
 * Scans codebase files and resolves module imports/exports to track reverse dependencies.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, extname } from "path";

export interface DependencyNode {
  filePath: string;
  imports: string[];
  importedBy: string[];
}

export class DependencyGraph {
  private nodes: Map<string, DependencyNode> = new Map();
  private rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? process.cwd();
  }

  /**
   * Scan project directory and build dependency graph
   */
  public buildGraph(targetDir?: string): void {
    const dir = targetDir ?? join(this.rootDir, "src");
    if (!existsSync(dir)) return;

    const files = this.scanFiles(dir);
    this.nodes.clear();

    // Initialize nodes
    for (const file of files) {
      this.nodes.set(file, {
        filePath: file,
        imports: [],
        importedBy: [],
      });
    }

    // Extract imports for each file
    for (const file of files) {
      const imports = this.extractImports(file);
      const node = this.nodes.get(file)!;

      for (const rawImport of imports) {
        const resolved = this.resolveImportPath(file, rawImport);
        if (resolved && this.nodes.has(resolved)) {
          node.imports.push(resolved);
          this.nodes.get(resolved)!.importedBy.push(file);
        }
      }
    }
  }

  /**
   * Discard the built graph so the next getDependentFiles() call triggers
   * a fresh scan. getDependentFiles() only builds once (lazily, when
   * empty) and never rebuilds on its own — call sites that mutate the
   * filesystem between calls (e.g. file_write, right before checking
   * dependents of the file it just wrote) must invalidate first, or
   * every call after the first silently reports dependents from a
   * pre-edit snapshot of the tree.
   */
  public invalidate(): void {
    this.nodes.clear();
  }

  /**
   * Get all files that import the target file directly or indirectly
   */
  public getDependentFiles(targetFile: string): string[] {
    const absPath = resolve(targetFile);
    if (this.nodes.size === 0) {
      this.buildGraph();
    }

    const dependents = new Set<string>();
    const queue = [absPath];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.nodes.get(current);
      if (!node) continue;

      for (const parent of node.importedBy) {
        if (!dependents.has(parent)) {
          dependents.add(parent);
          queue.push(parent);
        }
      }
    }

    return Array.from(dependents);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private scanFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          results.push(...this.scanFiles(fullPath));
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }

  private extractImports(filePath: string): string[] {
    try {
      const content = readFileSync(filePath, "utf-8");
      const importRegex =
        /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
      const imports: string[] = [];

      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const path = match[1] || match[2];
        if (path && (path.startsWith(".") || path.startsWith("/"))) {
          imports.push(path);
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

  private resolveImportPath(
    sourceFile: string,
    relativeImport: string,
  ): string | null {
    const baseDir = dirname(sourceFile);
    const candidate = resolve(baseDir, relativeImport);

    // If import ends with .js, try replacing with .ts / .tsx first
    if (candidate.endsWith(".js")) {
      const tsPath = candidate.slice(0, -3) + ".ts";
      if (existsSync(tsPath) && statSync(tsPath).isFile()) {
        return tsPath;
      }
      const tsxPath = candidate.slice(0, -3) + ".tsx";
      if (existsSync(tsxPath) && statSync(tsxPath).isFile()) {
        return tsxPath;
      }
    }

    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
    for (const ext of extensions) {
      const fullPath = candidate + ext;
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        return fullPath;
      }
    }

    return null;
  }
}

let graphInstance: DependencyGraph | null = null;

export function getDependencyGraph(rootDir?: string): DependencyGraph {
  if (!graphInstance) {
    graphInstance = new DependencyGraph(rootDir);
  }
  return graphInstance;
}
