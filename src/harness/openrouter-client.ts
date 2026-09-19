/**
 * OpenRouter chat-completions client — the harness's only model backend.
 *
 * Owns the ONLY retry policy for model calls. The SDK's built-in retries
 * are disabled: a second retry layer hides waits from the trajectory
 * (confirmed live: 290s of silent SDK 429 sleeps) and cannot tell a
 * transient rate limit from an exhausted quota. Every attempt, wait and
 * failure category is reported through `onRetry`.
 *
 * Failures are handled at the level that can fix them:
 *   - transport (rate limit, 5xx, network, stalled stream): resend with backoff;
 *   - conversation (the model's output was rejected, the prompt no longer fits):
 *     raise immediately — resending the identical request cannot succeed, the
 *     agent loop must change the conversation first;
 *   - everything else (auth, exhausted quota, bad request): raise immediately.
 *
 * OpenRouter specifics this relies on:
 *   - upstream failures arrive as a generic "Provider returned error" with the
 *     real cause in `error.metadata.raw`; that detail is folded into the error
 *     message so classification sees it;
 *   - `provider.require_parameters` routes only to upstreams that support
 *     every request parameter (tools, tool_choice), instead of one that
 *     silently ignores tools;
 *   - no `models` fallback list: the requested model is the model that runs.
 *
 * Always streams, so a stalled response is detected (no chunk for
 * `idleTimeoutMs`) and retried instead of hanging until the task deadline.
 * A call is also cut off at the run deadline itself: an idle timer measures
 * gaps between chunks, which a suspended host defeats (confirmed live: a
 * laptop slept mid-stream and a single call spanned 92 minutes, consuming
 * the whole task budget). Hitting the deadline ends the run, so it is never
 * retried.
 */

import OpenAI from "openai";
import { accumulateOpenAIToolCallDeltas } from "../providers/openai-stream-tools.js";
import { classifyFailure } from "../core/agents/failure-classifier.js";
import {
  ModelError,
  type AssistantMessage,
  type ChatModel,
  type CompleteOptions,
  type FinishReason,
  type Message,
  type ModelLimits,
  type ModelTurn,
  type TokenUsage,
  type ToolSpec,
} from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const MODEL_SPEC_PREFIX = "openrouter/";
const DEFAULT_LIMITS: ModelLimits = { contextWindow: 128_000, maxOutputTokens: 16_384 };
const ERROR_DETAIL_CHARS = 1_500;

/** The run's own deadline passed while the model call was in flight; the run is over, so never retried. */
export const DEADLINE_EXCEEDED = "deadline_exceeded";

function deadlineError(elapsedMs: number): ModelError {
  return new ModelError(
    `Model call aborted after ${Math.round(elapsedMs / 1000)}s: the run deadline passed`,
    DEADLINE_EXCEEDED,
    1,
  );
}

/** See the file header: failures fixed by changing the conversation, never by resending it. */
const CONVERSATION_LEVEL_FAILURES = new Set(["invalid_model_output", "context_overflow"]);

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface OpenRouterClientOptions {
  /** "openrouter/<model id>", e.g. "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free". */
  spec: string;
  apiKey?: string;
  maxAttempts?: number;
  idleTimeoutMs?: number;
  /** Explicit limits take precedence over OpenRouter's model metadata. */
  limits?: Partial<ModelLimits>;
  /** Sent as OpenRouter's `reasoning.effort` when set; the model default otherwise. */
  reasoningEffort?: ReasoningEffort;
  /** Injected for tests. */
  client?: Pick<OpenAI, "chat">;
  sleep?: (ms: number) => Promise<void>;
  fetchModelMetadata?: (model: string) => Promise<Partial<ModelLimits> | undefined>;
  now?: () => number;
}

/** Validates "openrouter/<model id>" and returns the model id (which may itself contain slashes). */
export function parseModelSpec(spec: string): string {
  const model = spec.startsWith(MODEL_SPEC_PREFIX) ? spec.slice(MODEL_SPEC_PREFIX.length) : "";
  if (!model) {
    throw new ModelError(
      `Invalid model "${spec}": expected "openrouter/<model id>", e.g. openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`,
      "invalid_request",
      0,
    );
  }
  return model;
}

export class OpenRouterClient implements ChatModel {
  readonly id: string;
  readonly model: string;
  readonly apiKeyEnv = OPENROUTER_API_KEY_ENV;
  private readonly client: Pick<OpenAI, "chat">;
  private readonly maxAttempts: number;
  private readonly idleTimeoutMs: number;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchModelMetadata: (model: string) => Promise<Partial<ModelLimits> | undefined>;
  private readonly limitOverrides: Partial<ModelLimits>;
  private cachedLimits?: ModelLimits;

