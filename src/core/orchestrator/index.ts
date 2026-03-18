/**
 * Orchestrator Module Exports
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
  ResultSynthesizer,
  createResultSynthesizer,
} from "./ResultSynthesizer.js";
import type {
  SynthesisOptions,
  SynthesisResult,
  Conflict,
} from "./ResultSynthesizer.js";

import { PlanManager, createPlanManager } from "./PlanManager.js";
import type { Plan, PlanStep, PlanProgress } from "./PlanManager.js";

export { TaskAnalyzer, createTaskAnalyzer };
export type { AnalysisResult, AnalysisFactor };

export { AgentSpawner, createAgentSpawner, executeTask };
export type { SpawnedAgent, SpawnOptions };

export { ResultSynthesizer, createResultSynthesizer };
export type { SynthesisOptions, SynthesisResult, Conflict };

export { PlanManager, createPlanManager };
export type { Plan as ExecutionPlan, PlanStep as ExecutionStep, PlanProgress };

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
