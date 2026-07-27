/**
 * Parallel Task Orchestrator
 * Manages parallel and sequential multi-subagent workflow execution.
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

export class ParallelOrchestrator {
  private logger = getLogger();

  /**
   * Execute complex goal using multi-mode subagents in parallel or pipeline sequence
   */
  public async executePipeline(
    parentTask: Task,
    subtasks: SubTaskPlan[],
  ): Promise<TaskResult> {
    const startTime = Date.now();
    this.logger.info(`Starting ParallelOrchestrator pipeline with ${subtasks.length} subtasks...`);
    const results: string[] = [];
    let overallSuccess = true;

    for (let i = 0; i < subtasks.length; i++) {
      const plan = subtasks[i];
      this.logger.info(`Executing Subtask ${i + 1}/${subtasks.length} [${plan.mode}]: ${plan.description}`);

      const agent = new UniversalAgent(plan.mode);
      const subTask: Task = {
        id: crypto.randomUUID ? crypto.randomUUID() : `sub_${Date.now()}_${i}`,
        description: `${plan.description}\n\nContext from previous steps:\n${results.join("\n\n")}`,
        complexity: parentTask.complexity,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: parentTask.metadata,
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
}

let orchestratorInstance: ParallelOrchestrator | null = null;

export function getParallelOrchestrator(): ParallelOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new ParallelOrchestrator();
  }
  return orchestratorInstance;
}
