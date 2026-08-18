/**
 * Tests for ToolRegistry (core/tools/ToolRegistry.ts) — the central tool
 * registration/validation/execution layer, previously zero dedicated test
 * coverage despite every tool call in the system routing through it (via
 * toAgentTool()'s wrapper, which every UniversalAgent tool is built from).
 *
 * Note on toAgentTool()'s throw-on-failure design: a tool handler
 * returning {success:false} gets converted into a THROWN Error by
 * toAgentTool()'s execute() wrapper. Investigated whether this is a bug —
 * it isn't one to fix here: BaseAgent.executeTool() relies on exactly this
 * exception to drive its own toolSuccess/toolError tracking (hooks,
 * telemetry, the consecutive-tool-error circuit breaker in UniversalAgent's
 * loop all key off the catch block firing). Changing toAgentTool() to stop
 * throwing would require simultaneously reworking BaseAgent.executeTool()'s
 * success tracking to read result.success directly instead — a cross-
 * cutting redesign of the whole tool-execution pipeline, not a targeted
 * bug fix. Documented via the tests below rather than changed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ToolRegistry,
  getToolRegistry,
  resetToolRegistry,
  type ToolDefinition,
} from "../../src/core/tools/ToolRegistry.js";
import type { ToolResult } from "../../src/utils/types.js";

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: {},
    handler: async () => ({ success: true, output: "ok" }),
    ...overrides,
  };
}

describe("ToolRegistry — register/get/has/unregister/getAll/getNames", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers and retrieves a tool by name", () => {
    const tool = makeTool();
    registry.register(tool);
    expect(registry.get("test_tool")).toBe(tool);
  });

  it("has() reflects registration state", () => {
    expect(registry.has("test_tool")).toBe(false);
    registry.register(makeTool());
    expect(registry.has("test_tool")).toBe(true);
  });

  it("get() returns undefined for an unregistered tool", () => {
    expect(registry.get("nope")).toBeUndefined();
  });

  it("unregister() removes a tool", () => {
    registry.register(makeTool());
    registry.unregister("test_tool");
    expect(registry.has("test_tool")).toBe(false);
  });

  it("unregister() on a nonexistent tool is a safe no-op", () => {
    expect(() => registry.unregister("nope")).not.toThrow();
  });

  it("registering the same name twice overwrites (last registration wins)", () => {
    registry.register(makeTool({ description: "first" }));
    registry.register(makeTool({ description: "second" }));
    expect(registry.get("test_tool")?.description).toBe("second");
  });

  it("getAll() returns every registered tool", () => {
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    expect(registry.getAll().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("getNames() returns just the names", () => {
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    expect(registry.getNames().sort()).toEqual(["a", "b"]);
  });

  it("getAll()/getNames() are empty for a fresh registry", () => {
    expect(registry.getAll()).toEqual([]);
    expect(registry.getNames()).toEqual([]);
  });
});

describe("ToolRegistry — execute() parameter validation", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("returns a graceful failure for an unregistered tool (no throw)", async () => {
    const result = await registry.execute("nope", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("rejects a missing required parameter", async () => {
    registry.register(
      makeTool({
        parameters: { path: { type: "string", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("Missing required parameter: path");
  });

  it("allows an omitted OPTIONAL parameter", async () => {
    registry.register(
      makeTool({
        parameters: { path: { type: "string", description: "x", required: false } },
      }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.success).toBe(true);
  });

  it("rejects a type mismatch for a string parameter", async () => {
    registry.register(
      makeTool({
        parameters: { path: { type: "string", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { path: 42 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("must be of type string");
  });

  it("rejects NaN for a number parameter", async () => {
    registry.register(
      makeTool({
        parameters: { count: { type: "number", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { count: NaN });
    expect(result.success).toBe(false);
  });

  it("accepts a valid number parameter", async () => {
    registry.register(
      makeTool({
        parameters: { count: { type: "number", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { count: 5 });
    expect(result.success).toBe(true);
  });

  it("rejects a boolean-typed parameter given a string", async () => {
    registry.register(
      makeTool({
        parameters: { flag: { type: "boolean", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { flag: "true" });
    expect(result.success).toBe(false);
  });

  it("distinguishes object from array for the 'object' type", async () => {
    registry.register(
      makeTool({
        parameters: { data: { type: "object", description: "x", required: true } },
      }),
    );
    const arrayResult = await registry.execute("test_tool", { data: [1, 2, 3] });
    expect(arrayResult.success).toBe(false);
    const objectResult = await registry.execute("test_tool", { data: { a: 1 } });
    expect(objectResult.success).toBe(true);
  });

  it("rejects null for the 'object' type", async () => {
    registry.register(
      makeTool({
        parameters: { data: { type: "object", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { data: null });
    expect(result.success).toBe(false);
  });

  it("accepts a real array for the 'array' type", async () => {
    registry.register(
      makeTool({
        parameters: { items: { type: "array", description: "x", required: true } },
      }),
    );
    const result = await registry.execute("test_tool", { items: [1, 2] });
    expect(result.success).toBe(true);
  });

  it("enforces an enum constraint", async () => {
    registry.register(
      makeTool({
        parameters: {
          mode: { type: "string", description: "x", required: true, enum: ["a", "b"] },
        },
      }),
    );
    const bad = await registry.execute("test_tool", { mode: "c" });
    expect(bad.success).toBe(false);
    expect(bad.output).toContain("must be one of: a, b");
    const good = await registry.execute("test_tool", { mode: "a" });
    expect(good.success).toBe(true);
  });

  it("reports multiple validation errors together", async () => {
    registry.register(
      makeTool({
        parameters: {
          a: { type: "string", description: "x", required: true },
          b: { type: "number", description: "x", required: true },
        },
      }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.output).toContain("a");
    expect(result.output).toContain("b");
  });

  it("does not reject an unknown extra parameter not declared in the schema", async () => {
    registry.register(makeTool({ parameters: {} }));
    const result = await registry.execute("test_tool", { unexpectedExtra: "x" });
    expect(result.success).toBe(true);
  });
});

describe("ToolRegistry — execute() defaults application", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("applies a declared default when the parameter is omitted", async () => {
    let received: Record<string, unknown> | undefined;
    registry.register(
      makeTool({
        parameters: {
          mode: { type: "string", description: "x", required: false, default: "write" },
        },
        handler: async (params) => {
          received = params;
          return { success: true, output: "ok" };
        },
      }),
    );
    await registry.execute("test_tool", {});
    expect(received?.mode).toBe("write");
  });

  it("does not override an explicitly-provided value with the default", async () => {
    let received: Record<string, unknown> | undefined;
    registry.register(
      makeTool({
        parameters: {
          mode: { type: "string", description: "x", required: false, default: "write" },
        },
        handler: async (params) => {
          received = params;
          return { success: true, output: "ok" };
        },
      }),
    );
    await registry.execute("test_tool", { mode: "append" });
    expect(received?.mode).toBe("append");
  });

  it("does not add a default for a parameter with no default declared", async () => {
    let received: Record<string, unknown> | undefined;
    registry.register(
      makeTool({
        parameters: { path: { type: "string", description: "x", required: false } },
        handler: async (params) => {
          received = params;
          return { success: true, output: "ok" };
        },
      }),
    );
    await registry.execute("test_tool", {});
    expect("path" in (received ?? {})).toBe(false);
  });
});

describe("ToolRegistry — execute() handler outcomes", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("returns the handler's successful result unchanged", async () => {
    registry.register(makeTool({ handler: async () => ({ success: true, output: "done" }) }));
    const result = await registry.execute("test_tool", {});
    expect(result).toEqual({ success: true, output: "done" });
  });

  it("returns the handler's graceful failure unchanged (no throw at this layer)", async () => {
    registry.register(
      makeTool({ handler: async () => ({ success: false, output: "handled failure" }) }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.success).toBe(false);
    expect(result.output).toBe("handled failure");
  });

  it("catches a handler that throws and returns a graceful failure instead of propagating", async () => {
    registry.register(
      makeTool({
        handler: async () => {
          throw new Error("boom");
        },
      }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.success).toBe(false);
    expect(result.output).toBe("boom");
  });

  it("catches a handler that throws a non-Error value", async () => {
    registry.register(
      makeTool({
        handler: async () => {
          throw "a plain string throw";
        },
      }),
    );
    const result = await registry.execute("test_tool", {});
    expect(result.success).toBe(false);
    expect(result.output).toBe("Unknown error");
  });
});

describe("ToolRegistry — toAgentTool()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("returns undefined for an unregistered tool", () => {
    expect(registry.toAgentTool("nope")).toBeUndefined();
  });

  it("maps name/description/parameters through unchanged", () => {
    registry.register(
      makeTool({
        description: "does a thing",
        parameters: { x: { type: "string", description: "y", required: true } },
      }),
    );
    const agentTool = registry.toAgentTool("test_tool")!;
    expect(agentTool.name).toBe("test_tool");
    expect(agentTool.description).toBe("does a thing");
    expect(agentTool.parameters.x.type).toBe("string");
  });

  it("execute() resolves with the full result on success", async () => {
    registry.register(makeTool({ handler: async () => ({ success: true, output: "yes" }) }));
    const agentTool = registry.toAgentTool("test_tool")!;
    const result = (await agentTool.execute({})) as ToolResult;
    expect(result.success).toBe(true);
    expect(result.output).toBe("yes");
  });

  it("execute() THROWS for a graceful {success:false} result (documented, intentional)", async () => {
    registry.register(
      makeTool({ handler: async () => ({ success: false, output: "no such file" }) }),
    );
    const agentTool = registry.toAgentTool("test_tool")!;
    await expect(agentTool.execute({})).rejects.toThrow("no such file");
  });

  it("execute() throws a generic message when output is empty", async () => {
    registry.register(makeTool({ handler: async () => ({ success: false, output: "" }) }));
    const agentTool = registry.toAgentTool("test_tool")!;
    await expect(agentTool.execute({})).rejects.toThrow(/failed execution/);
  });

  it("execute() still goes through the same parameter validation as execute()", async () => {
    registry.register(
      makeTool({
        parameters: { path: { type: "string", description: "x", required: true } },
      }),
    );
    const agentTool = registry.toAgentTool("test_tool")!;
    await expect(agentTool.execute({})).rejects.toThrow(/Missing required parameter/);
  });
});

describe("ToolRegistry — getToolsForAgent()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool({ name: "file_read" }));
    registry.register(makeTool({ name: "file_write" }));
    registry.register(makeTool({ name: "git_status" }));
  });

  it("filters tools to only those in the given agent type's TOOL_SETS entry", () => {
    const tools = registry.getToolsForAgent("review");
    // review's TOOL_SETS doesn't include file_write.
    expect(tools.map((t) => t.name)).toContain("file_read");
    expect(tools.map((t) => t.name)).not.toContain("file_write");
  });

  it("falls back to TOOL_SETS.code for an unrecognized agent type", () => {
    const forUnknown = registry.getToolsForAgent("not-a-real-agent-type");
    const forCode = registry.getToolsForAgent("code");
    expect(forUnknown.map((t) => t.name).sort()).toEqual(forCode.map((t) => t.name).sort());
  });
});

describe("getToolRegistry() / resetToolRegistry() singleton", () => {
  afterEach(() => resetToolRegistry());

  it("returns the same instance across calls", () => {
    const a = getToolRegistry();
    const b = getToolRegistry();
    expect(a).toBe(b);
  });

  it("resetToolRegistry() forces a fresh instance", () => {
    const a = getToolRegistry();
    resetToolRegistry();
    const b = getToolRegistry();
    expect(a).not.toBe(b);
  });

  it("a fresh instance after reset has no leftover tools from the old one", () => {
    getToolRegistry().register(makeTool({ name: "leftover" }));
    resetToolRegistry();
    expect(getToolRegistry().has("leftover")).toBe(false);
  });
});
