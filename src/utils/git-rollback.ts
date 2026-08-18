/**
 * Rollback Manager - snapshot-before-write safety net for file mutations.
 *
 * Real gap this closes: file_write/file_delete/file_move operate directly
 * on the real project tree by default (buildTaskSystemPrompt falls back to
 * process.cwd() as the output directory whenever task.metadata.outputDir
 * isn't set — which is every real call site today, despite the
 * "sandbox-safe" design principle in CLAUDE.md). A single bad completion
 * can silently overwrite or delete uncommitted work with no recovery path
 * — this class existed already but had zero call sites anywhere.
 *
 * Snapshots are kept both in-memory (bounded per file) AND persisted to
 * disk as a single latest-backup-per-file. The disk copy matters because
 * most real invocations of this CLI are a single short-lived process —
 * an in-memory-only snapshot would already be gone by the time anyone
 * could ask to undo it.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import chalk from "chalk";

export interface FileSnapshot {
  filePath: string;
  content: string;
  timestamp: Date;
}

/** Caps in-memory history per file so a long session repeatedly touching
 * the same file doesn't grow this unboundedly. */
const MAX_SNAPSHOTS_PER_FILE = 5;

function backupFileNameFor(filePath: string): string {
  return `${createHash("sha256").update(filePath).digest("hex").slice(0, 16)}.json`;
}

export class RollbackManager {
  private snapshots: Map<string, FileSnapshot[]> = new Map();
  private readonly backupDir: string;
  private readonly projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
    this.backupDir = join(this.projectRoot, ".claude", "rollback-backups");
  }

  /**
   * Normalizes a caller-supplied path to an absolute, canonical form before
   * it's used as a snapshot key or hashed into a backup filename. Without
   * this, two calls for the "same" file that happen to pass different
   * string forms (relative vs. absolute) silently miss each other — hash
   * is computed over the literal string, not the file it resolves to.
   * Confirmed live: applyDiff() (apply.ts) snapshots using an ABSOLUTE
   * path (diff.sourcePath), while the `rollback` CLI command looks paths
   * up using whatever string the user types — typically the RELATIVE path
   * apply's own output just showed them. hasBackup()/rollback() on that
   * relative path silently reported "no backup found" even though one
   * genuinely existed on disk, keyed under the absolute path's hash.
   */
  private normalize(filePath: string): string {
    return resolve(this.projectRoot, filePath);
  }

  /**
   * Take a snapshot of a file before modification. No-op for files that
   * don't exist yet — there's nothing to lose by creating a new file.
   */
  public snapshot(filePath: string): void {
    filePath = this.normalize(filePath);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      const entry: FileSnapshot = { filePath, content, timestamp: new Date() };

      const history = this.snapshots.get(filePath) ?? [];
      history.push(entry);
      if (history.length > MAX_SNAPSHOTS_PER_FILE) history.shift();
      this.snapshots.set(filePath, history);

      this.persistToDisk(entry);
    } catch {
      // Snapshot is a safety net, never the primary path — a failure here
      // must never block (or fail) the write it's protecting.
    }
  }

  private persistToDisk(entry: FileSnapshot): void {
    try {
      if (!existsSync(this.backupDir)) {
        mkdirSync(this.backupDir, { recursive: true });
      }
      writeFileSync(
        join(this.backupDir, backupFileNameFor(entry.filePath)),
        JSON.stringify(entry, null, 2),
        "utf-8",
      );
    } catch {
      // Best-effort — the in-memory snapshot (if any) still works this run.
    }
  }

  private readFromDisk(filePath: string): FileSnapshot | undefined {
    try {
      const path = join(this.backupDir, backupFileNameFor(filePath));
      if (!existsSync(path)) return undefined;
      const raw = JSON.parse(readFileSync(path, "utf-8")) as FileSnapshot;
      return raw;
    } catch {
      return undefined;
    }
  }

  /**
   * Rollback file to its last pre-edit snapshot. Prefers the in-memory
   * history (same-process undo, e.g. an agent self-correcting mid-task);
   * falls back to the on-disk backup when there's no in-memory history —
   * the common case for a fresh CLI invocation restoring after a prior run.
   */
  public rollback(filePath: string): boolean {
    filePath = this.normalize(filePath);
    const history = this.snapshots.get(filePath);
    if (history && history.length > 0) {
      const last = history[history.length - 1];
      if (this.writeBack(filePath, last.content)) {
        history.pop();
        return true;
      }
      return false;
    }

    const diskEntry = this.readFromDisk(filePath);
    if (diskEntry) {
      return this.writeBack(filePath, diskEntry.content);
    }
    return false;
  }

  private writeBack(filePath: string, content: string): boolean {
    try {
      writeFileSync(filePath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /** Whether any snapshot (in-memory or on-disk) exists for this file. */
  public hasBackup(filePath: string): boolean {
    filePath = this.normalize(filePath);
    if ((this.snapshots.get(filePath)?.length ?? 0) > 0) return true;
    return existsSync(join(this.backupDir, backupFileNameFor(filePath)));
  }

  /**
   * The content a rollback would restore, without performing it — used to
   * preview what "undo" would do before committing to it.
   */
  public peekBackup(filePath: string): FileSnapshot | undefined {
    filePath = this.normalize(filePath);
    const history = this.snapshots.get(filePath);
    if (history && history.length > 0) return history[history.length - 1];
    return this.readFromDisk(filePath);
  }

  /** Every file path with a recoverable backup, in-memory or on-disk. */
  public listBackedUpFiles(): string[] {
    const paths = new Set<string>();
    for (const [path, history] of this.snapshots) {
      if (history.length > 0) paths.add(path);
    }
    if (existsSync(this.backupDir)) {
      for (const fileName of readdirSync(this.backupDir)) {
        try {
          const raw = JSON.parse(
            readFileSync(join(this.backupDir, fileName), "utf-8"),
          ) as FileSnapshot;
          if (raw.filePath) paths.add(raw.filePath);
        } catch {
          // Skip a corrupt/unreadable backup file rather than failing the
          // whole listing over one bad entry.
        }
      }
    }
    return [...paths].sort();
  }

  /**
   * Generate a colored diff preview string between old and new content.
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

/**
 * `projectRoot` only takes effect the first time this is called (same
 * seed-before-first-use pattern as getMemoryManager()) — lets tests point
 * the singleton at a temp directory before any tool handler touches it,
 * so tests never write into the real project's .claude/rollback-backups.
 */
export function getRollbackManager(projectRoot?: string): RollbackManager {
  if (!rollbackManagerInstance) {
    rollbackManagerInstance = new RollbackManager(projectRoot);
  }
  return rollbackManagerInstance;
}

/** Test-only: force a fresh singleton (e.g. pointed at a temp projectRoot). */
export function resetRollbackManager(): void {
  rollbackManagerInstance = null;
}
