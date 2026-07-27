import { describe, it, expect, beforeEach } from "vitest";
import { ContextWindowManager } from "../../src/memory/ContextWindow.js";

describe("ContextWindow Memory Management", () => {
  let contextWindow: ContextWindowManager;

  beforeEach(() => {
    contextWindow = new ContextWindowManager({
      maxSize: 1000,
      compactionThreshold: 0.7,
      reservedTokens: 100,
    });
  });

  it("should initialize context window with configured thresholds", () => {
    expect(contextWindow.getSize()).toBe(0);
    expect(contextWindow.isEmpty()).toBe(true);
  });

  it("should calculate remaining capacity accurately", () => {
    contextWindow.add(
      {
        id: "m1",
        type: "conversation",
        content: "Hello",
        metadata: {},
        createdAt: new Date(),
      },
      200,
    );

    expect(contextWindow.getSize()).toBe(200);
    expect(contextWindow.getRemainingCapacity()).toBe(700); // 1000 - 200 - 100 reserved
  });

  it("should trigger compaction when threshold is exceeded", () => {
    contextWindow.add(
      {
        id: "m1",
        type: "conversation",
        content: "Entry 1",
        metadata: {},
        createdAt: new Date(),
      },
      600,
      1,
    );

    // Adding 200 brings total to 800 > 700 threshold => compacts existing items
    contextWindow.add(
      {
        id: "m2",
        type: "conversation",
        content: "Entry 2",
        metadata: {},
        createdAt: new Date(),
      },
      200,
      2,
    );

    expect(contextWindow.getSize()).toBeLessThanOrEqual(500);
  });
});
