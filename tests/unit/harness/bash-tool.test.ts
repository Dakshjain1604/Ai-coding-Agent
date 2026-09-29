/**
 * BashTool runs real shell processes in a temp directory. Each case pins a
 * failure seen in real runs of the previous agent, or a property the tool's
 * contract promises (see bash.ts header).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool, readHeadTail } from "../../../src/harness/tools/bash.js";
import type { ToolContext } from "../../../src/harness/tools/tool.js";

let workspace: string;
let scratch: string;
let bash: BashTool;
let ctx: ToolContext;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-ws-")));
  scratch = mkdtempSync(join(tmpdir(), "harness-scratch-"));
  bash = new BashTool({ initialCwd: workspace, scratchDir: scratch });
  ctx = { cwd: () => bash.currentDirectory(), startedAt: Date.now(), deadline: Date.now() + 600_000, scratchDir: scratch };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const run = (command: string, extra: Record<string, unknown> = {}) => bash.run({ command, ...extra }, ctx);

describe("BashTool — output and exit codes", () => {
  it("returns exit code 0 and stdout for a successful command", async () => {
    const obs = await run("echo hello");
    expect(obs.ok).toBe(true);
    expect(obs.output).toMatch(/^\[exit code 0 · /);
    expect(obs.output).toContain("hello");
    expect(obs.meta?.exitCode).toBe(0);
  });

  it("keeps stdout of a FAILING command (previous agent returned only stderr/err.message)", async () => {
    const obs = await run("echo 'ERROR: Failed to verify certificate'; exit 1");
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("[exit code 1");
    expect(obs.output).toContain("ERROR: Failed to verify certificate");
  });

  it("merges stdout and stderr in the order they were written", async () => {
    const obs = await run("echo one; echo two >&2; echo three");
    expect(obs.output).toMatch(/one\ntwo\nthree/);
  });

  it("reports (no output) explicitly", async () => {
    const obs = await run("true");
    expect(obs.output).toContain("(no output)");
  });

  it("reports a non-zero exit code from the last command", async () => {
    const obs = await run("ls /definitely/not/here");
    expect(obs.ok).toBe(false);
    expect(obs.meta?.exitCode).not.toBe(0);
    expect(obs.output).toMatch(/No such file/);
  });
});

describe("BashTool — session state", () => {
  it("persists the working directory across calls", async () => {
    await run("mkdir -p sub/dir && cd sub/dir");
    const obs = await run("pwd");
    expect(obs.output).toContain(join(workspace, "sub", "dir"));
    expect(bash.currentDirectory()).toBe(join(workspace, "sub", "dir"));
  });

  it("persists exported variables across calls", async () => {
    await run("export GREETING='hello world'");
    expect((await run("echo \"$GREETING\"")).output).toContain("hello world");
  });

  it("exports PYTHONUNBUFFERED=1 by default so Python output is never block-buffered", async () => {
    const obs = await run("echo PYTHONUNBUFFERED=$PYTHONUNBUFFERED");
    expect(obs.ok).toBe(true);
    expect(obs.output).toContain("PYTHONUNBUFFERED=1");
  });

  it("persists state even when the command calls exit", async () => {
    await run("cd /tmp && export MARK=1 && exit 4");
    const obs = await run("pwd; echo MARK=$MARK");
    expect(obs.output).toMatch(/\/tmp/);
    expect(obs.output).toContain("MARK=1");
  });

  it("ignores inherited env names that are not valid identifiers instead of erroring on every call", async () => {
    process.env["weird-name.with-dashes"] = "x";
    try {
      bash = new BashTool({ initialCwd: workspace, scratchDir: scratch });
      await run("export OK_VAR=1");
      const obs = await run("echo OK_VAR=$OK_VAR");
      expect(obs.output).not.toMatch(/not a valid identifier/);
      expect(obs.output).toContain("OK_VAR=1");
    } finally {
      delete process.env["weird-name.with-dashes"];
    }
  });

  it("restores multi-line exported values intact", async () => {
    await run("export MULTI=\"line one\nline two\"");
    const obs = await run("printf '%s|' \"$MULTI\"");
    expect(obs.output).toContain("line one\nline two|");
  });

  it("handles directories with quotes and spaces", async () => {
    await run(`mkdir -p "it's here" && cd "it's here"`);
    expect(bash.currentDirectory()).toBe(join(workspace, "it's here"));
    expect((await run("pwd")).output).toContain("it's here");
  });

  it("starts in the initial cwd", async () => {
    expect(bash.currentDirectory()).toBe(workspace);
    expect((await run("pwd")).output).toContain(workspace);
  });
});

describe("BashTool — lost session state is reported, not silent", () => {
  it("says when exec replaced the shell, keeping the previous directory", async () => {
    const obs = await run("cd /tmp && exec echo replaced");
    expect(obs.output).toContain("replaced");
    expect(obs.output).toContain("was replaced (exec) or killed before saving its state");
    expect(obs.output).toContain(`the session is still in ${workspace}`);
    expect(obs.meta?.stateSaved).toBe(false);
    expect((await run("pwd")).output).toContain(workspace);
  });

  it("still saves state when a timeout stops the command with SIGTERM", async () => {
    const obs = await run("cd /tmp && sleep 30", { timeout_sec: 1 });
    expect(obs.meta?.timedOut).toBe(true);
    expect(obs.meta?.stateSaved).toBe(true);
    expect(bash.currentDirectory()).toMatch(/\/tmp$/);
  });

  it("says when a command that ignores SIGTERM had to be SIGKILLed before saving state", async () => {
    const obs = await run("trap '' TERM; cd /tmp && sleep 30", { timeout_sec: 1 });
    expect(obs.meta?.timedOut).toBe(true);
    expect(obs.output).toContain("was killed before saving its state");
    expect(obs.meta?.stateSaved).toBe(false);
    expect(bash.currentDirectory()).toBe(workspace);
  });

  it("adds no note when state was saved", async () => {
    const obs = await run("cd /tmp");
    expect(obs.output).not.toContain("[note:");
    expect(obs.meta?.stateSaved).toBe(true);
  });
});

describe("BashTool — never hangs", () => {
  it("kills a command that exceeds its timeout and returns the output so far", async () => {
    const started = Date.now();
    const obs = await run("echo started; sleep 30", { timeout_sec: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(obs.ok).toBe(false);
    expect(obs.meta?.timedOut).toBe(true);
    expect(obs.output).toContain("timed out after 1s");
    expect(obs.output).toContain("started");
  });

  it("caps the timeout at the run's remaining time", async () => {
    ctx = { ...ctx, deadline: Date.now() + 2_000 };
    const obs = await run("sleep 30", { timeout_sec: 600 });
    expect(obs.meta?.timedOut).toBe(true);
    expect(obs.meta?.timeoutSec).toBeLessThanOrEqual(2);
  });

  it("closes stdin so a command waiting for input fails fast", async () => {
    const started = Date.now();
    const obs = await run("read answer; echo got=[$answer]", { timeout_sec: 20 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(obs.output).toContain("got=[]");
  });

  it("returns immediately after starting a background job, which keeps running", async () => {
    const marker = join(workspace, "bg-done");
    const started = Date.now();
    const obs = await run(`(sleep 1; echo late; touch ${marker}) &\necho launched`, { timeout_sec: 20 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(obs.output).toContain("launched");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(existsSync(marker)).toBe(true);
  });
});

describe("BashTool — bounded output", () => {
  it("returns head and tail of huge output with the full-output path", async () => {
    const obs = await run("seq 1 200000");
    expect(obs.output).toContain("\n1\n");
    expect(obs.output).toContain("200000");
    expect(obs.output).toMatch(/bytes omitted/);
    expect(obs.output).toMatch(/Full output: .*output-\d+\.log/);
    expect(obs.output.length).toBeLessThan(40_000);
  });
});

describe("BashTool — environment", () => {
  it("hides the configured env vars (e.g. the harness API key) from commands", async () => {
    process.env.HARNESS_TEST_SECRET = "s3cr3t";
    try {
      bash = new BashTool({ initialCwd: workspace, scratchDir: scratch, hiddenEnv: ["HARNESS_TEST_SECRET"] });
      const obs = await run("echo value=[$HARNESS_TEST_SECRET]");
      expect(obs.output).toContain("value=[]");
    } finally {
      delete process.env.HARNESS_TEST_SECRET;
    }
  });

  it("sets non-interactive defaults", async () => {
    const obs = await run("echo $DEBIAN_FRONTEND $PAGER $GIT_PAGER");
    expect(obs.output).toContain("noninteractive cat cat");
  });

  it("keeps harness files out of the workspace", async () => {
    await run("echo hi > note.txt");
    const obs = await run("ls -A");
    expect(obs.output.trim().split("\n").slice(1)).toEqual(["note.txt"]);
  });
});

describe("readHeadTail", () => {
  it("reads a small file whole", () => {
    const file = join(scratch, "small.txt");
    writeFileSync(file, "abc");
    expect(readHeadTail(file, 10, 10)).toEqual({ text: "abc", totalBytes: 3 });
  });

  it("reads only head and tail of a large file", () => {
    const file = join(scratch, "large.txt");
    writeFileSync(file, "H".repeat(5) + "M".repeat(100) + "T".repeat(5));
    const { text, totalBytes } = readHeadTail(file, 5, 5);
    expect(totalBytes).toBe(110);
    expect(text).toBe("HHHHH\n[... 100 bytes omitted ...]\nTTTTT");
  });

  it("returns empty for a missing file", () => {
    expect(readHeadTail(join(scratch, "missing"), 5, 5)).toEqual({ text: "", totalBytes: 0 });
  });
});
