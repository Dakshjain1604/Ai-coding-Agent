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
