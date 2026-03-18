/**
 * Hook Types - Type definitions for the hooks system
 */

export type HookEvent =
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-agent-execute"
  | "post-agent-execute"
  | "pre-task-execute"
  | "post-task-execute"
  | "on-error"
  | "on-plan-update"
  | "on-memory-store"
  | "on-context-compact";

export interface HookContext {
  event: HookEvent;
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface HookResult {
  success: boolean;
  modifiedData?: Record<string, unknown>;
  error?: string;
  skip?: boolean;
}

export interface Hook {
  name: string;
  event: HookEvent;
  description: string;
  handler: (context: HookContext) => Promise<HookResult | void>;
  priority?: number;
}

export interface HookConfig {
  enabled: boolean;
  timeout?: number;
  failOnError?: boolean;
}
