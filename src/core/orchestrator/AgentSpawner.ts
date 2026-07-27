/**
 * Agent Spawner - Dynamically creates and manages agent instances
 */

import { getLogger } from "../../utils/logger.js";
import type {
  Task,
  TaskResult,
  AgentType,
  AgentConfig,
  AgentState,
  SpawnStrategy,
} from "../../utils/types.js";
import type { BaseAgent } from "../agents/BaseAgent.js";
import { UniversalAgent } from "../agents/UniversalAgent.js";
import { getConfigManager } from "../../utils/config.js";
import { getSystemAnalyzer } from "../../utils/system-analyzer.js";
import { getTaskManager } from "../../utils/task-manager.js";

export interface SpawnedAgent {
  id: string;
  type: AgentType;
  agent: BaseAgent;
  task: Task;
  startTime: Date;
  status: "pending" | "running" | "completed" | "failed";
  result?: TaskResult;
}

export interface SpawnOptions {
  maxParallel?: number;
  timeout?: number;
  onProgress?: (agentId: string, progress: number, message: string) => void;
  onComplete?: (agentId: string, result: TaskResult) => void;
  onError?: (agentId: string, error: Error) => void;
}

/**
 * Agent Spawner
 * Manages agent creation and lifecycle with system-aware configuration
 */
export class AgentSpawner {
  private agents: Map<string, SpawnedAgent> = new Map();
  private agentFactories: Map<AgentType, () => Promise<BaseAgent>>;
  private maxParallel: number;
  private logger = getLogger();

  constructor(maxParallel?: number) {
    const systemCaps = getSystemAnalyzer().analyze();
    this.maxParallel = maxParallel ?? systemCaps.recommendedMaxAgents;
    this.agentFactories = new Map();
    this.registerAgentFactories();
  }

  /**
   * Get system-adaptive spawn options
   */
  getSpawnOptions(overrides?: SpawnOptions): SpawnOptions {
    const systemCaps = getSystemAnalyzer().analyze();
    const config = getConfigManager().get();

    return {
      maxParallel: Math.min(
        overrides?.maxParallel ?? this.maxParallel,
        systemCaps.recommendedMaxAgents,
        config.defaults.maxParallelAgents,
      ),
      timeout:
        overrides?.timeout ??
        (systemCaps.status === "critical" ? 120000 : 300000),
      onProgress: overrides?.onProgress,
      onComplete: overrides?.onComplete,
      onError: overrides?.onError,
    };
  }

  /**
   * Spawn a single agent
   */
  async spawn(
    type: AgentType,
    task: Task,
    config?: Partial<AgentConfig>,
  ): Promise<SpawnedAgent> {
    const taskManager = getTaskManager();
    const systemCaps = getSystemAnalyzer().analyze();

    const currentAgents = this.getAllSpawned().filter(
      (a) => a.status === "running",
    ).length;
    if (currentAgents >= this.maxParallel) {
      this.logger.warn(
        `System at capacity: ${currentAgents}/${this.maxParallel} agents running`,
      );
      throw new Error(
        `System at capacity. Maximum ${this.maxParallel} parallel agents allowed.`,
      );
    }

    const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    this.logger.agentSpawn(type, task.id);

    // Create agent
    const agent = await this.createAgent(type, config);

    const spawned: SpawnedAgent = {
      id,
      type,
      agent,
      task,
      startTime: new Date(),
      status: "pending",
    };

    this.agents.set(id, spawned);
    return spawned;
  }

  /**
   * Spawn multiple agents based on strategy
   */
  async spawnWithStrategy(
    strategy: SpawnStrategy,
    task: Task,
    options?: SpawnOptions,
  ): Promise<SpawnedAgent[]> {
    const results: SpawnedAgent[] = [];

    switch (strategy.mode) {
      case "single":
        // Single agent
        results.push(await this.spawn(strategy.agents[0], task));
        break;

      case "pipeline":
        // Sequential execution
        for (const agentType of strategy.agents) {
          const spawned = await this.spawn(agentType, task);
          results.push(spawned);
        }
        break;

      case "parallel": {
        // Parallel execution with limit
        const agentsToSpawn = strategy.agents.slice(0, strategy.maxParallel);
        const spawnPromises = agentsToSpawn.map((type) =>
          this.spawn(type, task),
        );
        results.push(...(await Promise.all(spawnPromises)));
        break;
      }
    }

    return results;
  }

  /**
   * Execute a spawned agent
   */
  async execute(
    spawnedId: string,
    options?: SpawnOptions,
  ): Promise<TaskResult> {
    const spawned = this.agents.get(spawnedId);
    if (!spawned) {
      throw new Error(`Agent not found: ${spawnedId}`);
    }

    spawned.status = "running";
    const startTime = Date.now();

    try {
      // Execute with timeout
      const timeout =
        options?.timeout ?? spawned.agent["config"].timeout ?? 300000;
      const result = await this.executeWithTimeout(spawned, timeout, options);

      spawned.status = "completed";
      spawned.result = result;

      const duration = Date.now() - startTime;
      this.logger.agentComplete(spawned.type, spawned.task.id, duration);

      options?.onComplete?.(spawnedId, result);
      return result;
    } catch (error) {
      spawned.status = "failed";
      const err = error instanceof Error ? error : new Error("Unknown error");

      const result: TaskResult = {
        taskId: spawned.task.id,
        success: false,
        output: err.message,
        durationMs: Date.now() - startTime,
        agentType: spawned.type,
      };

      spawned.result = result;
      options?.onError?.(spawnedId, err);

      this.logger.agentError(spawned.type, spawned.task.id, err);
      return result;
    }
  }

