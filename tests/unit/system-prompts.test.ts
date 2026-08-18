/**
 * Tests for isValidAgentMode/AGENT_MODES (system-prompts.ts) —
 * added as the fix for a real crash: UniversalAgent.execute() used to
 * trust task.metadata.mode via a bare TypeScript cast with zero runtime
 * validation, so any invalid string reaching it crashed setMode() with an
 * uncaught "toolNames is not iterable" TypeError.
 */
import { describe, it, expect } from "vitest";
import { AGENT_MODES, isValidAgentMode } from "../../src/core/agents/system-prompts.js";

describe("AGENT_MODES", () => {
  it("contains exactly the five real agent modes", () => {
    expect(AGENT_MODES.sort()).toEqual(["code", "debug", "plan", "review", "test"]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(AGENT_MODES).size).toBe(AGENT_MODES.length);
  });
});

describe("isValidAgentMode", () => {
  for (const mode of ["code", "debug", "test", "review", "plan"]) {
    it(`accepts "${mode}"`, () => {
      expect(isValidAgentMode(mode)).toBe(true);
    });
  }

  it("rejects an unrecognized string", () => {
    expect(isValidAgentMode("orchestrator")).toBe(false);
  });

  it("rejects 'auto' (a CLI-level concept, not a real AgentMode)", () => {
    expect(isValidAgentMode("auto")).toBe(false);
  });

  it("rejects wrong-case variants (exact match only)", () => {
    expect(isValidAgentMode("Code")).toBe(false);
    expect(isValidAgentMode("CODE")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAgentMode("")).toBe(false);
  });

  it("rejects a string with leading/trailing whitespace", () => {
    expect(isValidAgentMode(" code")).toBe(false);
    expect(isValidAgentMode("code ")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidAgentMode(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidAgentMode(null)).toBe(false);
  });

  it("rejects a number", () => {
    expect(isValidAgentMode(42)).toBe(false);
  });

  it("rejects a boolean", () => {
    expect(isValidAgentMode(true)).toBe(false);
  });

  it("rejects a plain object", () => {
    expect(isValidAgentMode({ mode: "code" })).toBe(false);
  });

  it("rejects an array", () => {
    expect(isValidAgentMode(["code"])).toBe(false);
  });

  it("narrows the TypeScript type on true (compile-time check via usage, not a runtime assertion)", () => {
    const value: unknown = "test";
    if (isValidAgentMode(value)) {
      // If this compiles, the type guard is working — `value` is narrowed
      // to AgentMode here, so passing it where AgentMode is expected is
      // valid without an `as` cast.
      const mode: "code" | "debug" | "test" | "review" | "plan" = value;
      expect(mode).toBe("test");
    } else {
      throw new Error("expected isValidAgentMode to accept 'test'");
    }
  });
});
