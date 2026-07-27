import { describe, it, expect } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { TOOL_SETS } from "../../src/core/agents/tool-sets.js";

describe("UniversalAgent & Mode Management", () => {
  it("should auto-detect debug mode from task prompt", () => {
    const agent = new UniversalAgent();
    const mode = agent.detectMode("Fix breaking exception in database connection");
    expect(mode).toBe("debug");
  });

  it("should auto-detect test mode from task prompt", () => {
    const agent = new UniversalAgent();
    const mode = agent.detectMode("Run unit test suite and check coverage");
    expect(mode).toBe("test");
  });

  it("should register workspace_verify across all tool sets", () => {
    for (const [mode, tools] of Object.entries(TOOL_SETS)) {
      expect(tools).toContain("workspace_verify");
    }
  });
});
