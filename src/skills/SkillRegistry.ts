/**
 * Skill Registry - Central registry for managing skills
 * Handles skill loading, discovery, and execution
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getLogger } from "../utils/logger.js";
import { getSkillLoader, SkillLoader } from "./SkillLoader.js";
import type {
  Skill,
  SkillMatch,
  SkillResult,
  SkillExecutionContext,
} from "./types.js";

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private logger = getLogger();
  private loader: SkillLoader;
  private projectSkillsDir: string;
  private builtinSkillsDir: string;

  constructor(projectRoot?: string) {
    this.loader = getSkillLoader();
    this.projectSkillsDir = join(
      projectRoot || process.cwd(),
      ".claude",
      "skills",
    );
    this.builtinSkillsDir = join(process.cwd(), "src", "skills", "built-in");
  }

  async initialize(): Promise<void> {
    this.loadBuiltinSkills();
    this.loadProjectSkills();
    this.logger.info(
      `SkillRegistry initialized with ${this.skills.size} skills`,
    );
  }

  private loadBuiltinSkills(): void {
    if (!existsSync(this.builtinSkillsDir)) {
      this.logger.debug(
        `Builtin skills directory not found: ${this.builtinSkillsDir}`,
      );
      return;
    }

    const skills = this.loader.loadFromDirectory(
      this.builtinSkillsDir,
      "markdown",
    );

    for (const skill of skills) {
      this.skills.set(skill.name, skill);
      this.logger.debug(`Loaded builtin skill: ${skill.name}`);
    }
  }

  private loadProjectSkills(): void {
    if (!existsSync(this.projectSkillsDir)) {
      try {
        mkdirSync(this.projectSkillsDir, { recursive: true });
        this.logger.debug(
          `Created project skills directory: ${this.projectSkillsDir}`,
        );
      } catch {
        this.logger.warn(
          `Could not create project skills directory: ${this.projectSkillsDir}`,
        );
        return;
      }
    }

    const skills = this.loader.loadFromDirectory(
      this.projectSkillsDir,
      "markdown",
    );

    for (const skill of skills) {
      this.skills.set(skill.name, skill);
      this.logger.debug(`Loaded project skill: ${skill.name}`);
    }
  }

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
    this.logger.debug(`Registered skill: ${skill.name}`);
  }

  unregister(name: string): boolean {
    const deleted = this.skills.delete(name);
    if (deleted) {
      this.logger.debug(`Unregistered skill: ${name}`);
    }
    return deleted;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  findByTrigger(input: string): Skill | null {
    return this.loader.matchSkill(input, this.getAll());
  }

  findTopMatches(
    input: string,
    limit = 3,
  ): Array<{ skill: Skill; score: number }> {
    return this.loader.findTopMatches(input, this.getAll(), limit);
  }

  async execute(
    name: string,
    context: SkillExecutionContext,
  ): Promise<SkillResult> {
    const skill = this.skills.get(name);

    if (!skill) {
      return {
        success: false,
        output: `Skill not found: ${name}`,
        error: "Skill not registered",
      };
    }

    return this.executeSkill(skill, context);
  }

  async executeByTrigger(
    input: string,
    context: SkillExecutionContext,
  ): Promise<SkillResult> {
    const skill = this.findByTrigger(input);

    if (!skill) {
      return {
        success: false,
        output: `No matching skill found for: ${input}`,
        error: "No matching skill",
      };
    }

    return this.executeSkill(skill, { ...context, input });
  }

  private async executeSkill(
    skill: Skill,
    context: SkillExecutionContext,
  ): Promise<SkillResult> {
    this.logger.info(`Executing skill: ${skill.name}`);

    try {
      const output = await this.executeInstructions(
        skill.instructions,
        context,
      );

      return {
        success: true,
        output,
        artifacts: [],
      };
    } catch (error) {
      this.logger.error(
        `Skill execution failed: ${skill.name}`,
        error as Error,
      );

      return {
        success: false,
        output: "",
        error: skill.errorHandling || (error as Error).message,
      };
    }
  }

  private async executeInstructions(
    instructions: string[],
    context: SkillExecutionContext,
  ): Promise<string> {
    const results: string[] = [];

    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i];
      this.logger.debug(
        `Executing instruction ${i + 1}/${instructions.length}: ${instruction.substring(0, 50)}...`,
      );

      results.push(`[${i + 1}] ${instruction}`);
    }

    return results.join("\n");
  }

  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  getSkillCount(): number {
    return this.skills.size;
  }

  clear(): void {
    this.skills.clear();
  }

  reload(): void {
    this.skills.clear();
    this.loadBuiltinSkills();
    this.loadProjectSkills();
    this.logger.info(`SkillRegistry reloaded with ${this.skills.size} skills`);
  }
}

let skillRegistryInstance: SkillRegistry | null = null;

export function getSkillRegistry(projectRoot?: string): SkillRegistry {
  if (!skillRegistryInstance) {
    skillRegistryInstance = new SkillRegistry(projectRoot);
  }
  return skillRegistryInstance;
}

export function createSkillRegistry(projectRoot?: string): SkillRegistry {
  return new SkillRegistry(projectRoot);
}
