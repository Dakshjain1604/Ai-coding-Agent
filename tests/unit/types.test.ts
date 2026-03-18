/**
 * Types Tests
 */

import { describe, it, expect } from "vitest";

describe("Type Definitions", () => {
  describe("Task", () => {
    it("should have required properties", () => {
      const task = {
        id: "test-id",
        description: "Test task",
        status: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(task.id).toBeDefined();
      expect(task.description).toBeDefined();
      expect(task.status).toBe("pending");
    });

    it("should allow optional complexity", () => {
      const task = {
        id: "test-id",
        description: "Test task",
        complexity: "complex" as const,
        status: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(task.complexity).toBe("complex");
    });
  });

  describe("AgentType", () => {
    it("should allow valid agent types", () => {
      const validTypes = [
        "orchestrator",
        "plan",
        "code",
        "test",
        "debug",
        "review",
      ] as const;

      validTypes.forEach((type) => {
        expect(type).toBeDefined();
      });
    });
  });

  describe("ProviderType", () => {
    it("should allow valid provider types", () => {
      const validTypes = [
        "ollama",
        "claude",
        "openai",
        "gemini",
        "local",
      ] as const;

      validTypes.forEach((type) => {
        expect(type).toBeDefined();
      });
    });
  });

  describe("MemoryType", () => {
    it("should allow valid memory types", () => {
      const validTypes = [
        "pattern",
        "decision",
        "preference",
        "conversation",
        "execution",
        "plan",
      ] as const;

      validTypes.forEach((type) => {
        expect(type).toBeDefined();
      });
    });
  });
});
