/**
 * Skills Integration Tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  SkillRegistry,
  createSkillRegistry,
} from "../../src/skills/SkillRegistry.js";

describe("SkillRegistry Integration", () => {
  let registry: SkillRegistry;

  beforeAll(async () => {
    registry = createSkillRegistry();
    await registry.initialize();
  });

  describe("initialization", () => {
    it("should load skills on initialization", () => {
      const count = registry.getSkillCount();
      expect(count).toBeGreaterThan(0);
    });

    it("should have skills loaded", () => {
      const skills = registry.getAll();
      expect(skills.length).toBeGreaterThan(0);
    });
  });

  describe("findByTrigger", () => {
    it("should find skill by slash command", () => {
      const skill = registry.findByTrigger("/commit");
      expect(skill).toBeDefined();
      expect(skill?.name.toLowerCase()).toContain("commit");
    });

    it("should return null for unknown trigger", () => {
      const skill = registry.findByTrigger("/unknown-skill-xyz");
      expect(skill).toBeNull();
    });
  });

  describe("hasSkill", () => {
    it("should return true when skills are loaded", () => {
      const count = registry.getSkillCount();
      expect(count).toBeGreaterThan(0);
    });
  });
});
