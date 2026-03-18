/**
 * Diff Merge - Unified diff generation and file merge utility
 */

import { diffLines, createTwoFilesPatch } from "diff";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { glob } from "glob";
import { join, dirname } from "path";

export interface FileDiff {
  path: string;
  outputPath: string;
  sourcePath: string;
  additions: number;
  deletions: number;
  unified: string;
  isNew: boolean;
}

export async function generateUnifiedDiff(
  outputDir: string,
  sourceDir: string,
): Promise<FileDiff[]> {
  const outputFiles = await glob("**/*", { cwd: outputDir, nodir: true });
  const diffs: FileDiff[] = [];

  for (const relPath of outputFiles) {
    if (relPath.startsWith(".tasks/") || relPath.endsWith(".task.json"))
      continue;

    const outputPath = join(outputDir, relPath);
    const sourcePath = join(sourceDir, relPath);
    const outputContent = readFileSync(outputPath, "utf-8");
    const sourceContent = existsSync(sourcePath)
      ? readFileSync(sourcePath, "utf-8")
      : "";

    const changes = diffLines(sourceContent, outputContent);
    const additions = changes
      .filter((c) => c.added)
      .reduce((sum, c) => sum + (c.count ?? 0), 0);
    const deletions = changes
      .filter((c) => c.removed)
      .reduce((sum, c) => sum + (c.count ?? 0), 0);

    if (additions === 0 && deletions === 0) continue;

    diffs.push({
      path: relPath,
      outputPath,
      sourcePath,
      additions,
      deletions,
      unified: createTwoFilesPatch(
        relPath,
        relPath,
        sourceContent,
        outputContent,
      ),
      isNew: !existsSync(sourcePath),
    });
  }

  return diffs;
}

export async function applyDiff(
  diff: FileDiff,
  sourceDir: string,
): Promise<void> {
  mkdirSync(dirname(diff.sourcePath), { recursive: true });
  const outputContent = readFileSync(diff.outputPath, "utf-8");
  writeFileSync(diff.sourcePath, outputContent);
}

export function generateSimpleDiff(
  sourceContent: string,
  outputContent: string,
  filePath: string,
): { additions: number; deletions: number; diff: string } {
  const changes = diffLines(sourceContent, outputContent);
  const additions = changes
    .filter((c) => c.added)
    .reduce((sum, c) => sum + (c.count ?? 0), 0);
  const deletions = changes
    .filter((c) => c.removed)
    .reduce((sum, c) => sum + (c.count ?? 0), 0);

  return {
    additions,
    deletions,
    diff: createTwoFilesPatch(filePath, filePath, sourceContent, outputContent),
  };
}
