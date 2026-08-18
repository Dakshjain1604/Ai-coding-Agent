/**
 * Orchestrator Module Exports
 *
 * PlanManager and ResultSynthesizer were retired (Wiring Audit fix #6) —
 * both were 100% unreferenced outside their own files. Multi-agent
 * decomposition now happens via ParallelOrchestrator, exposed to the agent
 * loop as the `spawn_subagent` tool (see core/tools/subagent-tool.ts),
 * rather than a separate CLI-level orchestration path.
 */

import { TaskAnalyzer, createTaskAnalyzer } from "./TaskAnalyzer.js";
import type { AnalysisResult, AnalysisFactor } from "./TaskAnalyzer.js";

import {
  AgentSpawner,
  createAgentSpawner,
  executeTask,
} from "./AgentSpawner.js";
import type { SpawnedAgent, SpawnOptions } from "./AgentSpawner.js";

import {
  ParallelOrchestrator,
  getParallelOrchestrator,
} from "./ParallelOrchestrator.js";
import type { SubTaskPlan } from "./ParallelOrchestrator.js";

export { TaskAnalyzer, createTaskAnalyzer };
export type { AnalysisResult, AnalysisFactor };

export { AgentSpawner, createAgentSpawner, executeTask };
export type { SpawnedAgent, SpawnOptions };

export { ParallelOrchestrator, getParallelOrchestrator };
export type { SubTaskPlan };

// Singleton instances
let taskAnalyzerInstance: TaskAnalyzer | null = null;
let agentSpawnerInstance: AgentSpawner | null = null;

/**
 * Get the TaskAnalyzer singleton
 */
export function getTaskAnalyzer(complexityThreshold?: number): TaskAnalyzer {
  if (!taskAnalyzerInstance) {
    taskAnalyzerInstance = createTaskAnalyzer(complexityThreshold);
  }
  return taskAnalyzerInstance;
}

/**
 * Get the AgentSpawner singleton
 */
export function getAgentSpawner(maxParallel?: number): AgentSpawner {
  if (!agentSpawnerInstance) {
    agentSpawnerInstance = createAgentSpawner(maxParallel);
  }
  return agentSpawnerInstance;
}
