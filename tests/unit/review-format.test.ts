/**
 * Tests for formatReviewOutput() (cli/commands/review.ts) — the fix for
 * `--format`, which used to be accepted, stored in task.metadata, and
 * never read anywhere: every format value produced identical plain-text
 * output. json/markdown now actually shape the result; "text" is
 * unchanged (only the failure path shows result.output — on success the
 * agent's own response has already streamed live to the terminal during
 * execution, confirmed by reading UniversalAgent.execute()'s per-turn
 * process.stdout.write/console.log(marked.parse(...)) calls, so
 * re-printing it here would just duplicate it, not fix a missing-output
 * bug).
 *
 * Also covers the removal of AutonomousMode (`cli/modes/autonomous.ts`)
 * — confirmed fully unreachable (zero callers anywhere in src/ or
 * tests/) and deleted outright rather than wired up, since its
 * "self-correction" loop never actually incorporated a failed
 * iteration's output into the next attempt.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { formatReviewOutput } from "../../src/cli/commands/review.js";
import type { TaskResult } from "../../src/utils/types.js";

const REPO_ROOT = process.cwd();

function successResult(output: string): TaskResult {
  return { taskId: "t1", success: true, output, durationMs: 10, agentType: "review" };
}

function failureResult(output: string): TaskResult {
  return { taskId: "t1", success: false, output, durationMs: 10, agentType: "review" };
}

describe("formatReviewOutput — format:'text' (unchanged default behavior)", () => {
  it("returns an empty string for a successful review (already streamed live)", () => {
    expect(formatReviewOutput(successResult("looks good"), "text", "src/", "all")).toBe("");
  });

  it("returns a non-empty failure message for a failed review", () => {
    const out = formatReviewOutput(failureResult("provider unavailable"), "text", "src/", "all");
    expect(out).not.toBe("");
    expect(out).toContain("Review failed");
  });

  it("includes the failure's output text", () => {
    const out = formatReviewOutput(failureResult("specific error detail"), "text", "src/", "all");
    expect(out).toContain("specific error detail");
  });

  it("returns an empty string for a successful review even with a long output", () => {
    const longOutput = "x".repeat(5000);
    expect(formatReviewOutput(successResult(longOutput), "text", "src/", "all")).toBe("");
  });

  it("returns an empty string for a successful review with an empty output string", () => {
    expect(formatReviewOutput(successResult(""), "text", "src/", "all")).toBe("");
  });
});

describe("formatReviewOutput — format:'json'", () => {
  it("produces valid, parseable JSON", () => {
    const out = formatReviewOutput(successResult("all good"), "json", "src/", "all");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("includes target/focus/success/output as the correct fields", () => {
    const out = formatReviewOutput(successResult("all good"), "json", "src/utils", "security");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      target: "src/utils",
      focus: "security",
      success: true,
      output: "all good",
    });
  });

  it("reflects success:false correctly", () => {
    const out = formatReviewOutput(failureResult("broke"), "json", "src/", "all");
    expect(JSON.parse(out).success).toBe(false);
  });

  it("still includes output on failure (json format doesn't suppress it like text does)", () => {
    const out = formatReviewOutput(failureResult("broke"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("broke");
  });

  it("still includes output on SUCCESS (json format doesn't suppress it like text does)", () => {
    const out = formatReviewOutput(successResult("no issues found"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("no issues found");
  });

  it("correctly escapes embedded double quotes in the output", () => {
    const out = formatReviewOutput(successResult('found a "smell" here'), "json", "src/", "all");
    const parsed = JSON.parse(out);
    expect(parsed.output).toBe('found a "smell" here');
  });

  it("correctly escapes embedded backslashes in the output", () => {
    const out = formatReviewOutput(successResult("path C:\\Users\\x"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("path C:\\Users\\x");
  });

  it("correctly escapes embedded newlines in the output", () => {
    const out = formatReviewOutput(successResult("line1\nline2\nline3"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("line1\nline2\nline3");
  });

  it("handles an empty output string", () => {
    const out = formatReviewOutput(successResult(""), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("");
  });

  it("handles unicode and emoji in the output", () => {
    const out = formatReviewOutput(successResult("héllo 世界 🎉"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("héllo 世界 🎉");
  });

  it("handles special characters in the target path", () => {
    const out = formatReviewOutput(successResult("ok"), "json", 'src/"weird"/path', "all");
    expect(JSON.parse(out).target).toBe('src/"weird"/path');
  });

  it("handles a very long output without truncation", () => {
    const longOutput = "finding ".repeat(2000);
    const out = formatReviewOutput(successResult(longOutput), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe(longOutput);
  });

  it("is pretty-printed (indented), not minified", () => {
    const out = formatReviewOutput(successResult("ok"), "json", "src/", "all");
    expect(out).toContain("\n");
    expect(out).toContain("  ");
  });
});

describe("formatReviewOutput — format:'markdown'", () => {
  it("includes a heading with the target", () => {
    const out = formatReviewOutput(successResult("ok"), "markdown", "src/utils.ts", "all");
    expect(out).toContain("## Review: src/utils.ts");
  });

  it("includes the focus area", () => {
    const out = formatReviewOutput(successResult("ok"), "markdown", "src/", "performance");
    expect(out).toContain("performance");
  });

  it("shows 'Passed' status for a successful review", () => {
    const out = formatReviewOutput(successResult("ok"), "markdown", "src/", "all");
    expect(out).toContain("Passed");
    expect(out).not.toContain("Failed");
  });

  it("shows 'Failed' status for a failed review", () => {
    const out = formatReviewOutput(failureResult("broke"), "markdown", "src/", "all");
    expect(out).toContain("Failed");
    expect(out).not.toContain("Passed");
  });

  it("includes the output text verbatim (no JSON-style escaping)", () => {
    const out = formatReviewOutput(
      successResult('a "quoted" finding\nwith a newline'),
      "markdown",
      "src/",
      "all",
    );
    expect(out).toContain('a "quoted" finding\nwith a newline');
  });

  it("includes output on success (unlike text format, which suppresses it)", () => {
    const out = formatReviewOutput(successResult("no major issues"), "markdown", "src/", "all");
    expect(out).toContain("no major issues");
  });

  it("handles an empty output string without crashing", () => {
    expect(() => formatReviewOutput(successResult(""), "markdown", "src/", "all")).not.toThrow();
  });

  it("handles unicode in the output", () => {
    const out = formatReviewOutput(successResult("héllo 世界"), "markdown", "src/", "all");
    expect(out).toContain("héllo 世界");
  });

  it("handles a target containing markdown-special characters without crashing", () => {
    expect(() =>
      formatReviewOutput(successResult("ok"), "markdown", "src/[weird]*.ts", "all"),
    ).not.toThrow();
  });
});

describe("formatReviewOutput — format value edge cases", () => {
  it("falls back to text behavior for an unrecognized format string", () => {
    const out = formatReviewOutput(successResult("ok"), "yaml", "src/", "all");
    expect(out).toBe(""); // same as "text" on success
  });

  it("is case-sensitive — 'JSON' does not match the 'json' branch", () => {
    const out = formatReviewOutput(successResult("ok"), "JSON", "src/", "all");
    expect(() => JSON.parse(out)).toThrow(); // falls to text branch, returns ""
  });

  it("falls back to text behavior for an empty format string", () => {
    const out = formatReviewOutput(successResult("ok"), "", "src/", "all");
    expect(out).toBe("");
  });

  it("produces distinctly different output shapes across all three formats for the same result", () => {
    const result = successResult("consistent finding");
    const text = formatReviewOutput(result, "text", "src/", "all");
    const json = formatReviewOutput(result, "json", "src/", "all");
    const markdown = formatReviewOutput(result, "markdown", "src/", "all");

    expect(text).not.toBe(json);
    expect(json).not.toBe(markdown);
    expect(text).not.toBe(markdown);
  });
});

describe("formatReviewOutput — target/focus parameter variations", () => {
  it("handles an empty target string", () => {
    const out = formatReviewOutput(successResult("ok"), "json", "", "all");
    expect(JSON.parse(out).target).toBe("");
  });

  it("handles the default 'changes' target", () => {
    const out = formatReviewOutput(successResult("ok"), "json", "changes", "all");
    expect(JSON.parse(out).target).toBe("changes");
  });

  it("handles each real focus option correctly", () => {
    for (const focus of ["quality", "security", "performance", "all"]) {
      const out = formatReviewOutput(successResult("ok"), "json", "src/", focus);
      expect(JSON.parse(out).focus).toBe(focus);
    }
  });
});

describe("formatReviewOutput — additional escaping edge cases", () => {
  it("json: handles tab and control characters in the output", () => {
    const out = formatReviewOutput(successResult("col1\tcol2\tcol3"), "json", "src/", "all");
    expect(JSON.parse(out).output).toBe("col1\tcol2\tcol3");
  });

  it("json: handles an output that itself looks like JSON", () => {
    const out = formatReviewOutput(
      successResult('{"nested": "looks like json but isn\'t"}'),
      "json",
      "src/",
      "all",
    );
    const parsed = JSON.parse(out);
    expect(typeof parsed.output).toBe("string");
    expect(parsed.output).toBe('{"nested": "looks like json but isn\'t"}');
  });

  it("json: round-trips through JSON.parse -> re-stringify without data loss", () => {
    const original = successResult("multi\nline\ttabbed \"quoted\" content 🎉");
    const out = formatReviewOutput(original, "json", "src/", "all");
    const parsed = JSON.parse(out);
    const reserialized = JSON.stringify(parsed);
    expect(JSON.parse(reserialized).output).toBe(original.output);
  });

  it("markdown: an output containing '## ' headers doesn't break the outer structure", () => {
    const out = formatReviewOutput(
      successResult("## This looks like a heading\nmore text"),
      "markdown",
      "src/",
      "all",
    );
    expect(out).toContain("## Review: src/");
    expect(out).toContain("## This looks like a heading");
  });

  it("text: a failure output containing ANSI-sensitive characters doesn't crash formatting", () => {
    expect(() =>
      formatReviewOutput(failureResult("error: \x1b[31mred\x1b[0m text"), "text", "src/", "all"),
    ).not.toThrow();
  });
});

describe("Dead code removal — AutonomousMode / autonomous.ts", () => {
  it("autonomous.ts no longer exists in cli/modes/", () => {
    expect(existsSync(join(REPO_ROOT, "src", "cli", "modes", "autonomous.ts"))).toBe(false);
  });

  it("modes/index.ts no longer re-exports AutonomousMode or startAutonomousMode", () => {
    const content = readFileSync(join(REPO_ROOT, "src", "cli", "modes", "index.ts"), "utf-8");
    expect(content).not.toContain("AutonomousMode");
    expect(content).not.toContain("startAutonomousMode");
    expect(content).not.toContain("./autonomous.js");
  });

  it("modes/index.ts still re-exports InteractiveMode (the real, working mode)", () => {
    const content = readFileSync(join(REPO_ROOT, "src", "cli", "modes", "index.ts"), "utf-8");
    expect(content).toContain("InteractiveMode");
  });

  it("run.ts's --mode flag no longer offers the dead 'autonomous' option", () => {
    const content = readFileSync(
      join(REPO_ROOT, "src", "cli", "commands", "run.ts"),
      "utf-8",
    );
    // Match the actual options array, not just any mention of the word.
    expect(content).toMatch(/options:\s*\[[^\]]*\]/);
    const optionsMatch = content.match(/options:\s*\[([^\]]*)\]/);
    expect(optionsMatch?.[1]).not.toContain("autonomous");
  });

  it("run.ts's --mode flag still offers 'auto' and 'interactive'", () => {
    const content = readFileSync(
      join(REPO_ROOT, "src", "cli", "commands", "run.ts"),
      "utf-8",
    );
    const optionsMatch = content.match(/options:\s*\[([^\]]*)\]/);
    expect(optionsMatch?.[1]).toContain("auto");
    expect(optionsMatch?.[1]).toContain("interactive");
  });
});
