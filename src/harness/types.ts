/**
 * Harness core types.
 *
 * The transcript is the single source of truth for what the model has seen
 * and done. It is append-only and lossless: assistant turns keep their tool
 * calls (with ids and raw argument strings) and any provider reasoning
 * payload, and every tool result is linked to the call that produced it.
 * Provider adapters serialize this faithfully instead of flattening it to
 * text — a flattened history is what made the previous agent re-run
 * commands and rewrite files it had already written.
 */

export interface ToolCallRecord {
  id: string;
  name: string;
  /** Exactly as the model produced it — may be invalid JSON; the executor reports that back. */
  arguments: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls: ToolCallRecord[];
  /** Opaque provider reasoning state (e.g. OpenRouter `reasoning_details`), echoed back on later requests. */
  reasoningDetails?: unknown[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** JSON-Schema description of a tool, as sent to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
}

export interface JsonSchemaProperty {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Provider-reported USD cost, when the provider returns it. */
  costUsd?: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export interface ModelTurn {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage: TokenUsage;
  /** Model id that actually served the request. */
  servedBy: string;
  /** Upstream inference provider, when the router reports it (e.g. OpenRouter's "Nvidia"). */
  upstream?: string;
  latencyMs: number;
  /** Time to first streamed chunk of any kind. */
  firstChunkMs: number;
  /** Total HTTP attempts, including retries. */
  attempts: number;
}

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

/** What the loop needs from a model — implemented by ModelClient, faked in tests. */
export interface ChatModel {
  readonly id: string;
  limits(): Promise<ModelLimits>;
  complete(
    messages: Message[],
    tools: ToolSpec[],
    options: CompleteOptions,
  ): Promise<ModelTurn>;
}

export interface CompleteOptions {
  /** Epoch ms after which no new attempt or backoff sleep is started. */
  deadline: number;
  maxOutputTokens: number;
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  category: string;
  waitMs: number;
  message: string;
}

/**
 * A model call that failed for good. `category` comes from the failure
 * classifier and tells the agent loop whether it can recover by changing
 * the conversation (invalid_model_output, context_overflow) or must stop.
 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly attempts: number,
    /** For rejected model output: what the model generated, when the provider returns it. */
    readonly rejectedGeneration?: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}
