/**
 * HookManager Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HookManager } from "../../src/hooks/HookManager.js";
import type { Hook, HookContext } from "../../src/hooks/types.js";

describe("HookManager", () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  describe("register", () => {
    it("should register a hook", () => {
      const hook: Hook = {
        name: "test-hook",
        event: "pre-tool-use",
        description: "Test hook",
        handler: async () => ({ success: true }),
      };

      manager.register(hook);
      const hooks = manager.getHooks("pre-tool-use");
      expect(hooks.length).toBe(1);
      expect(hooks[0].name).toBe("test-hook");
    });

    it("should sort hooks by priority", () => {
      const hook1: Hook = {
        name: "low-priority",
        event: "pre-tool-use",
        description: "Low priority",
        priority: 10,
        handler: async () => ({ success: true }),
      };

      const hook2: Hook = {
        name: "high-priority",
        event: "pre-tool-use",
        description: "High priority",
        priority: 100,
        handler: async () => ({ success: true }),
      };

      manager.register(hook1);
      manager.register(hook2);

      const hooks = manager.getHooks("pre-tool-use");
      expect(hooks[0].name).toBe("high-priority");
    });
  });

  describe("unregister", () => {
    it("should unregister a hook", () => {
      const hook: Hook = {
        name: "test-hook",
        event: "pre-tool-use",
        description: "Test hook",
        handler: async () => ({ success: true }),
      };

      manager.register(hook);
      const result = manager.unregister("test-hook");
      expect(result).toBe(true);
      expect(manager.getHooks("pre-tool-use").length).toBe(0);
    });

    it("should return false for non-existent hook", () => {
      const result = manager.unregister("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("execute", () => {
    it("should execute hooks for an event", async () => {
      let executed = false;

      const hook: Hook = {
        name: "test-hook",
        event: "pre-tool-use",
        description: "Test hook",
        handler: async () => {
          executed = true;
          return { success: true };
        },
      };

      manager.register(hook);
      const result = await manager.execute("pre-tool-use", {
        toolName: "test",
      });

      expect(executed).toBe(true);
      expect(result.success).toBe(true);
    });

    it("should skip execution when disabled", async () => {
      let executed = false;

      const hook: Hook = {
        name: "test-hook",
        event: "pre-tool-use",
        description: "Test hook",
        handler: async () => {
          executed = true;
          return { success: true };
        },
      };

      manager.register(hook);
      manager.disable();

      const result = await manager.execute("pre-tool-use", {
        toolName: "test",
      });

      expect(executed).toBe(false);
      expect(result.success).toBe(true);
    });

    it("should handle hook errors gracefully", async () => {
      const hook: Hook = {
        name: "error-hook",
        event: "pre-tool-use",
        description: "Error hook",
        handler: async () => {
          throw new Error("Hook error");
        },
      };

      manager.register(hook);
      const result = await manager.execute("pre-tool-use", {
        toolName: "test",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("clear", () => {
    it("should clear all hooks for an event", () => {
      const hook: Hook = {
        name: "test-hook",
        event: "pre-tool-use",
        description: "Test hook",
        handler: async () => ({ success: true }),
      };

      manager.register(hook);
      manager.clear("pre-tool-use");

      expect(manager.getHooks("pre-tool-use").length).toBe(0);
    });

    it("should clear all hooks when no event specified", () => {
      const hook1: Hook = {
        name: "hook1",
        event: "pre-tool-use",
        description: "Hook 1",
        handler: async () => ({ success: true }),
      };

      const hook2: Hook = {
        name: "hook2",
        event: "post-tool-use",
        description: "Hook 2",
        handler: async () => ({ success: true }),
      };

      manager.register(hook1);
      manager.register(hook2);
      manager.clear();

      expect(manager.getHooks("pre-tool-use").length).toBe(0);
      expect(manager.getHooks("post-tool-use").length).toBe(0);
    });
  });
});
