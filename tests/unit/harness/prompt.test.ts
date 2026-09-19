/**
 * The system prompt is part of the harness's behavior: it states the
 * environment facts the agent cannot discover for free, and the working
 * method. These tests pin the facts and the guidance that came out of real
 * run traces, not the wording around them.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../../src/harness/prompt.js";

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
});

describe("buildSystemPrompt — working method", () => {
  it("says the agent is autonomous, with no human to ask", () => {
    expect(buildSystemPrompt(env)).toMatch(/No human is available/i);
  });

  it("requires acting in the environment rather than describing changes", () => {
    expect(buildSystemPrompt(env)).toMatch(/Do not describe changes you could make yourself/i);
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
