/**
 * Tests for TaskManager (utils/task-manager.ts) — previously zero test
 * coverage, despite being the source of getTaskOutputDir(), which the
 * path-traversal fix in file-system.ts's resolveOutputPath() depends on
 * directly. Also covers the resetTaskManager() export added this phase
 * (mirrors resetRollbackManager()'s existing test-seeding pattern).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskManager, getTaskManager, resetTaskManager } from "../../src/utils/task-manager.js";
import { createConfigManager } from "../../src/utils/config.js";

async function withSandbox<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(dir);
  createConfigManager(dir);
  resetTaskManager();
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("TaskManager", () => {
  let dir: string;

  afterEach(() => {
    resetTaskManager();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the output base directory on construction", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      new TaskManager();
      expect(existsSync(join(dir, "output"))).toBe(true);
    });
  });

  it("getTaskOutputDir() returns the base output dir when no task is active", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(tm.getTaskOutputDir()).toBe("output");
    });
  });

  it("createTask() sets a per-task output dir under the base, and getTaskOutputDir() reflects it", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("do something");
      expect(task.outputDir).toBe(join("output", task.id));
      expect(tm.getTaskOutputDir()).toBe(task.outputDir);
      expect(existsSync(task.outputDir)).toBe(true);
    });
  });

  it("createTask() generates a unique id with a task_ prefix", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const a = tm.createTask("a");
      const b = tm.createTask("b");
      expect(a.id).toMatch(/^task_/);
      expect(a.id).not.toBe(b.id);
    });
  });

  it("getTaskId() returns null before any task is created", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(tm.getTaskId()).toBeNull();
    });
  });

  it("getTaskId() returns the current task's id after creation", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("do something");
      expect(tm.getTaskId()).toBe(task.id);
    });
  });

  it("getCurrentTask() returns null before any task is created", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(tm.getCurrentTask()).toBeNull();
    });
  });

  it("persists task metadata to disk and getTask() reads it back", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("described task");
      const meta = tm.getTask(task.id);
      expect(meta).not.toBeNull();
      expect(meta?.description).toBe("described task");
      expect(meta?.status).toBe("pending");
    });
  });

  it("getTask() returns null for a nonexistent task id", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(tm.getTask("task_does_not_exist")).toBeNull();
    });
  });

  it("updateTaskStatus() updates the persisted status", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("do something");
      tm.updateTaskStatus("running");
      expect(tm.getTask(task.id)?.status).toBe("running");
    });
  });

  it("completeTask(true) marks the task completed with success and duration", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("do something");
      tm.completeTask(true);
      const meta = tm.getTask(task.id);
      expect(meta?.status).toBe("completed");
      expect(meta?.success).toBe(true);
      expect(meta?.completedAt).toBeDefined();
    });
  });

  it("completeTask(false, error) marks the task failed with the error message", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const task = tm.createTask("do something");
      tm.completeTask(false, "something broke");
      const meta = tm.getTask(task.id);
      expect(meta?.status).toBe("failed");
      expect(meta?.success).toBe(false);
      expect(meta?.error).toBe("something broke");
    });
  });

  it("completeTask() before any task exists is a safe no-op", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(() => tm.completeTask(true)).not.toThrow();
    });
  });

  it("listTasks() returns an empty array when no tasks exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      expect(tm.listTasks()).toEqual([]);
    });
  });

  it("listTasks() returns all created tasks, most recent first", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const a = tm.createTask("first");
      await new Promise((r) => setTimeout(r, 5));
      const b = tm.createTask("second");

      const tasks = tm.listTasks();
      expect(tasks.length).toBe(2);
      expect(tasks[0].id).toBe(b.id);
      expect(tasks[1].id).toBe(a.id);
    });
  });

  it("getSystemCapabilities() returns a usable capabilities object", async () => {
    dir = mkdtempSync(join(tmpdir(), "task-manager-test-"));
    await withSandbox(dir, async () => {
      const tm = new TaskManager();
      const caps = tm.getSystemCapabilities();
      expect(caps).toBeDefined();
      expect(typeof caps.status).toBe("string");
    });
  });
});

describe("getTaskManager() / resetTaskManager() singleton", () => {
  afterEach(() => {
    resetTaskManager();
  });

  it("returns the same instance across calls", () => {
    const a = getTaskManager();
    const b = getTaskManager();
    expect(a).toBe(b);
  });

  it("resetTaskManager() forces a fresh instance on the next call", () => {
    const a = getTaskManager();
    resetTaskManager();
    const b = getTaskManager();
    expect(a).not.toBe(b);
  });
});
