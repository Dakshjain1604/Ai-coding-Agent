/**
 * Validation utilities for CodingAgent
 * Provides Zod schemas and validation helpers
 */

import { z } from "zod";

// ============================================================================
// Task Validation
// ============================================================================

const TaskSchemaBase = z.object({
  id: z.string().uuid().optional(),
  description: z.string().min(1).max(10000),
  complexity: z.enum(["simple", "medium", "complex"]).default("medium"),
  status: z
    .enum(["pending", "in_progress", "completed", "failed"])
    .default("pending"),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const TaskSchema: z.ZodType<{
  id?: string;
  description: string;
  complexity?: "simple" | "medium" | "complex";
  status?: "pending" | "in_progress" | "completed" | "failed";
  createdAt?: Date;
  updatedAt?: Date;
  metadata?: Record<string, unknown>;
  subtasks?: Array<{
    id?: string;
    description: string;
    complexity?: "simple" | "medium" | "complex";
    status?: "pending" | "in_progress" | "completed" | "failed";
    createdAt?: Date;
    updatedAt?: Date;
    metadata?: Record<string, unknown>;
  }>;
}> = TaskSchemaBase.extend({
  subtasks: z.array(TaskSchemaBase).optional(),
});

export const TaskResultSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  output: z.string(),
  artifacts: z.array(z.string()).optional(),
  durationMs: z.number().positive(),
  agentType: z.enum([
    "orchestrator",
    "plan",
    "code",
    "test",
    "debug",
    "review",
  ]),
});

// ============================================================================
// Agent Validation
// ============================================================================

export const AgentTypeSchema = z.enum([
  "orchestrator",
  "plan",
  "code",
  "test",
  "debug",
  "review",
]);

export const AgentConfigSchema = z.object({
  type: AgentTypeSchema,
  model: z.string().min(1),
  maxTokens: z.number().int().positive().max(200000).default(128000),
  tools: z.array(z.string()).default([]),
  maxIterations: z.number().int().positive().default(50),
  timeout: z.number().int().positive().default(300000),
});

// ============================================================================
// Provider Validation
// ============================================================================

export const ProviderTypeSchema = z.enum([
  "ollama",
  "claude",
  "openai",
  "gemini",
  "local",
]);

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z
    .object({
      simple: z.string().optional(),
      code: z.string().optional(),
      complex: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
});

export const CompletionOptionsSchema = z.object({
  model: z.string().optional(),
  maxTokens: z.number().int().positive().max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
});

// ============================================================================
// Memory Validation
// ============================================================================

export const MemoryEntrySchema = z.object({
  id: z.string(),
  type: z.enum([
    "pattern",
    "decision",
    "preference",
    "conversation",
    "execution",
  ]),
  content: z.string(),
  metadata: z.record(z.unknown()),
  embedding: z.array(z.number()).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ContextWindowSchema = z.object({
  id: z.string(),
  maxSize: z.number().int().positive(),
  currentSize: z.number().int().nonnegative(),
  entries: z.array(MemoryEntrySchema),
  summary: z.string().optional(),
});

// ============================================================================
// Skill Validation
// ============================================================================

export const SkillStepSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  condition: z.string().optional(),
});

export const SkillDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  triggers: z.array(z.string()).min(1),
  steps: z.array(SkillStepSchema).min(1),
  tools: z.array(z.string()).default([]),
  config: z.record(z.unknown()).optional(),
});

// ============================================================================
// Hook Validation
// ============================================================================

export const HookTypeSchema = z.enum([
  "pre-tool-use",
  "post-tool-use",
  "pre-agent-spawn",
  "post-agent-complete",
]);

export const HookDefinitionSchema = z.object({
  type: HookTypeSchema,
  name: z.string().min(1),
  handler: z.string().min(1),
  enabled: z.boolean().default(true),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate data against a Zod schema, returning typed result or throwing
 */
export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context?: string,
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");

    throw new Error(
      context
        ? `Validation error in ${context}: ${errors}`
        : `Validation error: ${errors}`,
    );
  }

  return result.data;
}

/**
 * Safely validate data, returning null on failure
 */
export function safeValidate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Check if data matches schema without throwing
 */
export function isValid<T>(schema: z.ZodSchema<T>, data: unknown): boolean {
  return schema.safeParse(data).success;
}

/**
 * Create a partial schema for updates
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function partial(schema: z.ZodObject<any>): any {
  return schema.partial();
}

// ============================================================================
// Type Guards
// ============================================================================

export function isTask(data: unknown): data is z.infer<typeof TaskSchema> {
  return isValid(TaskSchema, data);
}

export function isAgentType(
  value: string,
): value is z.infer<typeof AgentTypeSchema> {
  return AgentTypeSchema.safeParse(value).success;
}

export function isProviderType(
  value: string,
): value is z.infer<typeof ProviderTypeSchema> {
  return ProviderTypeSchema.safeParse(value).success;
}