  /**
   * Execute multiple spawned agents in parallel
   */
  async executeParallel(
    spawnedIds: string[],
    options?: SpawnOptions,
  ): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();

    // Execute with concurrency limit
    const executing: Promise<void>[] = [];
    const queue = [...spawnedIds];

    const processNext = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;

        const result = await this.execute(id, options);
        results.set(id, result);
      }
    };

    // Start parallel executions
    const concurrency = Math.min(this.maxParallel, spawnedIds.length);
    for (let i = 0; i < concurrency; i++) {
      executing.push(processNext());
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Execute spawned agents in a pipeline (sequential)
   */
  async executePipeline(
    spawnedIds: string[],
    options?: SpawnOptions,
  ): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>();

    for (const id of spawnedIds) {
      const result = await this.execute(id, options);
      results.set(id, result);

      // Stop pipeline on failure unless continueOnError
      if (!result.success) {
        this.logger.warn(`Pipeline stopped due to failure: ${id}`);
        break;
      }
    }

    return results;
  }

  /**
   * Get spawned agent by ID
   */
  getSpawned(id: string): SpawnedAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Get all spawned agents
   */
  getAllSpawned(): SpawnedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get spawned agents by status
   */
  getSpawnedByStatus(status: SpawnedAgent["status"]): SpawnedAgent[] {
    return this.getAllSpawned().filter((s) => s.status === status);
  }

  /**
   * Destroy a spawned agent
   */
  destroy(id: string): void {
    this.agents.delete(id);
    this.logger.debug(`Agent destroyed: ${id}`);
  }

  /**
   * Destroy all spawned agents
   */
  destroyAll(): void {
    this.agents.clear();
    this.logger.debug("All agents destroyed");
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private registerAgentFactories(): void {
    const agentModes: AgentType[] = [
      "code",
      "debug",
      "test",
      "review",
      "plan",
      "orchestrator",
    ];

    for (const mode of agentModes) {
      this.agentFactories.set(mode, async () => {
        const agent = new UniversalAgent();
        if (mode === "orchestrator") {
          agent.setMode("plan");
        } else if (mode !== "code") {
          agent.setMode(mode as "debug" | "test" | "review" | "plan");
        }
        return agent;
      });
    }
  }

  private async createAgent(
    type: AgentType,
    config?: Partial<AgentConfig>,
  ): Promise<BaseAgent> {
    const factory = this.agentFactories.get(type);
    if (!factory) {
      throw new Error(`Unknown agent type: ${type}`);
    }

    const agent = await factory();

    // Apply config overrides if provided
    if (config) {
      Object.assign(agent["config"], config);
    }

    return agent;
  }

  private async executeWithTimeout(
    spawned: SpawnedAgent,
    timeout: number,
    options?: SpawnOptions,
  ): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Agent execution timed out after ${timeout}ms`));
      }, timeout);

      // Progress callback
      const originalReport = spawned.agent["report"].bind(spawned.agent);
      spawned.agent["report"] = (progress: {
        message: string;
        percentage?: number;
      }) => {
        options?.onProgress?.(
          spawned.id,
          progress.percentage ?? 0,
          progress.message,
        );
        originalReport(progress);
      };

      // Execute
      spawned.agent
        .execute(spawned.task)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}

/**
 * Create an AgentSpawner instance
 */
export function createAgentSpawner(maxParallel?: number): AgentSpawner {
  return new AgentSpawner(maxParallel);
}

// Singleton instance
let agentSpawnerInstance: AgentSpawner | null = null;

/**
 * Get the AgentSpawner singleton
 */
export function getAgentSpawner(maxParallel?: number): AgentSpawner {
  if (!agentSpawnerInstance) {
    agentSpawnerInstance = new AgentSpawner(maxParallel);
  }
  return agentSpawnerInstance;
}

/**
 * Execute a task directly with automatic agent selection
 * This is a convenience method that combines analyze + spawn + execute
 */
export async function executeTask(task: Task): Promise<TaskResult> {
  const spawner = getAgentSpawner();

  // Analyze task to determine agent type
  const { getTaskAnalyzer } = await import("./TaskAnalyzer.js");
  const analyzer = getTaskAnalyzer();
  const analysis = analyzer.analyze(task);

  // Determine agent type based on command in metadata or analysis
  let agentType: AgentType = "code";

  if (task.metadata?.command) {
    const commandToAgent: Record<string, AgentType> = {
      debug: "debug",
      test: "test",
      simplify: "code",
      review: "review",
    };
    agentType = commandToAgent[task.metadata.command as string] || "code";
  } else if (analysis.suggestedStrategy.agents.length > 0) {
    agentType = analysis.suggestedStrategy.agents[0];
  }

  // Spawn and execute
  const spawned = await spawner.spawn(agentType, task);
  return spawner.execute(spawned.id);
}
