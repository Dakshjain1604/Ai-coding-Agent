/**
 * Validation Tests
 */

import { describe, it, expect } from "vitest";
import { TaskSchema, isValid, isTask } from "../../src/utils/validation.js";

describe("TaskSchema", () => {
  it("should validate a valid task", () => {
    const task = {
      description: "Test task",
      complexity: "medium" as const,
      status: "pending" as const,
    };

    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
  });

  it("should reject task without description", () => {
    const task = {
      complexity: "medium" as const,
    };

    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(false);
  });

  it("should set default values", () => {
    const task = {
      description: "Test task",
    };

    const result = TaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    expect(result.data?.complexity).toBe("medium");
    expect(result.data?.status).toBe("pending");
  });
});

describe("isTask", () => {
  it("should return true for valid task", () => {
    const task = {
      description: "Test task",
      complexity: "simple" as const,
    };
    expect(isTask(task)).toBe(true);
  });

  it("should return false for invalid task", () => {
    const task = {
      description: "",
    };
    expect(isTask(task)).toBe(false);
  });
});

describe("isValid", () => {
  it("should validate data against schema", () => {
    const data = { description: "test" };
    const result = isValid(TaskSchema as any, data);
    expect(result).toBe(true);
  });
});
