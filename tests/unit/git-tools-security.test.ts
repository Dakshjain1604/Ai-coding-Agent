/**
 * Tests for the command-injection fix across builtin.ts's git/shell-
 * adjacent tools (gitLog/gitAdd/gitCommit/gitDiff/shellWhich/processList/
 * logsRead/testRun). Every one of these used to build a shell command
 * string via naive interpolation (execAsync runs through `/bin/sh -c`),
 * so a value containing backticks/`$(...)`/`;`/`&&`/`|` executed as its
 * own command regardless of quoting.
 *
 * Confirmed exploitable pre-fix with a live PoC: gitCommit.handler({
 * message: "pwned`touch /tmp/PWNED`" }) created a real file on disk.
 * Every "injection attempt" test below is that same PoC pattern — a
 * canary file path embedded in a parameter, then asserting the canary
 * was NOT created — not a weaker "looks escaped" string check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  gitStatus,
  gitLog,
  gitAdd,
  gitCommit,
  gitDiff,
  shellWhich,
  processList,
  logsRead,
} from "../../src/core/tools/builtin.js";

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

/** A canary path unique per test — asserted to NOT exist afterward. */
function canaryPath(dir: string, label: string): string {
  return join(dir, `PWNED_${label}_${Math.random().toString(36).slice(2)}`);
}

function injectionPayload(canary: string): string {
  return `x\`touch ${canary}\`$(touch ${canary}); touch ${canary}`;
}

describe("gitCommit — injection resistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in the commit message", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);

    const canary = canaryPath(dir, "COMMIT");
    const result = await gitCommit.handler({
      cwd: dir,
      message: injectionPayload(canary),
    });

    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("stores the malicious-looking message as the LITERAL commit message", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);

    const message = "pwned`echo x`";
    await gitCommit.handler({ cwd: dir, message });

    const log = execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], {
      cwd: dir,
    }).toString();
    expect(log.trim()).toBe(message);
  });

  it("still creates a real commit for a normal message", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);

    const result = await gitCommit.handler({ cwd: dir, message: "a normal commit" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("a normal commit");
  });

  it("handles a commit message containing newlines safely (multi-line, not multiple commands)", async () => {
    writeFileSync(join(dir, "f.txt"), "content");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);

    const canary = canaryPath(dir, "COMMIT_NEWLINE");
    const message = `line one\ntouch ${canary}\nline three`;
    const result = await gitCommit.handler({ cwd: dir, message });

    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });
});

describe("gitAdd — injection resistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in a file name", async () => {
    const canary = canaryPath(dir, "ADD");
    const result = await gitAdd.handler({
      cwd: dir,
      files: [injectionPayload(canary)],
    });

    // The bogus "file" doesn't exist, so git itself reports failure —
    // the important thing is the canary was never created.
    expect(result.success).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });

  it("stages a real file correctly", async () => {
    writeFileSync(join(dir, "real.txt"), "content");
    const result = await gitAdd.handler({ cwd: dir, files: ["real.txt"] });
    expect(result.success).toBe(true);

    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString();
    expect(status).toContain("real.txt");
  });

  it("stages multiple real files at once", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    const result = await gitAdd.handler({ cwd: dir, files: ["a.txt", "b.txt"] });
    expect(result.success).toBe(true);
    expect(result.output).toContain("2 file(s)");
  });
});

describe("gitLog — injection resistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in the file filter", async () => {
    const canary = canaryPath(dir, "LOG");
    const result = await gitLog.handler({ cwd: dir, file: injectionPayload(canary) });

    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("still lists real commit history", async () => {
    const result = await gitLog.handler({ cwd: dir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("init");
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", `c${i}`]);
    }
    const result = await gitLog.handler({ cwd: dir, limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output.trim().split("\n").length).toBe(2);
  });
});

describe("gitDiff — injection resistance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    initRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in the file filter", async () => {
    const canary = canaryPath(dir, "DIFF");
    const result = await gitDiff.handler({ cwd: dir, file: injectionPayload(canary) });

    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("still shows a real diff for a modified file", async () => {
    writeFileSync(join(dir, "f.txt"), "v1");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "add f"]);
    writeFileSync(join(dir, "f.txt"), "v2");

    const result = await gitDiff.handler({ cwd: dir });
    expect(result.success).toBe(true);
    expect(result.output).toContain("v2");
  });
});

