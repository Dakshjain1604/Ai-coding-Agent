/**
 * Post-Tool-Use Hook - Logs tool execution results
 */

import type { Hook, HookContext, HookResult } from "../types.js";

export const postToolUseHook: Hook = {
  name: "post-tool-use",
  event: "post-tool-use",
  description: "Runs after a tool is executed, can log or process results",
  priority: 50,
  handler: async (context: HookContext): Promise<HookResult> => {
    const { toolName, duration, success, result } = context.data as {
      toolName?: string;
      duration?: number;
      success?: boolean;
      result?: unknown;
    };

    return { success: true };
  },
};
