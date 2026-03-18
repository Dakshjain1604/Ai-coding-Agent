/**
 * SkillLoader Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SkillLoader } from "../../src/skills/SkillLoader.js";

describe("SkillLoader", () => {
  let loader: SkillLoader;

  beforeEach(() => {
    loader = new SkillLoader();
  });

  describe("matchSkill", () => {
    it("should match skill by slash command", () => {
      const skills = [
        {
          name: "commit",
          description: "Create git commit",
          triggers: ["/commit", "/cc"],
          purpose: "",
          instructions: [],
          tools: [],
          constraints: [],
        },
      ];

      const result = loader.matchSkill("/commit", skills);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("commit");
    });

    it("should match skill by natural language", () => {
      const skills = [
        {
          name: "debug",
          description: "Debug issues",
          triggers: ["fix this bug", "debug"],
          purpose: "",
          instructions: [],
          tools: [],
          constraints: [],
        },
      ];

      const result = loader.matchSkill("please debug this", skills);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("debug");
    });

    it("should return null when no match", () => {
      const skills = [
        {
          name: "commit",
          description: "Create git commit",
          triggers: ["/commit"],
          purpose: "",
          instructions: [],
          tools: [],
          constraints: [],
        },
      ];

      const result = loader.matchSkill("/unknown", skills);
      expect(result).toBeNull();
    });
  });

  describe("findTopMatches", () => {
    it("should return top matches sorted by score", () => {
      const skills = [
        {
          name: "commit",
          description: "Create git commit",
          triggers: ["/commit"],
          purpose: "",
          instructions: [],
          tools: [],
          constraints: [],
        },
        {
          name: "debug",
          description: "Debug code issues",
          triggers: ["/debug"],
          purpose: "",
          instructions: [],
          tools: [],
          constraints: [],
        },
      ];

      const results = loader.findTopMatches("/commit", skills, 2);
      expect(results.length).toBe(1);
      expect(results[0].skill.name).toBe("commit");
    });
  });
});
