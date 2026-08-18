/**
 * Core type definitions for CodingAgent
 */

// ============================================================================
// Task Types
// ============================================================================

export type TaskComplexity = "simple" | "medium" | "complex";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: string;
  description: string;
  complexity: TaskComplexity;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
  subtasks?: Task[];
  /** Scored independently from complexity — see TaskAnalyzer.analyzeRiskFactors(). */
  risk?: "low" | "medium" | "high";
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  artifacts?: string[];
  durationMs: number;
  agentType: AgentType;
}

// ============================================================================
// Agent Types
// ============================================================================

export type AgentType =
  | "orchestrator"
  | "plan"
  | "code"
  | "test"
  | "debug"
  | "review";

export interface AgentConfig {
  type: AgentType;
  model: string;
  maxTokens: number;
  tools: string[];
  maxIterations: number;
  timeout: number;
  maxToolCalls?: number;
  maxCost?: number;
}

export interface AgentState {
  id: string;
  type: AgentType;
  status: "idle" | "running" | "completed" | "failed";
  currentTask?: Task;
  startTime?: Date;
  endTime?: Date;
  result?: TaskResult;
}

export interface SpawnStrategy {
  mode: "single" | "pipeline" | "parallel";
  agents: AgentType[];
  maxParallel: number;
}

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType =
  | "ollama"
  | "claude"
  | "openai"
  | "gemini"
  | "local"
  | "groq"
  | "openrouter"
  | "huggingface"
  | "ollama-cloud";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  models: {
    simple?: string;
    code?: string;
    complex?: string;
  };
  enabled: boolean;
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  name: string;
  params: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  tools?: ToolSchema[];
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

// ============================================================================
// Skill Types
// ============================================================================

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  steps: SkillStep[];
  tools: string[];
  config?: Record<string, unknown>;
}

export interface SkillStep {
  action: string;
  params?: Record<string, unknown>;
  condition?: string;
}

// ============================================================================
// Hook Types
// ============================================================================

export type HookType =
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-agent-spawn"
  | "post-agent-complete";

export interface HookDefinition {
  type: HookType;
  name: string;
  handler: string;
  enabled: boolean;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  execute: string;
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Config Types
// ============================================================================

export interface AppConfig {
  providers: ProviderConfig[];
  agents: Record<AgentType, AgentConfig>;
  defaults: {
    preferLocal: boolean;
    fallbackToPaid: boolean;
    maxParallelAgents: number;
    complexityThreshold: number;
    maxPaidApiCalls: number;
    outputDir: string;
    streaming: boolean;
  };
  [key: string]: unknown;
}

// ============================================================================
// Error Types
// ============================================================================

export class CodingAgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodingAgentError";
  }
}

export class ProviderError extends CodingAgentError {
  constructor(
    message: string,
    provider: ProviderType,
    details?: Record<string, unknown>,
  ) {
    super(message, "PROVIDER_ERROR", { provider, ...details });
    this.name = "ProviderError";
  }
}

export class AgentError extends CodingAgentError {
  constructor(
    message: string,
    agentType: AgentType,
    details?: Record<string, unknown>,
  ) {
    super(message, "AGENT_ERROR", { agentType, ...details });
    this.name = "AgentError";
  }
}

export class MemoryError extends CodingAgentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "MEMORY_ERROR", details);
    this.name = "MemoryError";
  }
}
