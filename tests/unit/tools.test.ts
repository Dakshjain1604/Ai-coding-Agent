import { describe, it, expect } from "vitest";
import { getToolRegistry } from "../../src/core/tools/ToolRegistry.js";
import { registerBuiltInTools } from "../../src/core/tools/built-in.js";

describe("ToolRegistry & Built-in Tools", () => {
  it("should register built-in tools and retrieve agent tool definition", () => {
    registerBuiltInTools();
    const registry = getToolRegistry();
    expect(registry.has("file_read")).toBe(true);
    expect(registry.has("file_write")).toBe(true);
    expect(registry.has("workspace_verify")).toBe(true);
  });

  it("should convert ToolDefinition to AgentTool schema", () => {
    const registry = getToolRegistry();
    const agentTool = registry.toAgentTool("file_read");
    expect(agentTool).toBeDefined();
    expect(agentTool?.name).toBe("file_read");
    expect(agentTool?.parameters.path.type).toBe("string");
  });
});