describe("gitStatus — unaffected (was already safe, no interpolation)", () => {
  it("reports a clean working tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    initRepo(dir);
    try {
      const result = await gitStatus.handler({ cwd: dir });
      expect(result.success).toBe(true);
      expect(result.output).toContain("clean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shellWhich — injection resistance", () => {
  it("never executes shell metacharacters embedded in the executable name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    const canary = canaryPath(dir, "WHICH");
    try {
      const result = await shellWhich.handler({ name: injectionPayload(canary) });
      expect(result.success).toBe(false);
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still finds a real executable on PATH", async () => {
    const result = await shellWhich.handler({ name: "node" });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });
});

describe("processList — injection resistance", () => {
  it("never executes shell metacharacters embedded in the filter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    const canary = canaryPath(dir, "PSFILTER");
    try {
      const result = await processList.handler({ filter: injectionPayload(canary) });
      expect(result.success).toBe(true);
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns process listing output without a filter", async () => {
    const result = await processList.handler({});
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("filters case-insensitively in JS rather than shelling out to grep", async () => {
    const result = await processList.handler({ filter: "NODE" });
    expect(result.success).toBe(true);
    // Every returned line must actually contain the filter text.
    for (const line of result.output.split("\n").filter(Boolean)) {
      expect(line.toLowerCase()).toContain("node");
    }
  });
});

describe("logsRead — injection resistance", () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-sec-test-"));
    logFile = join(dir, "app.log");
    writeFileSync(logFile, "line1\nline2 ERROR\nline3\nline4 ERROR\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never executes shell metacharacters embedded in the path", async () => {
    const canary = canaryPath(dir, "LOGPATH");
    const result = await logsRead.handler({
      path: `${logFile}; touch ${canary}`,
      lines: 10,
    });
    expect(result.success).toBe(false); // bogus combined path doesn't exist
    expect(existsSync(canary)).toBe(false);
  });

  it("never executes shell metacharacters embedded in the filter", async () => {
    const canary = canaryPath(dir, "LOGFILTER");
    const result = await logsRead.handler({
      path: logFile,
      filter: `ERROR; touch ${canary}`,
    });
    // A regex containing ";" is valid (matches a literal semicolon) — the
    // call succeeds, it just won't match anything in this log file.
    expect(result.success).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("still reads a real log file's tail", async () => {
    const result = await logsRead.handler({ path: logFile, lines: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("line3\nline4 ERROR");
  });

  it("still filters by a real regex pattern", async () => {
    const result = await logsRead.handler({ path: logFile, filter: "ERROR" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("line2 ERROR");
    expect(result.output).toContain("line4 ERROR");
    expect(result.output).not.toContain("line1");
  });

  it("fails gracefully (not throw) on an invalid regex filter", async () => {
    const result = await logsRead.handler({ path: logFile, filter: "(unclosed" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid filter pattern");
  });

  it("fails cleanly for a nonexistent log file", async () => {
    const result = await logsRead.handler({ path: join(dir, "nope.log") });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("drops the phantom trailing blank line caused by the file's trailing newline", async () => {
    // logFile ends with "\n", so a naive split("\n") produces one trailing
    // "" element — without stripping it, `lines: N` would return the last
    // N-1 real lines plus a blank one, one short of real `tail` behavior.
    const result = await logsRead.handler({ path: logFile, lines: 100 });
    expect(result.output).toBe("line1\nline2 ERROR\nline3\nline4 ERROR");
    expect(result.output.endsWith("\n")).toBe(false);
  });

  it("requesting more lines than the file has returns the whole file", async () => {
    const result = await logsRead.handler({ path: logFile, lines: 1000 });
    expect(result.output.split("\n").length).toBe(4);
  });
});