  constructor(options: OpenRouterClientOptions) {
    this.model = parseModelSpec(options.spec);
    this.id = options.spec;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.reasoningEffort = options.reasoningEffort;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.limitOverrides = options.limits ?? {};
    this.fetchModelMetadata = options.fetchModelMetadata ?? fetchOpenRouterLimits;

    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey ?? process.env[OPENROUTER_API_KEY_ENV];
      if (!apiKey) throw new ModelError(`${OPENROUTER_API_KEY_ENV} is not set`, "auth", 0);
      // maxRetries: 0 — retries are owned by complete(), see the file header.
      this.client = new OpenAI({
        apiKey,
        baseURL: OPENROUTER_BASE_URL,
        maxRetries: 0,
        timeout: 30 * 60_000,
        defaultHeaders: { "X-Title": "CodingAgent" },
      });
    }
  }

  async limits(): Promise<ModelLimits> {
    if (this.cachedLimits) return this.cachedLimits;
    let fetched: Partial<ModelLimits> | undefined;
    try {
      fetched = await this.fetchModelMetadata(this.model);
    } catch {
      fetched = undefined;
    }
    this.cachedLimits = { ...DEFAULT_LIMITS, ...fetched, ...this.limitOverrides };
    return this.cachedLimits;
  }

  async complete(messages: Message[], tools: ToolSpec[], options: CompleteOptions): Promise<ModelTurn> {
    const body = this.buildRequest(messages, tools, options.maxOutputTokens);
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return { ...(await this.streamOnce(body, options.deadline)), attempts: attempt };
      } catch (error) {
        if (error instanceof ModelError && error.category === DEADLINE_EXCEEDED) throw error;
        const message = describeError(error);
        const classified = classifyFailure(Object.assign(new Error(message), { status: statusOf(error) }));
        if (CONVERSATION_LEVEL_FAILURES.has(classified.category)) {
          throw new ModelError(message, classified.category, attempt, rejectedGenerationOf(error));
        }
        if (!classified.retryable || attempt >= this.maxAttempts) {
          throw new ModelError(
            `${message} (${classified.category}, after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
            classified.category,
            attempt,
          );
        }
        const waitMs = retryDelayMs(error, attempt);
        if (this.now() + waitMs >= options.deadline) {
          throw new ModelError(`${message} (${classified.category}; deadline reached before retry)`, classified.category, attempt);
        }
        options.onRetry?.({ attempt, category: classified.category, waitMs, message });
        await this.sleep(waitMs);
      }
    }
  }

  private buildRequest(messages: Message[], tools: ToolSpec[], maxOutputTokens: number) {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(messages),
      max_tokens: maxOutputTokens,
      stream: true,
      usage: { include: true },
      provider: { require_parameters: true },
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort };
    return body;
  }

  private async streamOnce(body: Record<string, unknown>, deadline: number): Promise<Omit<ModelTurn, "attempts">> {
    const started = this.now();
    const abort = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    let stalled = false;
    let deadlineExceeded = false;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, this.idleTimeoutMs);
    };
    // Timers do not fire while the host is suspended, so also compare against
    // the wall clock on every chunk: after a resume the deadline is enforced
    // at once rather than on the next (possibly never) timer tick.
    const abortIfPastDeadline = () => {
      if (this.now() < deadline) return false;
      deadlineExceeded = true;
      abort.abort();
      return true;
    };
    const deadlineTimer = setTimeout(abortIfPastDeadline, Math.max(0, deadline - this.now()));

    let content = "";
    let finishReason: FinishReason = "unknown";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    let servedBy = this.model;
    let upstream: string | undefined;
    let firstChunkMs = -1;
    const reasoningDetails: unknown[] = [];
    const toolCalls = accumulateOpenAIToolCallDeltas();

    try {
      armIdleTimer();
      const stream = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: abort.signal },
      )) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

      for await (const chunk of stream) {
        if (abortIfPastDeadline()) break;
        armIdleTimer();
        if (firstChunkMs < 0) firstChunkMs = this.now() - started;
        const raw = chunk as unknown as { error?: OpenRouterErrorBody; usage?: RawUsage; provider?: string };
        if (raw.error) {
          // Failures after the stream started arrive as an `error` chunk.
          throw Object.assign(new Error(raw.error.message ?? "Provider error mid-stream"), {
            status: typeof raw.error.code === "number" ? raw.error.code : undefined,
            error: raw.error,
          });
        }
        if (chunk.model) servedBy = chunk.model;
        if (raw.provider) upstream = raw.provider;
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta as typeof choice.delta & { reasoning_details?: unknown[] };
          if (delta?.content) content += delta.content;
          if (delta?.tool_calls) toolCalls.absorb(delta.tool_calls);
          if (Array.isArray(delta?.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
          if (choice.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
        }
        if (raw.usage) usage = normalizeUsage(raw.usage);
      }
    } catch (error) {
      if (deadlineExceeded) throw deadlineError(this.now() - started);
      if (stalled) {
        throw new Error(`Response stalled: no data for ${Math.round(this.idleTimeoutMs / 1000)}s (network timeout)`);
      }
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(deadlineTimer);
    }
    if (deadlineExceeded) throw deadlineError(this.now() - started);

    const calls = (toolCalls.finalize() ?? []).map((call, index) => ({
      id: call.id ?? `call_${started}_${index}`,
      name: call.name,
      arguments: call.rawArguments ?? JSON.stringify(call.params),
    }));
    if (calls.length > 0 && finishReason === "unknown") finishReason = "tool_calls";

    const message: AssistantMessage = { role: "assistant", content, toolCalls: calls };
    if (reasoningDetails.length > 0) message.reasoningDetails = reasoningDetails;

    const turn: Omit<ModelTurn, "attempts"> = {
      message,
      finishReason,
      usage,
      servedBy,
      latencyMs: this.now() - started,
      firstChunkMs: Math.max(firstChunkMs, 0),
    };
    if (upstream) turn.upstream = upstream;
    return turn;
  }
}

interface OpenRouterErrorBody {
  message?: string;
  code?: number | string;
  failed_generation?: string;
  metadata?: { raw?: unknown; provider_name?: string };
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

function errorBodyOf(error: unknown): OpenRouterErrorBody | undefined {
  const body = (error as { error?: unknown } | null)?.error;
  return body && typeof body === "object" ? (body as OpenRouterErrorBody) : undefined;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The error message plus OpenRouter's upstream detail (`metadata.raw`) and provider name. */
export function describeError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const metadata = errorBodyOf(error)?.metadata;
  if (!metadata) return base;
  const raw = metadata.raw === undefined ? "" : typeof metadata.raw === "string" ? metadata.raw : JSON.stringify(metadata.raw);
  const parts = [base];
  if (metadata.provider_name) parts.push(`provider: ${metadata.provider_name}`);
  if (raw) parts.push(`upstream: ${raw.slice(0, ERROR_DETAIL_CHARS)}`);
  return parts.join(" | ");
}

/** What the model generated when an upstream rejected it (`failed_generation`, top-level or inside `metadata.raw`). */
function rejectedGenerationOf(error: unknown): string | undefined {
  const body = errorBodyOf(error);
  if (typeof body?.failed_generation === "string" && body.failed_generation) return body.failed_generation;
  const raw = body?.metadata?.raw;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const nested = (parsed as { error?: { failed_generation?: unknown } } | null)?.error?.failed_generation;
  return typeof nested === "string" && nested ? nested : undefined;
}

function normalizeUsage(raw: RawUsage): TokenUsage {
  const usage: TokenUsage = {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
  };
  if (typeof raw.cost === "number") usage.costUsd = raw.cost;
  return usage;
}

function normalizeFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return reason;
    case "function_call":
      return "tool_calls";
    default:
      return "unknown";
  }
}

/**
 * Serializes the transcript to the chat-completions wire format. Tool-call
 * arguments are sent back verbatim when they are valid JSON; an invalid
 * string is wrapped so the request stays valid for upstreams that validate
 * history, while the model still sees what it produced. Reasoning details
 * are echoed back so reasoning models keep their chain across tool calls.
 */
export function toWireMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      case "assistant": {
        const wire: Record<string, unknown> = { role: "assistant", content: m.content || null };
        if (m.toolCalls.length > 0) {
          wire.tool_calls = m.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: validJsonOrWrapped(call.arguments) },
          }));
        }
        if (m.reasoningDetails?.length) wire.reasoning_details = m.reasoningDetails;
        return wire;
      }
    }
  });
}

function validJsonOrWrapped(args: string): string {
  try {
    JSON.parse(args);
    return args;
  } catch {
    return JSON.stringify({ invalid_arguments: args });
  }
}

/** Honors Retry-After when sent; otherwise exponential backoff with jitter, capped at 60s. */
export function retryDelayMs(error: unknown, attempt: number): number {
  const headers = (error as { headers?: Record<string, string | undefined> } | null)?.headers;
  const retryAfter = headers?.["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  }
  const base = Math.min(2 ** attempt * 1000, 60_000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

async function fetchOpenRouterLimits(model: string): Promise<Partial<ModelLimits> | undefined> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    data?: Array<{ id: string; context_length?: number; top_provider?: { max_completion_tokens?: number } }>;
  };
  const entry = body.data?.find((m) => m.id === model);
  if (!entry) return undefined;
  const limits: Partial<ModelLimits> = {};
  if (entry.context_length) limits.contextWindow = entry.context_length;
  if (entry.top_provider?.max_completion_tokens) limits.maxOutputTokens = entry.top_provider.max_completion_tokens;
  return limits;
}
