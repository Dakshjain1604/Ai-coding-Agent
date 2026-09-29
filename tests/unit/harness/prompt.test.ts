/**
 * The system prompt is part of the harness's behavior: it states the
 * environment facts the agent cannot discover for free, and the working
 * method. These tests pin the facts and the guidance that came out of real
 * run traces, not the wording around them.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, scanDirectory } from "../../../src/harness/prompt.js";

const env = {
  cwd: "/app",
  platform: "linux x64",
  shell: "bash",
  date: "2026-09-18",
};

describe("buildSystemPrompt — environment facts", () => {
  it("states the working directory, platform, shell and date", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toContain("/app");
    expect(prompt).toContain("linux x64");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("2026-09-18");
  });

  it("states the time budget in minutes when there is one", () => {
    expect(buildSystemPrompt({ ...env, timeBudgetSec: 900 })).toContain("about 15 minutes");
  });

  it("omits the time budget line when there is none", () => {
    expect(buildSystemPrompt(env)).not.toContain("minutes of wall-clock time");
  });

  it("includes initial directory contents when provided", () => {
    const prompt = buildSystemPrompt({ ...env, initialListing: "src/\n  index.ts\npackage.json" });
    expect(prompt).toContain("- Initial directory contents:\n```\nsrc/\n  index.ts\npackage.json\n```");
  });

  it("omits directory contents when initialListing is absent", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).not.toContain("Initial directory contents");
  });
});

describe("buildSystemPrompt — working method", () => {
  it("says the agent is autonomous, with no human to ask", () => {
    expect(buildSystemPrompt(env)).toMatch(/No human is available/i);
  });

  /**
   * From the llm-inference-batching-scheduler and regex-log traces:
   * Models generated 13k+ completion tokens of mathematical analysis across 180s,
   * starving the run of wall-clock time.
   */
  it("requires concise and action-oriented reasoning", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/concise and action-oriented/i);
    expect(prompt).toMatch(/Do not output lengthy speculative essays/i);
  });

  it("requires acting in the environment rather than describing changes", () => {
    expect(buildSystemPrompt(env)).toMatch(/Do not describe changes you could make yourself/i);
  });

  /**
   * From llm-inference-batching-scheduler and portfolio-optimization traces:
   * O(N^2) loops on large batches under emulation timed out after 53s.
   */
  it("requires execution efficiency under resource limits or emulation", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Execution efficiency.*emulation/i);
    expect(prompt).toMatch(/Prefer efficient operations.*vectorized/i);
    expect(prompt).toMatch(/Keep existing passing deliverables intact/i);
  });

  it("requires verifying against each requirement", () => {
    expect(buildSystemPrompt(env)).toMatch(/compare the actual output against each requirement/i);
  });

  /**
   * From the openssl-selfsigned-cert trace (experiment 2): the agent wrote a
   * script against a pip-installed package and verified it with `python3`,
   * while the grader ran `python` in its own environment, where the package
   * was absent. Verification that relies on session state is not verification.
   */
  it("warns that the work is checked in a fresh shell that inherits nothing from the session", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/fresh shell that does not inherit this session/i);
    expect(prompt).toMatch(/packages you installed only for yourself/i);
  });

  it("prefers what the environment already provides over new dependencies", () => {
    expect(buildSystemPrompt(env)).toMatch(/Prefer what the environment already provides/i);
  });

  /**
   * From the polyglot-c-py trace: the agent compiled its own solution to
   * /app/polyglot/cmain during verification; the test required that directory
   * to contain exactly main.py.c and failed on the leftover binary.
   */
  it("warns against leaving verification byproducts in the deliverable directory", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/scratch location.*not in the deliverable directory/i);
    expect(prompt).toMatch(/contain exactly the specified files/i);
  });

  it("requires checking a script with the command it will actually be launched with", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/the interpreter and command it will actually be launched with/i);
    expect(prompt).toContain("`python`");
    expect(prompt).toContain("`python3`");
  });

  /** From the cobol-modernization trace: 16 turns of investigation, deliverable never written. */
  it("requires producing the deliverable early rather than investigating indefinitely", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/get a complete, working version in place first/i);
    expect(prompt).toMatch(/Investigation that never becomes a deliverable/i);
  });

  it("tells the model that tool results carry the remaining time", () => {
    expect(buildSystemPrompt(env)).toMatch(/ends with the time left in the run/i);
  });

  it("warns against destructive cleanup of verified deliverables", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Never delete, reset, or undo verified deliverables/i);
    expect(prompt).toMatch(/checkers evaluate the environment immediately after you finish/i);
  });

  it("guides background service and network credential configuration", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Services and network configuration/i);
    expect(prompt).toMatch(/PasswordAuthentication yes/i);
    expect(prompt).toMatch(/git.*for git servers/i);
  });

  it("guides installing packages via package manager over huge from-source compilations", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/install it via the system package manager/i);
    expect(prompt).toMatch(/avoid lengthy from-source compilations/i);
  });

  it("explains how the run ends, so a reply without a tool call is deliberate", () => {
    expect(buildSystemPrompt(env)).toMatch(/Replying without a tool call ends the task/i);
  });
});

describe("buildSystemPrompt — tool semantics the model cannot infer", () => {
  it("describes bash session persistence, closed stdin and background services", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/cwd and exported variables persist between calls/i);
    expect(prompt).toMatch(/stdin is closed/i);
    expect(prompt).toMatch(/background with their output redirected/i);
  });

  it("points at the editor for edits to existing files", () => {
    expect(buildSystemPrompt(env)).toMatch(/Prefer it over shell redirection or sed/i);
  });
});

describe("scanDirectory", () => {
  it("returns undefined for a non-existent directory", () => {
    expect(scanDirectory("/tmp/nonexistent-path-for-testing-12345")).toBeUndefined();
  });

  it("returns '(empty directory)' for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "scandir-empty-"));
    try {
      expect(scanDirectory(dir)).toBe("(empty directory)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists directory tree with indentation, skipping ignored directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "scandir-test-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "src", "index.ts"), "");
      writeFileSync(join(dir, "package.json"), "");
      writeFileSync(join(dir, "node_modules", "package.json"), "");
      writeFileSync(join(dir, ".git", "config"), "");

      const listing = scanDirectory(dir);
      expect(listing).toContain("src/");
      expect(listing).toContain("  index.ts");
      expect(listing).toContain("package.json");
      expect(listing).not.toContain("node_modules");
      expect(listing).not.toContain(".git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates entries when maxEntries is exceeded", () => {
    const dir = mkdtempSync(join(tmpdir(), "scandir-trunc-"));
    try {
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(dir, `file-${i}.txt`), "");
      }
      const listing = scanDirectory(dir, { maxEntries: 4 });
      expect(listing).toContain("... (remaining entries omitted)");
      const lines = listing?.split("\n") ?? [];
      expect(lines.length).toBe(5); // 4 entries + 1 truncation line
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
