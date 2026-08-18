/**
 * Post-Tool-Use Hook - Logs tool execution results
 */

import type { Hook, HookContext, HookResult } from "../types.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();

export const postToolUseHook: Hook = {
  name: "post-tool-use",
  event: "post-tool-use",
  description: "Runs after a tool is executed, can log or process results",
  priority: 50,
  handler: async (context: HookContext): Promise<HookResult> => {
    const { toolName, duration, success, error } = context.data as {
      toolName?: string;
      duration?: number;
      success?: boolean;
      error?: string;
    };

    if (success === false) {
      logger.debug(`[post-tool-use] ${toolName} failed after ${duration}ms: ${error}`);
    } else {
      logger.debug(`[post-tool-use] ${toolName} completed in ${duration}ms`);
    }

    return { success: true };
  },
};
