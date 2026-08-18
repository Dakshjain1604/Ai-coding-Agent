/**
 * Subagent Context - a small side-channel so the `spawn_subagent` tool can
 * see which task/agent is currently executing without threading extra
 * parameters through every tool handler's signature.
 *
 * Tool handlers only receive `params`, not the calling BaseAgent's context
 * (see BaseAgent.executeTool()). Rather than restructure that signature
 * project-wide, UniversalAgent.execute() pushes its own {task, tool set}
 * onto this stack before running its tool loop and pops it when done. This
 * is safe under the current execution model because tool calls (and nested
 * sub-agent runs) are always awaited sequentially, never run concurrently
 * with each other — a plain stack correctly tracks arbitrary nesting depth.
 */

import type { Task } from "../../utils/types.js";

export interface SubagentContext {
  /** The task currently being executed by the agent that pushed this frame. */
  parentTask: Task;
  /** Tool names available to that agent — used to narrow a spawned child's tool set. */
  parentToolNames: string[];
}

const contextStack: SubagentContext[] = [];

export function pushSubagentContext(ctx: SubagentContext): void {
  contextStack.push(ctx);
}

export function popSubagentContext(): void {
  contextStack.pop();
}

/** Returns the innermost (currently executing) agent's context, if any. */
export function getCurrentSubagentContext(): SubagentContext | undefined {
  return contextStack[contextStack.length - 1];
}

/** Current nesting depth — 0 at the top level, incremented per active pushed frame. */
export function getSubagentDepth(): number {
  return contextStack.length;
}
