/**
 * On-Error Hook - Handles errors and can attempt recovery
 */

import type { Hook, HookContext, HookResult } from "../types.js";

export const onErrorHook: Hook = {
  name: "on-error",
  event: "on-error",
  description: "Runs when an error occurs, can attempt recovery or log",
  priority: 100,
  handler: async (context: HookContext): Promise<HookResult> => {
    const { error, taskId, agentType } = context.data as {
      error?: Error;
      taskId?: string;
      agentType?: string;
    };

    return { success: true };
  },
};
