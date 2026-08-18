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
import { isValidAgentMode } from "../agents/system-prompts.js";
import {
  getCurrentSubagentContext,
  getSubagentDepth,
} from "../agents/subagent-context.js";

/** Caps a single spawn_subagent call's pipeline length — each subtask's
 * description accumulates ALL prior subtasks' full output, so an
 * unbounded subtasks array risks unbounded context growth for later
 * subtasks in the same pipeline. */
const MAX_SUBTASKS_PER_PIPELINE = 10;

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
      if (rawSubtasks.length > MAX_SUBTASKS_PER_PIPELINE) {
        return {
          success: false,
          output: `spawn_subagent: ${rawSubtasks.length} subtasks requested, but a single pipeline is capped at ${MAX_SUBTASKS_PER_PIPELINE} — each subtask's context accumulates every prior subtask's full output, so a longer chain risks unbounded growth. Split this into multiple spawn_subagent calls or reduce the subtask count.`,
        };
      }

      // Validate each entry explicitly rather than trusting a blind cast —
      // a malformed entry (null, a bare string, a missing description)
      // used to surface as a raw JS TypeError message that gave the model
      // no way to tell which entry was wrong or how to fix it.
      const malformedIndexes: number[] = [];
      const subtasks = rawSubtasks
        .map((s, i) => {
          if (typeof s !== "object" || s === null) {
            malformedIndexes.push(i);
            return null;
          }
          const entry = s as { mode?: string; description?: string };
          const description = String(entry.description ?? "").trim();
          if (!description) {
            malformedIndexes.push(i);
            return null;
          }
          const mode: AgentMode = isValidAgentMode(entry.mode) ? entry.mode : "code";
          return { mode, description };
        })
        .filter((s): s is { mode: AgentMode; description: string } => s !== null);

      if (subtasks.length === 0) {
        return {
          success: false,
          output:
            "spawn_subagent: every entry in `subtasks` was malformed (missing or empty `description`). Each entry must be an object like " +
            '{ "mode": "code", "description": "..." } with a non-empty description.',
        };
      }
      if (malformedIndexes.length > 0) {
        return {
          success: false,
          output: `spawn_subagent: subtasks at index ${malformedIndexes.join(", ")} are missing a valid \`description\` — fix or remove them and try again. Each entry must be an object like { "mode": "code", "description": "..." }.`,
        };
      }

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
