/**
 * Git Diff Preview & One-Click Rollback Manager
 * Provides file snapshotting, color diff generation, and instant rollback on execution errors.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import chalk from "chalk";

export interface FileSnapshot {
  filePath: string;
  content: string;
  timestamp: Date;
}

export class RollbackManager {
  private snapshots: Map<string, FileSnapshot[]> = new Map();

  /**
   * Take a snapshot of a file before modification
   */
  public snapshot(filePath: string): void {
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      const history = this.snapshots.get(filePath) ?? [];
      history.push({
        filePath,
        content,
        timestamp: new Date(),
      });
      this.snapshots.set(filePath, history);
    } catch {
      // Snapshot non-critical
    }
  }

  /**
   * Rollback file to its last pre-edit snapshot
   */
  public rollback(filePath: string): boolean {
    const history = this.snapshots.get(filePath);
    if (!history || history.length === 0) return false;

    const last = history.pop()!;
    try {
      writeFileSync(filePath, last.content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate a colored diff preview string between old and new content
   */
  public generateDiffPreview(
    filename: string,
    oldContent: string,
    newContent: string,
  ): string {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const lines: string[] = [chalk.bold(`--- a/${filename}`), chalk.bold(`+++ b/${filename}`)];

    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine !== newLine) {
        if (oldLine !== undefined) {
          lines.push(chalk.red(`- ${oldLine}`));
        }
        if (newLine !== undefined) {
          lines.push(chalk.green(`+ ${newLine}`));
        }
      }
    }

    return lines.join("\n");
  }
}

let rollbackManagerInstance: RollbackManager | null = null;

export function getRollbackManager(): RollbackManager {
  if (!rollbackManagerInstance) {
    rollbackManagerInstance = new RollbackManager();
  }
  return rollbackManagerInstance;
}
