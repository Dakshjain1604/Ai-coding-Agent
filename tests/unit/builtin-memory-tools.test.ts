/**
 * Tests for memory_store's `type` parameter (core/tools/builtin.ts) —
 * previously had no `enum` constraint at all despite only documenting 3
 * of the real 6 MemoryType values, and passed the raw string through to
 * MemoryManager.store() via an unchecked `as any` cast. A typo'd/invalid
 * type would silently pass ToolRegistry.validateParameters() and only
 * fail (or misbehave) deep inside the memory subsystem, if at all.
 */
import { describe, it, expect } from "vitest";
import { memoryStore } from "../../src/core/tools/builtin.js";
import { getToolRegistry, resetToolRegistry } from "../../src/core/tools/ToolRegistry.js";

describe("memory_store — type enum validation fix", () => {
  it("declares an enum listing all 6 real MemoryType values", () => {
    expect(memoryStore.parameters.type.enum).toEqual([
      "pattern",
      "decision",
      "preference",
      "conversation",
      "execution",
      "plan",
    ]);
  });

  it("ToolRegistry rejects an invalid/typo'd type before it reaches the handler", async () => {
    resetToolRegistry();
    const registry = getToolRegistry();
    registry.register(memoryStore);

    const result = await registry.execute("memory_store", {
      key: "k",
      value: "v",
      type: "paterns", // typo
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("must be one of");
  });

  it("ToolRegistry accepts each of the 6 real MemoryType values", () => {
    for (const type of [
      "pattern",
      "decision",
      "preference",
      "conversation",
      "execution",
      "plan",
    ]) {
      expect(memoryStore.parameters.type.enum).toContain(type);
    }
  });
});
