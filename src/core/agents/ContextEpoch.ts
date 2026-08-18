/**
 * Context Epoch - a cached, immutable baseline system prompt per task.
 *
 * Before this, `UniversalAgent` already reused one fixed systemPrompt
 * string for every iteration within a single execute() call (no
 * rebuild-per-turn bug) — but the prompt itself carried no awareness of
 * the environment (date, git status, project instructions), and there was
 * no mechanism to surface environment drift mid-task without rebuilding
 * the whole prompt and invalidating the provider's cached prefix
 * (see ClaudeProvider's cache_control breakpoints).
 *
 * The epoch is built once at task start. If a source changes mid-task
 * (most commonly git status, since the agent's own tool calls can change
 * it), `checkContextDrift` returns a small text delta to append as a
 * system message instead of touching the cached baseline.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";

const execAsync = promisify(exec);

const PROJECT_INSTRUCTIONS_MAX_CHARS = 3000;
const GIT_STATUS_TIMEOUT_MS = 3000;

export interface ContextSourceSnapshot {
  date: string;
  gitStatus: string;
  /** Truncated CLAUDE.md content, if the project has one. Undefined if absent — never re-checked for drift (see checkContextDrift). */
  projectInstructions?: string;
}

export interface ContextEpoch {
  epochId: string;
  baselineSystemPrompt: string;
  sources: ContextSourceSnapshot;
  createdAt: Date;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readGitStatusSummary(cwd: string): Promise<string> {
  try {
    const { stdout } = await Promise.race([
      execAsync("git status --porcelain", { cwd }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), GIT_STATUS_TIMEOUT_MS),
      ),
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return "clean";
    const fileCount = trimmed.split("\n").length;
    return `${fileCount} file(s) changed`;
  } catch {
    // Not a git repo, git not installed, or the command timed out — none
    // of these should ever block or fail task execution.
    return "unavailable";
  }
}

function readProjectInstructions(cwd: string): string | undefined {
  const path = join(cwd, "CLAUDE.md");
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf-8");
    return content.length > PROJECT_INSTRUCTIONS_MAX_CHARS
      ? content.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS) +
          "\n...[truncated]"
      : content;
  } catch {
    return undefined;
  }
}

export async function captureContextSources(
  cwd: string,
): Promise<ContextSourceSnapshot> {
  const [gitStatus] = await Promise.all([readGitStatusSummary(cwd)]);
  return {
    date: todayDateString(),
    gitStatus,
    projectInstructions: readProjectInstructions(cwd),
  };
}

function renderSourcesBlock(sources: ContextSourceSnapshot): string {
  const parts = [
    `Current date: ${sources.date}`,
    `Git status: ${sources.gitStatus}`,
  ];
  if (sources.projectInstructions) {
    parts.push(`Project instructions (CLAUDE.md):\n${sources.projectInstructions}`);
  }
  return parts.join("\n\n");
}

/**
 * Builds a new epoch: the given base system prompt (mode + skill
 * instructions, see UniversalAgent.buildTaskSystemPrompt) plus a rendered
 * snapshot of environment sources. The returned baselineSystemPrompt
 * should be reused verbatim for every LLM call within the task — never
 * regenerated mid-task, or the provider's prompt cache is defeated.
 */
export async function createContextEpoch(
  baseSystemPrompt: string,
  cwd: string,
): Promise<ContextEpoch> {
  const sources = await captureContextSources(cwd);
  return {
    epochId: uuid(),
    baselineSystemPrompt: `${baseSystemPrompt}\n\n${renderSourcesBlock(sources)}`,
    sources,
    createdAt: new Date(),
  };
}

/**
 * Re-reads drift-prone sources (date, git status — NOT project
 * instructions, which are assumed stable within a task and would cost a
 * file read every iteration to re-check) and, if anything changed, returns
 * a short text delta to append as a system message. Returns null if
 * nothing changed. Mutates `epoch.sources` on drift so the next check
 * compares against the new values rather than repeating the same delta
 * forever.
 */
export async function checkContextDrift(
  epoch: ContextEpoch,
  cwd: string,
): Promise<string | null> {
  const date = todayDateString();
  const gitStatus = await readGitStatusSummary(cwd);

  const changes: string[] = [];
  if (date !== epoch.sources.date) {
    changes.push(`Date changed to ${date}.`);
  }
  if (gitStatus !== epoch.sources.gitStatus) {
    changes.push(`Git status changed: ${gitStatus}.`);
  }

  if (changes.length === 0) return null;

  epoch.sources = { ...epoch.sources, date, gitStatus };
  return `[Environment update] ${changes.join(" ")}`;
}
