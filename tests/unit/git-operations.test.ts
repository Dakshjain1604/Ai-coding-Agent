/**
 * Tests for git-operations.ts's six tools (git_branch/git_checkout/
 * git_reset/git_remote/git_push/git_pull) — previously fully implemented
 * but never registered anywhere (createGitTools() had zero call sites),
 * so the agent had no way to create/switch branches, push, pull, or
 * reset at all. Wired up this phase, and rewritten from shell-string
 * interpolation to execFile() with argv arrays along the way — the
 * original versions were exploitable via the exact same class of bug
 * fixed in builtin.ts's git tools (see git-tools-security.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { createGitTools } from "../../src/core/tools/git-operations.js";

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

function currentBranch(dir: string): string {
  return execFileSync("git", ["-C", dir, "branch", "--show-current"]).toString().trim();
}

function canaryPath(dir: string, label: string): string {
  return join(dir, `PWNED_${label}_${Math.random().toString(36).slice(2)}`);
}

function injectionPayload(canary: string): string {
  return `x\`touch ${canary}\`$(touch ${canary}); touch ${canary}`;
}

function getTool(name: string) {
  const tool = createGitTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("git_branch", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists branches (default, no create/delete)", async () => {
    const result = await getTool("git_branch").handler({ path: dir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("main");
  });

  it("creates a branch without checking out by default", async () => {
    const result = await getTool("git_branch").handler({ path: dir, create: "feature-a" });
    expect(result.success).toBe(true);
    expect(currentBranch(dir)).toBe("main");

    const list = await getTool("git_branch").handler({ path: dir });
    expect(list.output).toContain("feature-a");
  });

  it("creates and checks out a branch when checkout:true", async () => {
    const result = await getTool("git_branch").handler({
      path: dir,
      create: "feature-b",
      checkout: true,
    });
    expect(result.success).toBe(true);
    expect(currentBranch(dir)).toBe("feature-b");
  });

  it("deletes a fully-merged branch with the safe -d flag", async () => {
    execFileSync("git", ["-C", dir, "branch", "throwaway"]);
    const result = await getTool("git_branch").handler({ path: dir, delete: "throwaway" });
    expect(result.success).toBe(true);

    const list = await getTool("git_branch").handler({ path: dir });
    expect(list.output).not.toContain("throwaway");
  });

  it("refuses to delete an unmerged branch (safe -d, not force -D)", async () => {
    execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "unmerged"]);
    writeFileSync(join(dir, "new.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "new.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "unmerged commit"]);
    execFileSync("git", ["-C", dir, "checkout", "-q", "main"]);

    const result = await getTool("git_branch").handler({ path: dir, delete: "unmerged" });
    expect(result.success).toBe(false);

    const list = await getTool("git_branch").handler({ path: dir });
    expect(list.output).toContain("unmerged");
  });

  it("never executes shell metacharacters embedded in the branch name", async () => {
    const canary = canaryPath(dir, "BRANCH_CREATE");
    const result = await getTool("git_branch").handler({
      path: dir,
      create: injectionPayload(canary),
    });
    expect(result.success).toBe(false); // not a legal git branch name
    expect(existsSync(canary)).toBe(false);
  });
});

describe("git_checkout", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    initRepo(dir);
    execFileSync("git", ["-C", dir, "branch", "other"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks out an existing branch", async () => {
    const result = await getTool("git_checkout").handler({ path: dir, ref: "other" });
    expect(result.success).toBe(true);
    expect(currentBranch(dir)).toBe("other");
  });

  it("fails cleanly for a nonexistent ref", async () => {
    const result = await getTool("git_checkout").handler({ path: dir, ref: "does-not-exist" });
    expect(result.success).toBe(false);
  });

  it("never executes shell metacharacters embedded in the ref", async () => {
    const canary = canaryPath(dir, "CHECKOUT");
    const result = await getTool("git_checkout").handler({
      path: dir,
      ref: injectionPayload(canary),
    });
    expect(result.success).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });
});

describe("git_reset", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to mixed mode against HEAD", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    const result = await getTool("git_reset").handler({ path: dir });
    expect(result.success).toBe(true);

    // mixed reset unstages but keeps the working-tree file.
    expect(existsSync(join(dir, "f.txt"))).toBe(true);
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
    expect(status).toContain("?? f.txt");
  });

  it("--hard discards tracked working-tree changes", async () => {
    writeFileSync(join(dir, "tracked.txt"), "original");
    execFileSync("git", ["-C", dir, "add", "tracked.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "add tracked"]);
    writeFileSync(join(dir, "tracked.txt"), "modified");

    const result = await getTool("git_reset").handler({ path: dir, mode: "hard" });
    expect(result.success).toBe(true);

    const content = readFileSync(join(dir, "tracked.txt"), "utf-8");
    expect(content).toBe("original");
  });

  it("--soft keeps changes staged", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "commit f"]);

    const result = await getTool("git_reset").handler({ path: dir, mode: "soft", ref: "HEAD~1" });
    expect(result.success).toBe(true);

    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
    expect(status).toContain("A  f.txt");
  });

  it("never executes shell metacharacters embedded in the ref", async () => {
    const canary = canaryPath(dir, "RESET");
    const result = await getTool("git_reset").handler({
      path: dir,
      ref: injectionPayload(canary),
    });
    expect(result.success).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });
});

describe("git_remote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists remotes (empty for a fresh repo)", async () => {
    const result = await getTool("git_remote").handler({ path: dir, action: "list" });
    expect(result.success).toBe(true);
  });

  it("adds and then lists a remote", async () => {
    const add = await getTool("git_remote").handler({
      path: dir,
      action: "add",
      name: "origin",
      url: "https://example.com/repo.git",
    });
    expect(add.success).toBe(true);

    const list = await getTool("git_remote").handler({ path: dir, action: "list" });
    expect(list.output).toContain("origin");
    expect(list.output).toContain("https://example.com/repo.git");
  });

  it("removes a remote", async () => {
    await getTool("git_remote").handler({
      path: dir,
      action: "add",
      name: "origin",
      url: "https://example.com/repo.git",
    });
    const remove = await getTool("git_remote").handler({
      path: dir,
      action: "remove",
      name: "origin",
    });
    expect(remove.success).toBe(true);

    const list = await getTool("git_remote").handler({ path: dir, action: "list" });
    expect(list.output).not.toContain("origin");
  });

  it("rejects add without a url, without ever invoking git", async () => {
    const result = await getTool("git_remote").handler({
      path: dir,
      action: "add",
      name: "origin",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("url");
  });

  it("rejects an unknown action", async () => {
    const result = await getTool("git_remote").handler({ path: dir, action: "explode" });
    expect(result.success).toBe(false);
  });

  it("never executes shell metacharacters embedded in the remote url — stores it as literal text instead", async () => {
    const canary = canaryPath(dir, "REMOTE_URL");
    const url = `https://example.com/repo.git; touch ${canary}`;
    const add = await getTool("git_remote").handler({
      path: dir,
      action: "add",
      name: "origin",
      url,
    });
    expect(add.success).toBe(true);
    expect(existsSync(canary)).toBe(false);

    const list = await getTool("git_remote").handler({ path: dir, action: "list" });
    expect(list.output).toContain(url);
  });
});

describe("git_push / git_pull — against a real local bare remote", () => {
  let dir: string;
  let bareDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ops-test-"));
    bareDir = mkdtempSync(join(tmpdir(), "git-ops-bare-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareDir]);
    initRepo(dir);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", bareDir]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  it("pushes real commits to the remote", async () => {
    const result = await getTool("git_push").handler({
      path: dir,
      remote: "origin",
      branch: "main",
    });
    expect(result.success).toBe(true);

    const remoteLog = execFileSync("git", ["--git-dir", bareDir, "log", "-1", "--format=%s"]);
    expect(remoteLog.toString().trim()).toBe("init");
  });

  it("pulls real commits from the remote into a fresh clone", async () => {
    await getTool("git_push").handler({ path: dir, remote: "origin", branch: "main" });

    const cloneDir = mkdtempSync(join(tmpdir(), "git-ops-clone-"));
    try {
      execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
      execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "second commit"]);
      await getTool("git_push").handler({ path: dir, remote: "origin", branch: "main" });

      const result = await getTool("git_pull").handler({
        path: cloneDir,
        remote: "origin",
        branch: "main",
      });
      expect(result.success).toBe(true);

      const log = execFileSync("git", ["-C", cloneDir, "log", "-1", "--format=%s"]);
      expect(log.toString().trim()).toBe("second commit");
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("never executes shell metacharacters embedded in the branch name (push)", async () => {
    const canary = canaryPath(dir, "PUSH_BRANCH");
    const result = await getTool("git_push").handler({
      path: dir,
      remote: "origin",
      branch: injectionPayload(canary),
    });
    expect(result.success).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });

  it("never executes shell metacharacters embedded in the remote name (pull)", async () => {
    const canary = canaryPath(dir, "PULL_REMOTE");
    const result = await getTool("git_pull").handler({
      path: dir,
      remote: injectionPayload(canary),
    });
    expect(result.success).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });

  it("force-push flag actually adds --force to the real git invocation (diverged history succeeds)", async () => {
    await getTool("git_push").handler({ path: dir, remote: "origin", branch: "main" });

    // Create diverged history on the clone-equivalent by resetting local
    // history and committing something different, so a normal push would
    // be rejected (non-fast-forward) and only --force succeeds.
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "diverge A"]);
    await getTool("git_push").handler({ path: dir, remote: "origin", branch: "main" });

    execFileSync("git", ["-C", dir, "reset", "-q", "--hard", "HEAD~1"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "diverge B"]);

    const nonForce = await getTool("git_push").handler({ path: dir, remote: "origin", branch: "main" });
    expect(nonForce.success).toBe(false);

    const forced = await getTool("git_push").handler({
      path: dir,
      remote: "origin",
      branch: "main",
      force: true,
    });
    expect(forced.success).toBe(true);

    const remoteLog = execFileSync("git", ["--git-dir", bareDir, "log", "-1", "--format=%s"]);
    expect(remoteLog.toString().trim()).toBe("diverge B");
  });
});
