/**
 * Tests for Context Epoch: the baseline system prompt is built once from
 * base prompt + environment sources (date, git status, CLAUDE.md), and
 * drift is surfaced as a small delta rather than a full rebuild.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createContextEpoch,
  checkContextDrift,
} from "../../src/core/agents/ContextEpoch.js";

function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

describe("ContextEpoch", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("includes today's date and git status in the baseline prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);

    const epoch = await createContextEpoch("Base prompt.", dir);
    expect(epoch.baselineSystemPrompt).toContain("Base prompt.");
    expect(epoch.baselineSystemPrompt).toContain("Current date:");
    expect(epoch.baselineSystemPrompt).toContain("Git status: clean");
  });

  it("reads and includes CLAUDE.md when present", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "Always use TypeScript.");

    const epoch = await createContextEpoch("Base prompt.", dir);
    expect(epoch.baselineSystemPrompt).toContain("Always use TypeScript.");
  });

  it("omits project instructions entirely when there's no CLAUDE.md", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);

    const epoch = await createContextEpoch("Base prompt.", dir);
    expect(epoch.baselineSystemPrompt).not.toContain("Project instructions");
  });

  it("reports no drift when nothing has changed", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);

    const epoch = await createContextEpoch("Base prompt.", dir);
    const drift = await checkContextDrift(epoch, dir);
    expect(drift).toBeNull();
  });

  it("detects git status drift after a file changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);

    const epoch = await createContextEpoch("Base prompt.", dir);
    expect(epoch.sources.gitStatus).toBe("clean");

    writeFileSync(join(dir, "new-file.txt"), "hello");

    const drift = await checkContextDrift(epoch, dir);
    expect(drift).toContain("Git status changed");
    expect(drift).toContain("1 file(s) changed");

    // Epoch's cached sources should now reflect the new state, so a
    // second check with no further changes reports no drift.
    const secondCheck = await checkContextDrift(epoch, dir);
    expect(secondCheck).toBeNull();
  });

  it("does not crash and reports git status as unavailable outside a git repo", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    // Deliberately no `git init`.

    const epoch = await createContextEpoch("Base prompt.", dir);
    expect(epoch.sources.gitStatus).toBe("unavailable");
    expect(epoch.baselineSystemPrompt).toContain("Git status: unavailable");
  });

  it("never rebuilds the baseline prompt string on drift — only returns a delta to append", async () => {
    dir = mkdtempSync(join(tmpdir(), "epoch-test-"));
    initGitRepo(dir);

    const epoch = await createContextEpoch("Base prompt.", dir);
    const originalBaseline = epoch.baselineSystemPrompt;

    writeFileSync(join(dir, "another-file.txt"), "hi");
    await checkContextDrift(epoch, dir);

    expect(epoch.baselineSystemPrompt).toBe(originalBaseline);
  });
});
