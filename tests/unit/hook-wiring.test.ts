/**
 * Verifies that BaseAgent.executeTool() actually invokes the hook pipeline
 * (pre-tool-use / post-tool-use) rather than just consulting the permission
 * system — this is the specific "built but never wired in" bug the Wiring
 * Audit found: the dangerous-command hook passed its own unit tests in
 * isolation but never ran during real tool execution.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { getHookManager } from "../../src/hooks/HookManager.js";
import { registerBuiltinHooks } from "../../src/hooks/registerBuiltinHooks.js";
import type { Hook, HookContext } from "../../src/hooks/types.js";

describe("Hook wiring in BaseAgent.executeTool", () => {
  beforeEach(() => {
    getHookManager().enable();
    registerBuiltinHooks();
  });

  it("blocks a dangerous shell command via the pre-tool-use hook", async () => {
    const agent = new UniversalAgent("code");

    const result = (await (agent as unknown as {
      executeTool: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }).executeTool("shell_exec", { command: "rm -rf /" })) as {
      success: boolean;
      output: string;
    };

    expect(result.success).toBe(false);
    expect(result.output).toContain("Dangerous command blocked");
  });

  it("fires post-tool-use for a successful tool call", async () => {
    let observedToolName: string | undefined;
    let observedSuccess: boolean | undefined;

    const spyHook: Hook = {
      name: "test-post-tool-use-spy",
      event: "post-tool-use",
      description: "Test spy",
      handler: async (context: HookContext) => {
        observedToolName = context.data.toolName as string;
        observedSuccess = context.data.success as boolean;
        return { success: true };
      },
    };
    getHookManager().register(spyHook);

    const agent = new UniversalAgent("code");
    await (agent as unknown as {
      executeTool: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }).executeTool("file_read", { path: "package.json" });

    expect(observedToolName).toBe("file_read");
    expect(observedSuccess).toBe(true);

    getHookManager().unregister("test-post-tool-use-spy");
  });
});
