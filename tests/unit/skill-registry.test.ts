/**
 * Tests for SkillRegistry (skills/SkillRegistry.ts) — previously only
 * touched incidentally by tests/integration/skills.test.ts.
 *
 * Also removed dead code this pass: execute()/executeByTrigger()/
 * executeSkill()/executeInstructions() (plus the SkillResult/
 * SkillExecutionContext types that only they used) were an unreachable
 * legacy execution model — interactive.ts's real skill-matching path
 * (handleRequest()) already documents skills as "prompt injections, not
 * autonomous executors" and only ever calls findByTrigger(). The removed
 * executeInstructions() never even used its `context` parameter or
 * interpreted an instruction — it just echoed each instruction string
 * back as a numbered list, which is not "executing" anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Skill } from "../../src/skills/types.js";

const { existsSyncMock, mkdirSyncMock, loadFromDirectoryMock, matchSkillMock, findTopMatchesMock } =
  vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    loadFromDirectoryMock: vi.fn(),
    matchSkillMock: vi.fn(),
    findTopMatchesMock: vi.fn(),
  }));

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

vi.mock("../../src/skills/SkillLoader.js", () => ({
  getSkillLoader: () => ({
    loadFromDirectory: (...args: unknown[]) => loadFromDirectoryMock(...args),
    matchSkill: (...args: unknown[]) => matchSkillMock(...args),
    findTopMatches: (...args: unknown[]) => findTopMatchesMock(...args),
  }),
}));

import { createSkillRegistry } from "../../src/skills/SkillRegistry.js";

function makeSkill(overrides?: Partial<Skill>): Skill {
  return {
    name: "test-skill",
    description: "A test skill",
    triggers: ["test"],
    purpose: "testing",
    instructions: ["do a thing"],
    tools: [],
    constraints: [],
    ...overrides,
  };
}

beforeEach(() => {
  existsSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  loadFromDirectoryMock.mockReset();
  matchSkillMock.mockReset();
  findTopMatchesMock.mockReset();
  loadFromDirectoryMock.mockReturnValue([]);
  existsSyncMock.mockReturnValue(true);
});

describe("SkillRegistry — initialize()", () => {
  it("loads both builtin and project skills into the registry", async () => {
    loadFromDirectoryMock
      .mockReturnValueOnce([makeSkill({ name: "builtin-1" })])
      .mockReturnValueOnce([makeSkill({ name: "project-1" })]);
    const registry = createSkillRegistry("/fake/project");
    await registry.initialize();
    expect(registry.getSkillCount()).toBe(2);
    expect(registry.hasSkill("builtin-1")).toBe(true);
    expect(registry.hasSkill("project-1")).toBe(true);
  });

  it("skips loading builtin skills when the builtin directory doesn't exist", async () => {
    existsSyncMock.mockImplementation((path: string) => !String(path).includes("built-in"));
    const registry = createSkillRegistry("/fake/project");
    await registry.initialize();
    // loadFromDirectory should only have been called for the project dir
    expect(loadFromDirectoryMock).toHaveBeenCalledTimes(1);
  });

  it("creates the project skills directory when it doesn't exist", async () => {
    existsSyncMock.mockImplementation((path: string) => String(path).includes("built-in"));
    const registry = createSkillRegistry("/fake/project");
    await registry.initialize();
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("skills"),
      { recursive: true },
    );
  });

  it("does not throw and simply skips project skills if directory creation fails", async () => {
    existsSyncMock.mockImplementation((path: string) => String(path).includes("built-in"));
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const registry = createSkillRegistry("/fake/project");
    await expect(registry.initialize()).resolves.toBeUndefined();
  });

  it("a project skill with the same name as a builtin skill overrides it", async () => {
    loadFromDirectoryMock
      .mockReturnValueOnce([makeSkill({ name: "shared", description: "builtin version" })])
      .mockReturnValueOnce([makeSkill({ name: "shared", description: "project version" })]);
    const registry = createSkillRegistry("/fake/project");
    await registry.initialize();
    expect(registry.get("shared")?.description).toBe("project version");
  });
});

describe("SkillRegistry — register/unregister/get/getAll", () => {
  it("register() adds a skill retrievable by get()", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "manual" }));
    expect(registry.get("manual")?.name).toBe("manual");
  });

  it("register() with an existing name overwrites it", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "x", description: "first" }));
    registry.register(makeSkill({ name: "x", description: "second" }));
    expect(registry.get("x")?.description).toBe("second");
    expect(registry.getSkillCount()).toBe(1);
  });

  it("unregister() removes a skill and returns true", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "x" }));
    expect(registry.unregister("x")).toBe(true);
    expect(registry.hasSkill("x")).toBe(false);
  });

  it("unregister() returns false for a name that was never registered", () => {
    const registry = createSkillRegistry();
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("get() returns undefined for an unregistered skill", () => {
    const registry = createSkillRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("getAll() returns every registered skill", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "a" }));
    registry.register(makeSkill({ name: "b" }));
    expect(registry.getAll().map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("getAll() returns an empty array when nothing is registered", () => {
    expect(createSkillRegistry().getAll()).toEqual([]);
  });
});

describe("SkillRegistry — findByTrigger / findTopMatches (delegate to SkillLoader)", () => {
  it("findByTrigger() delegates to the loader with the current skill list", () => {
    const registry = createSkillRegistry();
    const skill = makeSkill({ name: "s" });
    registry.register(skill);
    matchSkillMock.mockReturnValue(skill);

    const result = registry.findByTrigger("run s please");
    expect(matchSkillMock).toHaveBeenCalledWith("run s please", [skill]);
    expect(result).toBe(skill);
  });

  it("findByTrigger() returns null when the loader finds no match", () => {
    matchSkillMock.mockReturnValue(null);
    expect(createSkillRegistry().findByTrigger("nothing matches")).toBeNull();
  });

  it("findTopMatches() delegates to the loader with the given limit", () => {
    const registry = createSkillRegistry();
    const skill = makeSkill({ name: "s" });
    registry.register(skill);
    findTopMatchesMock.mockReturnValue([{ skill, score: 0.9 }]);

    const result = registry.findTopMatches("query", 5);
    expect(findTopMatchesMock).toHaveBeenCalledWith("query", [skill], 5);
    expect(result).toEqual([{ skill, score: 0.9 }]);
  });

  it("findTopMatches() defaults limit to 3 when not specified", () => {
    findTopMatchesMock.mockReturnValue([]);
    createSkillRegistry().findTopMatches("query");
    expect(findTopMatchesMock).toHaveBeenCalledWith("query", [], 3);
  });
});

describe("SkillRegistry — hasSkill/getSkillCount/clear/reload", () => {
  it("hasSkill() reflects registration state", () => {
    const registry = createSkillRegistry();
    expect(registry.hasSkill("x")).toBe(false);
    registry.register(makeSkill({ name: "x" }));
    expect(registry.hasSkill("x")).toBe(true);
  });

  it("getSkillCount() reflects the number of registered skills", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "a" }));
    registry.register(makeSkill({ name: "b" }));
    expect(registry.getSkillCount()).toBe(2);
  });

  it("clear() removes every registered skill", () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill({ name: "a" }));
    registry.clear();
    expect(registry.getSkillCount()).toBe(0);
  });

  it("reload() clears and re-loads from both directories", async () => {
    loadFromDirectoryMock.mockReturnValue([]);
    const registry = createSkillRegistry("/fake/project");
    registry.register(makeSkill({ name: "manual-only" }));
    expect(registry.getSkillCount()).toBe(1);

    loadFromDirectoryMock
      .mockReturnValueOnce([makeSkill({ name: "reloaded" })])
      .mockReturnValueOnce([]);
    registry.reload();
    expect(registry.hasSkill("manual-only")).toBe(false);
    expect(registry.hasSkill("reloaded")).toBe(true);
  });
});

describe("SkillRegistry — createSkillRegistry vs getSkillRegistry singleton", () => {
  it("createSkillRegistry() always returns a fresh, independent instance", () => {
    const a = createSkillRegistry();
    const b = createSkillRegistry();
    expect(a).not.toBe(b);
    a.register(makeSkill({ name: "only-in-a" }));
    expect(b.hasSkill("only-in-a")).toBe(false);
  });
});
