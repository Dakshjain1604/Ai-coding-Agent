/**
 * Parallel Task Orchestrator
 *
 * Manages sequential multi-subagent workflow execution — this is the
 * mechanism behind the `spawn_subagent` tool (core/tools/subagent-tool.ts).
 * A sub-agent is a fresh UniversalAgent instance, depth-limited and with a
 * tool set narrower than its parent's, returning only a text summary. It
 * deliberately does not share the parent's conversation history or memory
 * session — see Wiring Audit fix #6 / Best-of-Four piece F.
 */

import { UniversalAgent } from "../agents/UniversalAgent.js";
import type { AgentMode } from "../agents/system-prompts.js";
import type { Task, TaskResult } from "../../utils/types.js";
import { getLogger } from "../../utils/logger.js";
import crypto from "crypto";

export interface SubTaskPlan {
  mode: AgentMode;
  description: string;
}

/** Sub-agents can themselves spawn sub-agents, up to this many levels deep. */
export const MAX_SUBAGENT_DEPTH = 2;

/**
 * Tools a spawned child is never granted, regardless of what its parent had.
 * shell_exec is withheld as a blast-radius limit on unsupervised delegation;
 * spawn_subagent is withheld so depth limiting can't be bypassed by a child
 * that simply doesn't know its own current depth.
 */
const CHILD_RESTRICTED_TOOLS = new Set(["shell_exec", "spawn_subagent"]);

export class ParallelOrchestrator {
  private logger = getLogger();

  /**
   * Execute a sequence of subtasks, each as a fresh, permission-narrowed
   * child agent. Stops at the first failure. `depth` is the nesting level
   * of the *caller* (0 for a top-level agent); this call runs at depth+1.
   */
  public async executePipeline(
    parentTask: Task,
    subtasks: SubTaskPlan[],
    parentToolNames: string[] = [],
    depth: number = 0,
  ): Promise<TaskResult> {
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return {
        taskId: parentTask.id,
        success: false,
        output: `Sub-agent depth limit (${MAX_SUBAGENT_DEPTH}) reached — refusing to spawn further nested sub-agents. Complete the remaining work directly instead of delegating further.`,
        durationMs: 0,
        agentType: "orchestrator",
      };
    }

    const startTime = Date.now();
    this.logger.info(
      `Starting ParallelOrchestrator pipeline (depth ${depth + 1}/${MAX_SUBAGENT_DEPTH}) with ${subtasks.length} subtasks...`,
    );
    const results: string[] = [];
    let overallSuccess = true;

    for (let i = 0; i < subtasks.length; i++) {
      const plan = subtasks[i];
      this.logger.info(
        `Executing Subtask ${i + 1}/${subtasks.length} [${plan.mode}]: ${plan.description}`,
      );

      const agent = new UniversalAgent(plan.mode);
      this.narrowChildTools(agent, parentToolNames);

      const subTask: Task = {
        id: crypto.randomUUID ? crypto.randomUUID() : `sub_${Date.now()}_${i}`,
        description: `${plan.description}\n\nContext from previous steps:\n${results.join("\n\n")}`,
        complexity: parentTask.complexity,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { ...parentTask.metadata, subagentDepth: depth + 1 },
      };

      const res = await agent.execute(subTask);
      if (!res.success) {
        overallSuccess = false;
        results.push(`[Subtask ${i + 1} FAILED]: ${res.output}`);
        break;
      } else {
        results.push(`[Subtask ${i + 1} PASSED (${plan.mode})]: ${res.output}`);
      }
    }

    return {
      taskId: parentTask.id,
      success: overallSuccess,
      output: results.join("\n\n---\n\n"),
      durationMs: Date.now() - startTime,
      agentType: "orchestrator",
    };
  }

  /**
   * Restrict a freshly-spawned child's tool set to the intersection of its
   * own mode's tools and its parent's tools, minus the always-restricted
   * set — a child can never have more capability than its parent granted it.
   */
  private narrowChildTools(
    agent: UniversalAgent,
    parentToolNames: string[],
  ): void {
    const parentSet = new Set(parentToolNames);
    for (const tool of agent.getTools()) {
      const allowed =
        !CHILD_RESTRICTED_TOOLS.has(tool.name) &&
        (parentToolNames.length === 0 || parentSet.has(tool.name));
      if (!allowed) {
        agent.unregisterTool(tool.name);
      }
    }
  }
}

let orchestratorInstance: ParallelOrchestrator | null = null;

export function getParallelOrchestrator(): ParallelOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new ParallelOrchestrator();
  }
  return orchestratorInstance;
}
