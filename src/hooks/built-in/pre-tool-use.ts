/**
 * Pre-Tool-Use Hook - Validates and modifies tool execution
 */

import type { Hook, HookContext, HookResult } from "../types.js";

export const preToolUseHook: Hook = {
  name: "pre-tool-use",
  event: "pre-tool-use",
  description:
    "Runs before a tool is executed, can validate or modify parameters",
  priority: 100,
  handler: async (context: HookContext): Promise<HookResult> => {
    const { toolName, params } = context.data as {
      toolName?: string;
      params?: Record<string, unknown>;
    };

    if (!toolName) {
      return { success: false, error: "Missing toolName in context" };
    }

    const dangerousTools = ["shell_exec", "rm", "delete"];
    if (dangerousTools.includes(toolName) && params) {
      if (toolName === "shell_exec") {
        const cmd = params.command as string;
        if (cmd?.includes("rm -rf") || cmd?.includes("del /")) {
          return {
            success: false,
            error: `Dangerous command blocked: ${cmd}`,
          };
        }
      }
    }

    return { success: true };
  },
};
