/**
 * spawn_subagent tool - lets the agent decompose a genuinely complex task
 * into a sequence of focused sub-agent runs, each in its own mode.
 *
 * ParallelOrchestrator.js is imported dynamically inside the handler because
 * it statically imports UniversalAgent, which (via builtin.ts) imports this
 * file's registration — a static import here back into the orchestrator
 * would be circular. subagent-context.js has no such dependency (it only
 * imports the Task type), so it's a plain static import.
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import type { AgentMode } from "../agents/system-prompts.js";
import {
  getCurrentSubagentContext,
  getSubagentDepth,
} from "../agents/subagent-context.js";

const VALID_MODES: AgentMode[] = ["code", "debug", "test", "review", "plan"];

export const spawnSubagentTool: ToolDefinition = {
  name: "spawn_subagent",
  description:
    "Delegate part of the current task to one or more fresh sub-agents, run in sequence, each in a focused mode (code/debug/test/review/plan). Use this to decompose a genuinely complex, multi-part task rather than trying to hold the whole thing in one turn. Each sub-agent starts with a clean context (it does not see your conversation history) and returns only a text summary of what it did. Sub-agents cannot run shell commands or spawn further sub-agents.",
  parameters: {
    subtasks: {
      type: "array",
      description:
        'Ordered list of subtasks to run in sequence, stopping at the first failure. Each item: { "mode": "code"|"debug"|"test"|"review"|"plan", "description": "..." }',
      required: true,
    },
  },
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const rawSubtasks = params.subtasks;
      if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
        return {
          success: false,
          output: "spawn_subagent requires a non-empty `subtasks` array.",
        };
      }

      const subtasks = rawSubtasks.map((s) => {
        const entry = s as { mode?: string; description?: string };
        const mode = VALID_MODES.includes(entry.mode as AgentMode)
          ? (entry.mode as AgentMode)
          : "code";
        return { mode, description: String(entry.description ?? "") };
      });

      const ctx = getCurrentSubagentContext();
      if (!ctx) {
        return {
          success: false,
          output: "spawn_subagent called outside of an active agent task.",
        };
      }

      const { getParallelOrchestrator } =
        await import("../orchestrator/ParallelOrchestrator.js");
      const orchestrator = getParallelOrchestrator();
      const result = await orchestrator.executePipeline(
        ctx.parentTask,
        subtasks,
        ctx.parentToolNames,
        getSubagentDepth(),
      );

      return { success: result.success, output: result.output };
    } catch (error) {
      return {
        success: false,
        output: `spawn_subagent failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};
