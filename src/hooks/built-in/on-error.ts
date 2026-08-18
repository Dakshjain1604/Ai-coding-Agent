/**
 * On-Error Hook - Handles errors and can attempt recovery
 */

import type { Hook, HookContext, HookResult } from "../types.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();

export const onErrorHook: Hook = {
  name: "on-error",
  event: "on-error",
  description: "Runs when an error occurs, can attempt recovery or log",
  priority: 100,
  handler: async (context: HookContext): Promise<HookResult> => {
    const { error, toolName, taskId, agentType } = context.data as {
      error?: Error;
      toolName?: string;
      taskId?: string;
      agentType?: string;
    };

    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `[on-error] ${agentType ?? "unknown"} agent (task ${taskId ?? "unknown"}) failed${toolName ? ` in ${toolName}` : ""}: ${message}`,
    );

    return { success: true };
  },
};
