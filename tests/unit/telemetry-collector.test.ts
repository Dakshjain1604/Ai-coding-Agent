/**
 * Tests for TelemetryCollector (telemetry/TelemetryCollector.ts) —
 * previously zero coverage.
 *
 * Centerpiece regression: recordLLMCall()/recordToolCall() received a
 * turnNumber parameter (threaded all the way from UniversalAgent through
 * BaseAgent.safeRecordLLMCall/safeRecordToolCall) but discarded it as
 * `_turnNumber` and appended every call into one flat, never-cleared
 * array. buildSummary(turnNumber) then summed ALL calls ever recorded by
 * the process — so "Turn 2 Summary" silently included Turn 1's calls
 * too, "Turn 3" included 1+2, etc. Fixed by tagging each recorded call
 * with its turnNumber and filtering buildSummary() to just that turn.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TelemetryCollector } from "../../src/telemetry/TelemetryCollector.js";

beforeEach(() => {
  TelemetryCollector.resetInstance();
});

function record(
  collector: TelemetryCollector,
  turnNumber: number,
  overrides?: Partial<{ provider: string; model: string; tokens: number; cost: number; durationMs: number }>,
) {
  const o = { provider: "groq", model: "m", tokens: 100, cost: 0.01, durationMs: 50, ...overrides };
  collector.recordLLMCall(
    collector.getSessionId(),
    turnNumber,
    o.provider,
    o.model,
    { promptTokens: o.tokens - 10, completionTokens: 10, totalTokens: o.tokens },
    o.cost,
    o.durationMs,
  );
}

describe("TelemetryCollector — singleton", () => {
  it("getInstance() returns the same instance across calls", () => {
    expect(TelemetryCollector.getInstance()).toBe(TelemetryCollector.getInstance());
  });

  it("resetInstance() produces a fresh instance with a new session id", () => {
    const first = TelemetryCollector.getInstance();
    const firstId = first.getSessionId();
    TelemetryCollector.resetInstance();
    const second = TelemetryCollector.getInstance();
    expect(second).not.toBe(first);
    expect(second.getSessionId()).not.toBe(firstId);
  });

  it("is enabled by default", () => {
    expect(TelemetryCollector.getInstance().isEnabled()).toBe(true);
  });
});

describe("TelemetryCollector — per-turn scoping fix (buildSummary)", () => {
  it("scopes buildSummary() to only calls recorded under the requested turn number", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { tokens: 100, cost: 0.01 });
    record(collector, 1, { tokens: 50, cost: 0.005 });
    record(collector, 2, { tokens: 200, cost: 0.02 });

    const turn1 = collector.buildSummary(1);
    expect(turn1.totalLLMCalls).toBe(2);
    expect(turn1.totalTokens).toBe(150);
    expect(turn1.totalCost).toBeCloseTo(0.015, 10);

    const turn2 = collector.buildSummary(2);
    expect(turn2.totalLLMCalls).toBe(1);
    expect(turn2.totalTokens).toBe(200);
    expect(turn2.totalCost).toBeCloseTo(0.02, 10);
  });

  it("does not let a later turn's summary include an earlier turn's calls", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { tokens: 100 });
    const turn1Before = collector.buildSummary(1);
    record(collector, 2, { tokens: 300 });
    const turn1After = collector.buildSummary(1);
    expect(turn1After.totalTokens).toBe(turn1Before.totalTokens);
    expect(collector.buildSummary(2).totalTokens).toBe(300);
  });

  it("returns an empty summary for a turn number that never recorded any calls", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { tokens: 100 });
    const summary = collector.buildSummary(5);
    expect(summary.totalLLMCalls).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });

  it("scopes tool-call counts to the requested turn the same way", () => {
    const collector = TelemetryCollector.getInstance();
    collector.recordToolCall(collector.getSessionId(), 1, "file_read", {}, true, 10);
    collector.recordToolCall(collector.getSessionId(), 2, "file_write", {}, true, 20);

    expect(collector.buildSummary(1).totalToolCalls).toBe(1);
    expect(collector.buildSummary(2).totalToolCalls).toBe(1);
    expect(collector.buildSummary(1).toolBreakdown).toHaveProperty("file_read");
    expect(collector.buildSummary(1).toolBreakdown).not.toHaveProperty("file_write");
  });
});

describe("TelemetryCollector — buildSummary() aggregation", () => {
  it("builds a per-provider breakdown", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { provider: "groq", tokens: 100, cost: 0.01 });
    record(collector, 1, { provider: "groq", tokens: 50, cost: 0.005 });
    record(collector, 1, { provider: "local", tokens: 30, cost: 0 });

    const summary = collector.buildSummary(1);
    expect(summary.providerBreakdown.groq).toEqual({ calls: 2, tokens: 150, cost: 0.015 });
    expect(summary.providerBreakdown.local).toEqual({ calls: 1, tokens: 30, cost: 0 });
  });

  it("counts failed tool calls in both totals and per-tool breakdown", () => {
    const collector = TelemetryCollector.getInstance();
    collector.recordToolCall(collector.getSessionId(), 1, "shell_exec", {}, true, 10);
    collector.recordToolCall(collector.getSessionId(), 1, "shell_exec", {}, false, 10, "boom");
    collector.recordToolCall(collector.getSessionId(), 1, "file_read", {}, true, 5);

    const summary = collector.buildSummary(1);
    expect(summary.failedTools).toBe(1);
    expect(summary.toolBreakdown.shell_exec).toEqual({ calls: 2, failed: 1 });
    expect(summary.toolBreakdown.file_read).toEqual({ calls: 1, failed: 0 });
  });

  it("sums prompt/completion/total tokens correctly across calls", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { tokens: 100 });
    record(collector, 1, { tokens: 40 });
    const summary = collector.buildSummary(1);
    expect(summary.promptTokens).toBe(90 + 30);
    expect(summary.completionTokens).toBe(20);
    expect(summary.totalTokens).toBe(140);
  });

  it("sums LLM and tool durations independently", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { durationMs: 100 });
    record(collector, 1, { durationMs: 50 });
    collector.recordToolCall(collector.getSessionId(), 1, "x", {}, true, 30);
    const summary = collector.buildSummary(1);
    expect(summary.totalLLMDurationMs).toBe(150);
    expect(summary.totalToolDurationMs).toBe(30);
  });

  it("returns an all-zero summary before any calls are recorded", () => {
    const summary = TelemetryCollector.getInstance().buildSummary(1);
    expect(summary.totalLLMCalls).toBe(0);
    expect(summary.totalToolCalls).toBe(0);
    expect(summary.totalCost).toBe(0);
    expect(Object.keys(summary.providerBreakdown)).toHaveLength(0);
    expect(Object.keys(summary.toolBreakdown)).toHaveLength(0);
  });
});

describe("TelemetryCollector — setEnabled()", () => {
  it("drops recorded calls entirely while disabled", () => {
    const collector = TelemetryCollector.getInstance();
    collector.setEnabled(false);
    record(collector, 1, { tokens: 100 });
    collector.recordToolCall(collector.getSessionId(), 1, "x", {}, true, 10);
    expect(collector.buildSummary(1).totalLLMCalls).toBe(0);
    expect(collector.buildSummary(1).totalToolCalls).toBe(0);
  });

  it("resumes recording once re-enabled", () => {
    const collector = TelemetryCollector.getInstance();
    collector.setEnabled(false);
    record(collector, 1, { tokens: 100 });
    collector.setEnabled(true);
    record(collector, 1, { tokens: 50 });
    expect(collector.buildSummary(1).totalLLMCalls).toBe(1);
  });
});

describe("TelemetryCollector — printSummary()", () => {
  it("does not throw when printing a populated summary", () => {
    const collector = TelemetryCollector.getInstance();
    record(collector, 1, { tokens: 100 });
    collector.recordToolCall(collector.getSessionId(), 1, "file_read", {}, false, 10, "not found");
    const summary = collector.buildSummary(1);
    expect(() => collector.printSummary(summary, 1)).not.toThrow();
  });

  it("does not throw when printing an empty summary", () => {
    const collector = TelemetryCollector.getInstance();
    const summary = collector.buildSummary(1);
    expect(() => collector.printSummary(summary, 1)).not.toThrow();
  });
});
