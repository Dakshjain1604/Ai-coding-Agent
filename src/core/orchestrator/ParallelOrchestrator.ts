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
   *
   * `parentToolNames` distinguishes two real callers with different
   * meanings, NOT interchangeable:
   *  - subagent-tool.ts (spawn_subagent) always passes a real live
   *    parent's actual tool names — an empty array there genuinely means
   *    "this parent has zero tools," and narrowing to zero is the correct,
   *    fail-closed security behavior (a child can never exceed its
   *    parent's granted capabilities).
   *  - AgentSpawner.executeTask()'s direct pipeline path (a task that
   *    TaskAnalyzer classified as multi-stage) has NO real parent agent at
   *    all — it's the root of execution, not a child of anything. Passing
   *    `[]` there used to trigger the SAME fail-closed narrowing and
   *    silently strip every tool from every pipeline stage. Confirmed
   *    live: a 3-stage plan→code→test pipeline's 'code' stage received
   *    ZERO tools, the model still attempted a file_write call anyway
   *    (driven by its own training plus the system prompt's "Available
   *    tools: ..." text), and Groq's API hard-rejected the resulting
   *    call with 400 "Parsing failed" / "Tool choice is none, but model
   *    called a tool" since there was no `tools` schema to validate it
   *    against — every top-level pipeline run failed this way, not just
   *    an edge case. `undefined` (the default) means "no real parent —
   *    skip narrowing entirely," which is what AgentSpawner's call site
   *    now passes.
   */
  public async executePipeline(
    parentTask: Task,
    subtasks: SubTaskPlan[],
    parentToolNames?: string[],
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
      if (parentToolNames !== undefined) {
        this.narrowChildTools(agent, parentToolNames);
      }

      // Exclude the parent task's own `mode` from the spread — the parent
      // might have been run with an explicit --mode, and blindly
      // inheriting that into the subtask's metadata would silently
      // override this subtask's intended `plan.mode` the moment
      // UniversalAgent.execute() sees a non-"auto" task.metadata.mode
      // (which always wins over the mode already pinned at construction).
      // Confirmed live: a parent run with --mode=code spawning a "test"
      // subtask would otherwise execute that subtask in "code" mode.
      const { mode: _parentMode, ...parentMetadataWithoutMode } =
        parentTask.metadata ?? {};

      const subTask: Task = {
        id: crypto.randomUUID ? crypto.randomUUID() : `sub_${Date.now()}_${i}`,
        description: `${plan.description}\n\nContext from previous steps:\n${this.boundedContext(results)}`,
        complexity: parentTask.complexity,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { ...parentMetadataWithoutMode, subagentDepth: depth + 1 },
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
   * Joins prior subtasks' accumulated output for the next subtask's
   * context, capped so a long pipeline of large outputs can't grow a
   * later subtask's description unboundedly. Keeps the most RECENT
   * results (truncates from the front) since those are usually most
   * relevant to what comes next.
   */
  private boundedContext(results: string[]): string {
    const MAX_CONTEXT_CHARS = 16000;
    const joined = results.join("\n\n");
    if (joined.length <= MAX_CONTEXT_CHARS) return joined;
    return (
      `...[earlier subtask output truncated to prevent unbounded context growth]...\n\n` +
      joined.slice(joined.length - MAX_CONTEXT_CHARS)
    );
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
    // Fails closed: an empty parentToolNames means "parent has zero known
    // tools", so the child gets zero additional tools too — never the
    // reverse. This method must only be called when there IS a real
    // parent to narrow against (see executePipeline's caller-distinction
    // comment above) — a genuinely top-level pipeline run with no parent
    // agent at all must skip calling this entirely, not call it with `[]`,
    // or every stage silently loses every tool (confirmed live: this was
    // a real, previously-shipped bug, not just a hypothetical one).
    const parentSet = new Set(parentToolNames);
    for (const tool of agent.getTools()) {
      const allowed = !CHILD_RESTRICTED_TOOLS.has(tool.name) && parentSet.has(tool.name);
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
