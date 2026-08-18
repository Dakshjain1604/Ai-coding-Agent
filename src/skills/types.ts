/**
 * Skill Types - Type definitions for the skills system
 */

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  purpose: string;
  instructions: string[];
  tools: string[];
  constraints: string[];
  examples?: SkillExample[];
  errorHandling?: string;
}

export interface SkillExample {
  input: string;
  output: string;
}

export interface SkillMatch {
  skill: Skill;
  score: number;
  matchedTrigger: string;
}

export type SkillLoaderMode = "markdown" | "yaml";

export interface SkillDefinition {
  name: string;
  description?: string;
  triggers?: string[];
  purpose?: string;
  instructions?: string[];
  tools?: string[];
  constraints?: string[];
  examples?: Array<{ input: string; output: string }>;
  errorHandling?: string;
}
