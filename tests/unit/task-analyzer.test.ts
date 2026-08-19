/**
 * Regression test found by actually running the CLI: `node bin/run.js run
 * "say hello"` logged "Spawning plan agent" for a trivial, no-signal task.
 * Root cause: analyzeScope() and analyzeImplementation() both defaulted to
 * a 0.5 "moderate/standard" score when no keyword matched — two of six
 * weighted factors defaulting to 0.5 was enough on its own to push ANY
 * keyword-free task description into "medium" complexity, which routes to
 * a 2-agent pipeline (['plan', 'code']) instead of a single lightweight
 * agent. This affects any short/conversational task, not just "say hello".
 */
import { describe, it, expect } from "vitest";
import { TaskAnalyzer } from "../../src/core/orchestrator/TaskAnalyzer.js";
import type { Task } from "../../src/utils/types.js";

function makeTask(description: string): Task {
  return {
    id: "t1",
    description,
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("TaskAnalyzer complexity defaults", () => {
  it("classifies a trivial, keyword-free task as simple (not medium)", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(makeTask("say hello"));

    expect(analysis.complexity).toBe("simple");
    expect(analysis.suggestedStrategy.mode).toBe("single");
    expect(analysis.suggestedStrategy.agents).toEqual(["code"]);
  });

  it("classifies other short conversational tasks as simple", () => {
    const analyzer = new TaskAnalyzer();
    for (const description of ["what time is it", "hi there", "explain this"]) {
      const analysis = analyzer.analyze(makeTask(description));
      expect(analysis.complexity).toBe("simple");
    }
  });

  it("still classifies a genuinely complex, multi-signal task as complex", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask(
        "refactor the entire authentication module to integrate a new database and add comprehensive test coverage, including frontend and backend changes with external API dependencies",
      ),
    );
    expect(["medium", "complex"]).toContain(analysis.complexity);
  });

  it("still classifies a task with a clear implementation keyword as at least medium", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask("implement a new user authentication feature with database integration"),
    );
    expect(["medium", "complex"]).toContain(analysis.complexity);
  });
});

// Regression coverage for a real SWE-bench task (astropy__astropy-12907)
// that surfaced two compounding bugs in the classifier: (1) keyword checks
// used raw `.includes()` instead of word-boundary matching, so a real bug
// report repeatedly mentioning astropy's `Linear1D` model class got scored
// "Line-level scope" (the LOWEST complexity tier) purely because
// "linear1d".includes("line") is true; (2) real bug reports are phrased as
// observations, not commands, so they match none of analyzeImplementation's
// imperative-verb keywords and fall through to "assumed simple" even
// though they require real cross-file investigation. Confirmed live: this
// task scored complexity "simple" — LOWER than "create a file called
// hello.txt" — and got routed to a single non-file-writing `plan`-mode
// agent, which then answered the issue conversationally from its own
// pretrained knowledge instead of investigating, and got the actual bug
// mechanism factually wrong.
describe("TaskAnalyzer — real-world bug report phrasing (SWE-bench regression)", () => {
  const REAL_ASTROPY_ISSUE = `Modeling's \`separability_matrix\` does not compute separability correctly for nested CompoundModels

Consider the following model:

\`\`\`python
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

cm = m.Linear1D(10) & m.Linear1D(5)
\`\`\`

It's separability matrix as you might expect is a diagonal:

\`\`\`python
>>> separability_matrix(cm)
array([[ True, False],
       [False,  True]])
\`\`\`

If however, I nest these compound models, suddenly the inputs and outputs are no longer separable?
This feels like a bug to me, but I might be missing something?`;

  it("does not classify a real bug report as 'Line-level scope' just because it mentions astropy's Linear1D class", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(makeTask(REAL_ASTROPY_ISSUE));
    const scopeFactor = analysis.factors.find((f) => f.name === "scope");
    expect(scopeFactor?.description).not.toBe("Line-level scope");
  });

  it("treats a keyword-free bug report containing real code examples as at least medium implementation complexity, not 'assumed simple'", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(makeTask(REAL_ASTROPY_ISSUE));
    const implFactor = analysis.factors.find((f) => f.name === "implementation");
    expect(implFactor?.value).toBeGreaterThanOrEqual(0.5);
  });

  // The literal word "complex" appearing in ordinary prose ("if I make the
  // model more complex...") used to false-positive-match `orchestrator`'s
  // keyword list and immediately route to a single, unverified 'plan'-mode
  // agent (no file-write tools) via an early-return that runs BEFORE the
  // complexity-based switch even executes — regardless of the actual
  // complexity score. Confirmed live this was the direct cause of this
  // exact task's misrouting. The real thing that matters isn't the raw
  // complexity label crossing an arbitrary threshold — it's that the task
  // ends up routed to an agent capable of actually making code changes.
  it("routes the real bug report to a code-capable agent, not the file-write-incapable 'orchestrator'/'plan'", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(makeTask(REAL_ASTROPY_ISSUE));
    expect(analysis.suggestedStrategy.agents).not.toContain("orchestrator");
    expect(analysis.suggestedStrategy.agents).not.toContain("plan");
  });

  it("word-boundary matching doesn't false-positive on ordinary words containing 'one' (ordinary conversational text)", () => {
    const analyzer = new TaskAnalyzer();
    // "someone" contains "one" as a raw substring — must not trigger the
    // fileCount "single/one" scope-indicator branch.
    const analysis = analyzer.analyze(makeTask("is there someone who can help me understand this"));
    expect(analysis.complexity).toBe("simple");
  });

  it("does not route a simple task to 'orchestrator' just because it contains the ordinary word 'complex'", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask("say hi, this greeting can be as complex or simple as you like"),
    );
    expect(analysis.suggestedStrategy.agents).not.toContain("orchestrator");
  });

  it("still recognizes genuine word-boundary keyword matches (not overcorrected into never matching)", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(makeTask("please review this one file"));
    const scopeFactor = analysis.factors.find((f) => f.name === "scope");
    // "file" is a genuine standalone word here — should still match.
    expect(scopeFactor?.description).toBe("File/function-level scope");
  });
});

// Regression coverage for architecture-optimal.md Phase 2 item B1: risk
// must be scored independently from complexity, not derived from it —
// otherwise a short, low-complexity description of a highly destructive
// action would be silently under-flagged.
describe("TaskAnalyzer risk scoring (independent of complexity)", () => {
  it("flags a short, complexity-simple task as high risk when it's destructive + irreversible", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask("delete the users table in production"),
    );

    expect(analysis.complexity).toBe("simple");
    expect(analysis.risk).toBe("high");
  });

  it("does not flag a large but harmless task as high risk", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask(
        "rename a UI label across the entire project, updating every file and component",
      ),
    );

    expect(analysis.risk).toBe("low");
  });

  it("flags sensitive-domain keywords even without destructive verbs", () => {
    const analyzer = new TaskAnalyzer();
    const analysis = analyzer.analyze(
      makeTask("store the API key and password in the config"),
    );

    expect(["medium", "high"]).toContain(analysis.risk);
  });
});
