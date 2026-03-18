/**
 * Task Manager - Handles task lifecycle, IDs, and output directories
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { v4 as uuid } from "uuid";
import {
  getSystemCapabilities,
  type SystemCapabilities,
} from "./system-analyzer.js";
import { getConfigManager } from "./config.js";

export interface TaskContext {
  id: string;
  description: string;
  outputDir: string;
  createdAt: Date;
  status: "pending" | "running" | "completed" | "failed";
  systemCapabilities: SystemCapabilities;
  metadata: Record<string, unknown>;
}

export interface TaskMetadata {
  id: string;
  description: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  duration?: number;
  agentType?: string;
  success?: boolean;
  outputDir: string;
  error?: string;
}

export class TaskManager {
  private currentTask: TaskContext | null = null;
  private tasksDir: string;
  private outputBaseDir: string;

  constructor() {
    const config = getConfigManager().get();
    this.outputBaseDir = config.defaults.outputDir || "output";
    this.tasksDir = join(this.outputBaseDir, ".tasks");
    this.ensureTasksDir();
  }

  private ensureTasksDir(): void {
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
    }
    if (!existsSync(this.outputBaseDir)) {
      mkdirSync(this.outputBaseDir, { recursive: true });
    }
  }

  createTask(
    description: string,
    metadata?: Record<string, unknown>,
  ): TaskContext {
    const taskId = this.generateTaskId();
    const systemCaps = getSystemCapabilities();

    const taskDir = join(this.outputBaseDir, taskId);
    mkdirSync(taskDir, { recursive: true });

    const task: TaskContext = {
      id: taskId,
      description,
      outputDir: taskDir,
      createdAt: new Date(),
      status: "pending",
      systemCapabilities: systemCaps,
      metadata: {
        ...metadata,
        systemStatus: systemCaps.status,
        recommendedMaxAgents: systemCaps.recommendedMaxAgents,
      },
    };

    this.currentTask = task;
    this.saveTaskMetadata(task);

    return task;
  }

  private generateTaskId(): string {
    const timestamp = Date.now().toString(36);
    const shortUuid = uuid().slice(0, 8);
    return `task_${timestamp}_${shortUuid}`;
  }

  private saveTaskMetadata(task: TaskContext): void {
    const meta: TaskMetadata = {
      id: task.id,
      description: task.description,
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      outputDir: task.outputDir,
    };

    const metaPath = join(this.tasksDir, `${task.id}.json`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  updateTaskStatus(
    status: TaskContext["status"],
    additionalMetadata?: Partial<TaskMetadata>,
  ): void {
    if (!this.currentTask) return;

    this.currentTask.status = status;

    const metaPath = join(this.tasksDir, `${this.currentTask.id}.json`);
    if (existsSync(metaPath)) {
      const existing = JSON.parse(readFileSync(metaPath, "utf-8"));
      const updated: TaskMetadata = {
        ...existing,
        status,
        ...additionalMetadata,
        completedAt:
          status === "completed" || status === "failed"
            ? new Date().toISOString()
            : undefined,
      };
      writeFileSync(metaPath, JSON.stringify(updated, null, 2), "utf-8");
    }
  }

  getCurrentTask(): TaskContext | null {
    return this.currentTask;
  }

  getTaskOutputDir(): string {
    return this.currentTask?.outputDir || this.outputBaseDir;
  }

  getTaskId(): string | null {
    return this.currentTask?.id || null;
  }

  completeTask(success: boolean, error?: string): void {
    if (!this.currentTask) return;

    this.updateTaskStatus(success ? "completed" : "failed", {
      success,
      error,
      duration: Date.now() - this.currentTask.createdAt.getTime(),
    });
  }

  getSystemCapabilities(): SystemCapabilities {
    return getSystemCapabilities();
  }

  listTasks(): TaskMetadata[] {
    if (!existsSync(this.tasksDir)) {
      return [];
    }

    const { readdirSync } = require("fs");
    const files = readdirSync(this.tasksDir).filter((f: string) =>
      f.endsWith(".json"),
    );

    return files
      .map((file: string) => {
        const content = readFileSync(join(this.tasksDir, file), "utf-8");
        return JSON.parse(content);
      })
      .sort(
        (a: TaskMetadata, b: TaskMetadata) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  getTask(taskId: string): TaskMetadata | null {
    const metaPath = join(this.tasksDir, `${taskId}.json`);
    if (!existsSync(metaPath)) {
      return null;
    }
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  }
}

let taskManagerInstance: TaskManager | null = null;

export function getTaskManager(): TaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager();
  }
  return taskManagerInstance;
}
