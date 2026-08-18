/**
 * Skill Loader - Loads and parses skill definitions from files
 * Supports both markdown and YAML formats
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";
import { getLogger } from "../utils/logger.js";
import type { Skill, SkillDefinition, SkillLoaderMode } from "./types.js";

export class SkillLoader {
  private logger = getLogger();

  loadFromFile(
    filePath: string,
    mode: SkillLoaderMode = "markdown",
  ): Skill | null {
    if (!existsSync(filePath)) {
      this.logger.warn(`Skill file not found: ${filePath}`);
      return null;
    }

    try {
      const content = readFileSync(filePath, "utf-8");

      switch (mode) {
        case "markdown":
          return this.parseMarkdown(content, basename(filePath, ".md"));
        case "yaml":
          return this.parseYaml(content);
        default:
          this.logger.warn(`Unknown skill loader mode: ${mode}`);
          return null;
      }
    } catch (error) {
      this.logger.error(
        `Failed to load skill from ${filePath}`,
        error as Error,
      );
      return null;
    }
  }

  /**
   * Loads every .md/.yaml/.yml file in dirPath, auto-detecting each
   * file's format from its own extension — there used to be a `mode`
   * parameter here too, but it was never actually read; every caller
   * always passed "markdown" and the function ignored it regardless,
   * always auto-detecting per file. Removed as dead, misleading API
   * surface rather than kept unused.
   */
  loadFromDirectory(dirPath: string): Skill[] {
    const skills: Skill[] = [];

    if (!existsSync(dirPath)) {
      this.logger.warn(`Skills directory not found: ${dirPath}`);
      return skills;
    }

    const files = readdirSync(dirPath);
    for (const file of files) {
      if (
        !file.endsWith(".md") &&
        !file.endsWith(".yaml") &&
        !file.endsWith(".yml")
      ) {
        continue;
      }

      const fileMode =
        file.endsWith(".yaml") || file.endsWith(".yml") ? "yaml" : "markdown";
      const skill = this.loadFromFile(join(dirPath, file), fileMode);

      if (skill) {
        skills.push(skill);
      }
    }

    this.logger.debug(`Loaded ${skills.length} skills from ${dirPath}`);
    return skills;
  }

  private parseMarkdown(content: string, filename: string): Skill {
    const sections = this.parseMarkdownSections(content);

    return {
      name: sections["#"] || this.extractNameFromFilename(filename),
      description: sections["description"] || "",
      triggers: this.parseList(
        sections["trigger"] || sections["triggers"] || "",
      ),
      purpose: sections["purpose"] || sections["Purpose"] || "",
      instructions: this.parseInstructions(
        sections["instructions"] ||
          sections["Instructions"] ||
          sections["workflow"] ||
          sections["Workflow"] ||
          "",
      ),
      tools: this.parseList(
        sections["tools required"] ||
          sections["Tools Required"] ||
          sections["tools"] ||
          "",
      ),
      constraints: this.parseList(
        sections["constraints"] || sections["Constraints"] || "",
      ),
      examples: this.parseExamples(
        sections["examples"] || sections["Examples"] || "",
      ),
      errorHandling:
        sections["error handling"] ||
        sections["Error Handling"] ||
        sections["error"] ||
        "",
    };
  }

  private parseYaml(content: string): Skill {
    try {
      const data = yaml.load(content) as SkillDefinition;

      return {
        name: data.name,
        description: data.description || "",
        triggers: data.triggers || [],
        purpose: data.purpose || "",
        instructions: data.instructions || [],
        tools: data.tools || [],
        constraints: data.constraints || [],
        examples: data.examples?.map((e) => ({
          input: e.input,
          output: e.output,
        })),
        errorHandling: data.errorHandling || "",
      };
    } catch (error) {
      this.logger.error("Failed to parse YAML skill", error as Error);
      throw error;
    }
  }

  private parseMarkdownSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const lines = content.split("\n");

    let currentSection = "";
    let currentContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        if (currentSection) {
          sections[currentSection] = currentContent.join("\n").trim();
        }
        currentSection = headingMatch[2].toLowerCase().trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections[currentSection] = currentContent.join("\n").trim();
    }

    return sections;
  }

  private parseList(content: string): string[] {
    return content
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }

  private parseInstructions(content: string): string[] {
    const instructions: string[] = [];
    const lines = content.split("\n");
    let currentInstruction = "";

    for (const line of lines) {
      const stepMatch = line.match(/^(\d+)[.)\]]?\s*(.+)$/);

      if (stepMatch) {
        if (currentInstruction) {
          instructions.push(currentInstruction.trim());
        }
        currentInstruction = stepMatch[2].trim();
      } else if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
        if (currentInstruction) {
          currentInstruction += " " + line.replace(/^[-*]\s*/, "").trim();
        }
      } else if (line.trim()) {
        currentInstruction += " " + line.trim();
      }
    }

    if (currentInstruction) {
      instructions.push(currentInstruction.trim());
    }

    return instructions;
  }

  private parseExamples(
    content: string,
  ): Array<{ input: string; output: string }> {
    const examples: Array<{ input: string; output: string }> = [];
    const sections = content.split(/(?=^###\s+Input)/m);

    for (const section of sections) {
      const inputMatch = section.match(/^###\s+Input\s*\n```\n([\s\S]*?)```/);
      const outputMatch = section.match(/^###\s+Output\s*\n```\n([\s\S]*?)```/);

      if (inputMatch && outputMatch) {
        examples.push({
          input: inputMatch[1].trim(),
          output: outputMatch[1].trim(),
        });
      }
    }

    return examples;
  }

  private extractNameFromFilename(filename: string): string {
    return filename
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  matchSkill(input: string, skills: Skill[]): Skill | null {
    const inputLower = input.toLowerCase();

    for (const skill of skills) {
      for (const trigger of skill.triggers) {
        if (trigger.startsWith("/")) {
          if (inputLower.startsWith(trigger.toLowerCase())) {
            return skill;
          }
        } else if (trigger.startsWith("pattern:")) {
          const regex = new RegExp(trigger.replace("pattern:", ""), "i");
          if (regex.test(input)) {
            return skill;
          }
        } else if (inputLower.includes(trigger.toLowerCase())) {
          return skill;
        }
      }
    }

    return null;
  }

  findTopMatches(
    input: string,
    skills: Skill[],
    limit = 3,
  ): Array<{ skill: Skill; score: number }> {
    const inputLower = input.toLowerCase();
    const matches: Array<{ skill: Skill; score: number }> = [];

    for (const skill of skills) {
      let score = 0;

      for (const trigger of skill.triggers) {
        if (trigger.startsWith("/")) {
          if (inputLower.startsWith(trigger.toLowerCase())) {
            score = 100;
          }
        } else if (inputLower.includes(trigger.toLowerCase())) {
          score = Math.max(score, 50);
        }
      }

      if (skill.description) {
        const descWords = skill.description.toLowerCase().split(/\s+/);
        const inputWords = inputLower.split(/\s+/);
        const overlap = inputWords.filter((w) => descWords.includes(w)).length;
        score = Math.max(score, overlap * 10);
      }

      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

let skillLoaderInstance: SkillLoader | null = null;

export function getSkillLoader(): SkillLoader {
  if (!skillLoaderInstance) {
    skillLoaderInstance = new SkillLoader();
  }
  return skillLoaderInstance;
}
