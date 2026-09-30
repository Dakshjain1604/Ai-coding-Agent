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

  it("warns against destructive cleanup of verified deliverables and example fixtures", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Keep all requested example files, branches, and commits permanently in place/i);
    expect(prompt).toMatch(/never delete them, reset repository branches, or wipe web roots/i);
    expect(prompt).toMatch(/checkers evaluate the environment immediately after you finish/i);
  });

  it("guides background service, permissions, and network credential configuration", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Services and network configuration/i);
    expect(prompt).toMatch(/PasswordAuthentication yes/i);
    expect(prompt).toMatch(/useradd.*\/bin\/bash git/i);
    expect(prompt).toMatch(/permissive read\/write permissions/i);
  });

  it("guides installing packages via package manager over huge from-source compilations", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/install it via the system package manager/i);
    expect(prompt).toMatch(/avoid lengthy from-source compilations/i);
  });

  it("instructs signature fidelity and async def coroutine adherence", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/Pay strict attention to function and class signatures/i);
    expect(prompt).toMatch(/async def.*coroutine function that callers await/i);
  });

  it("guides dataflow debugging over environment/bytecode blame", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/trace the actual data flow and argument handling through the call stack/i);
    expect(prompt).toMatch(/rather than assuming bytecode or runtime caching issues/i);
  });

  it("instructs graph edge column semantics and causal intervention edge removal", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/from.*is always the directed edge source\/parent.*to.*is always the destination\/child/i);
    expect(prompt).toMatch(/map column `from` to parent and `to` to child explicitly/i);
    expect(prompt).toMatch(/causal models or DAG interventions.*severs all incoming directed edges/i);
  });

  it("guides digital forensics raw block carving for deleted files", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/recovering deleted files.*digital forensics/i);
    expect(prompt).toMatch(/scan the raw filesystem\/unallocated blocks directly/i);
  });

  it("guides git post-receive hook deployment for web push-to-deploy", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/git push-to-deploy to a web directory/i);
    expect(prompt).toMatch(/hooks\/post-receive/i);
    expect(prompt).toMatch(/git --work-tree=<webroot> --git-dir=<repo> checkout -f master/i);
  });

  it("guides multi-criteria filter independence without artificial coupling", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/multiple numbered criteria/i);
    expect(prompt).toMatch(/evaluate each numbered criterion independently/i);
    expect(prompt).toMatch(/Do not conflate separate criteria/i);
  });

  it("guides logic circuit gate synthesis with feedforward combinational designs", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/synthesizing Boolean logic circuits/i);
    expect(prompt).toMatch(/prefer feedforward combinational circuits/i);
    expect(prompt).toMatch(/constant comparators.*interval selectors/i);
    expect(prompt).toMatch(/easily fit within standard gate budgets/i);
  });

  it("guides Golden Gate assembly primer structure without placeholder letters", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/molecular biology or cloning primers/i);
    expect(prompt).toMatch(/Golden Gate assembly with Type IIS enzymes/i);
    expect(prompt).toMatch(/concrete nucleotide bases.*never placeholder or wildcard letters like N/i);
    expect(prompt).toMatch(/5' clamp.*recognition site.*cleavage spacer.*sticky overhang.*template-annealing region/i);
  });

  it("guides early budget compliance before turn limits are reached", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/optimizing code or data against hard size or performance targets/i);
    expect(prompt).toMatch(/achieve a compliant deliverable early with reliable, direct algorithms/i);
    expect(prompt).toMatch(/saved before turn or time limits are reached/i);
    expect(prompt).toMatch(/LZ77.*entropy compression.*matches carry significant.*overhead/i);
  });

  it("guides Rust and C/C++ polyglot block comment nesting syntax differences", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/writing polyglots across languages/i);
    expect(prompt).toMatch(/Rust supports nested block comments/i);
    expect(prompt).toMatch(/C\/C\+\+ block comments terminate at the very first/i);
  });

  it("guides single file deliverable directory cleanliness without leftover compiled binaries", () => {
    const prompt = buildSystemPrompt(env);
    expect(prompt).toMatch(/single file in a directory/i);
    expect(prompt).toMatch(/never leave test binaries or compiled executables in that directory/i);
    expect(prompt).toMatch(/os\.listdir\(dir\) == \['file\.ext'\]/i);
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
