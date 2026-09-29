/**
 * The agent loop.
 *
 * One model, one transcript, one set of tools, no modes and no pipeline:
 * the model decides what to do next, and the loop only enforces the
 * protocol (every tool call gets its result) and global budgets. The run
 * ends when the model replies without a tool call, or when the turn or
 * wall-clock budget is spent — budgets are checked between turns, so a
 * tool result is never computed and then thrown away.
 */

import { compact, estimateTokens, needsCompaction, outputTokenBudget } from "./context.js";
import { DEADLINE_EXCEEDED } from "./openrouter-client.js";
import type { ToolContext, ToolExecutor } from "./tools/tool.js";
import type { TrajectorySink } from "./trajectory.js";
import { ModelError, type ChatModel, type Message, type TokenUsage } from "./types.js";

export type RunStatus = "completed" | "max_turns" | "timeout" | "model_error";

export interface RunResult {
  status: RunStatus;
  /** The model's final reply (for "completed"), or a description of why the run stopped. */
  finalMessage: string;
  turns: number;
  toolCalls: number;
  usage: TokenUsage;
  durationMs: number;
  errorCategory?: string;
}

export interface AgentLoopOptions {
  model: ChatModel;
  tools: ToolExecutor;
  toolContext: ToolContext;
  systemPrompt: string;
  instruction: string;
  maxTurns: number;
  /** Epoch ms by which the run must end. */
  deadline: number;
  /** Upper bound on output tokens per model call; the model's own limit applies if lower. */
  maxOutputTokens: number;
  trajectory: TrajectorySink;
}

/**
 * Fractions of the time budget at which the loop interrupts with an explicit
 * time check. A passive figure in each observation is not enough on its own —
 * confirmed live: an agent read "~3m left" and kept exploring until the budget
 * ran out, never writing the file the task asked for.
 */
const TIME_CHECK_THRESHOLDS = [0.5, 0.25, 0.1] as const;

/** Time kept in reserve so the run ends cleanly instead of being killed mid-turn. */
const DEADLINE_RESERVE_MS = 15_000;
/**
 * Turns that produce nothing usable — an empty reply, output cut off by the
 * token limit, or a generation the provider rejected. Each gets feedback in
 * the transcript so the next attempt differs; this many in a row ends the run.
 */
const MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS = 3;
const REJECTED_GENERATION_SNIPPET_CHARS = 2_000;
/** Context-overflow recoveries in a row before giving up (each one shrinks the learned window). */
const MAX_CONSECUTIVE_OVERFLOW_RECOVERIES = 2;
/** After an overflow, assume the real window is at most this share of the request that overflowed. */
const OVERFLOW_WINDOW_SHRINK = 0.9;

export async function runAgent(options: AgentLoopOptions): Promise<RunResult> {
  const { model, tools, trajectory } = options;
  const started = Date.now();
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const limits = await model.limits();
  const budget = {
    contextWindow: limits.contextWindow,
    maxOutputTokens: outputTokenBudget(limits.contextWindow, Math.min(options.maxOutputTokens, limits.maxOutputTokens)),
  };

  let messages: Message[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.instruction },
  ];
  // Prompt tokens reported for the last request, and how many messages it covered.
  let lastPromptTokens = 0;
  let messagesCoveredByLastUsage = 0;
  let turns = 0;
  let toolCallCount = 0;
  let consecutiveUnproductive = 0;
  let consecutiveOverflows = 0;
  const timeChecksSent = new Set<number>();

  const finish = (status: RunStatus, finalMessage: string, errorCategory?: string): RunResult => {
    const result: RunResult = {
      status,
      finalMessage,
      turns,
      toolCalls: toolCallCount,
      usage,
      durationMs: Date.now() - started,
    };
    if (errorCategory) result.errorCategory = errorCategory;
    trajectory.record({
      type: "run_end",
      status,
      turns,
      tool_calls: toolCallCount,
      duration_ms: result.durationMs,
      usage,
      error_category: errorCategory,
      final_message: finalMessage,
    });
    return result;
  };

  /** Replaces older history with a summary; returns whether anything was removed. */
  const compactNow = async (reason: string, estimatedPrompt: number): Promise<boolean> => {
    const compacted = await compact(messages, model, budget, options.deadline);
    trajectory.record({
      type: "compaction",
      reason,
      estimated_prompt_tokens: estimatedPrompt,
      context_window: budget.contextWindow,
      removed_messages: compacted?.removedMessages ?? 0,
      outcome: compacted?.outcome ?? "nothing_to_compact",
    });
    if (!compacted) return false;
    messages = compacted.messages;
    lastPromptTokens = 0;
    messagesCoveredByLastUsage = 0;
    return true;
  };

  /** Feeds a correction back to the model; returns a final result once the streak limit is hit. */
  const recordUnproductiveTurn = (feedback: string, notice: string): RunResult | undefined => {
    consecutiveUnproductive++;
    if (consecutiveUnproductive >= MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS) {
      return finish(
        "model_error",
        `Stopped after ${consecutiveUnproductive} consecutive turns without usable output (last: ${notice}).`,
        "unproductive_turns",
      );
    }
    messages.push({ role: "user", content: feedback });
    trajectory.record({ type: "notice", turn: turns, message: notice });
    return undefined;
  };

  /** Interrupts once per threshold to force a decision about what is still unfinished. */
  const maybeSendTimeCheck = (): void => {
    const totalMs = options.deadline - started;
    if (totalMs <= 0) return;
    const remainingFraction = (options.deadline - Date.now()) / totalMs;
    const threshold = TIME_CHECK_THRESHOLDS.find(
      (t) => remainingFraction <= t && !timeChecksSent.has(t),
    );
    if (threshold === undefined) return;
    for (const t of TIME_CHECK_THRESHOLDS) if (t >= threshold) timeChecksSent.add(t);

    const remainingMin = Math.max(0, Math.round((options.deadline - Date.now()) / 60_000));
    const urgency =
      threshold <= 0.1
        ? "CRITICAL: Time is almost exhausted. If your deliverables are in place, stop running sleep loops or open-ended tests. Confirm the deliverable directory holds only the requested files and finish now with a summary."
        : threshold <= 0.25
          ? "URGENT: Time is running low. If deliverables are already built and basic verification passed, do NOT spend time on long benchmarks or background polling; finalize and finish. If anything is missing, create the minimal working version immediately."
          : "Decide now: is every artifact the task asked for actually in place and working? If not, build the simplest version that satisfies the stated requirements and verify it. Leave further investigation and refinements for whatever time is left after that.";

    messages.push({
      role: "user",
      content:
        `[Time check] About ${remainingMin} minute(s) of the run remain. When the time is up the run stops where it is, and anything unfinished scores nothing. ${urgency}`,
    });
    trajectory.record({ type: "notice", turn: turns, message: `time check sent at ${Math.round(threshold * 100)}% remaining` });
  };

  trajectory.record({
    type: "run_start",
    model: model.id,
    cwd: options.toolContext.cwd(),
    max_turns: options.maxTurns,
    deadline: new Date(options.deadline).toISOString(),
    context_window: budget.contextWindow,
    max_output_tokens: budget.maxOutputTokens,
    tools: tools.specs().map((t) => t.name),
    instruction: options.instruction,
  });

  for (;;) {
    if (turns >= options.maxTurns) {
      return finish("max_turns", `Stopped after reaching the ${options.maxTurns}-turn limit.`);
    }
    if (Date.now() >= options.deadline - DEADLINE_RESERVE_MS) {
      return finish("timeout", "Stopped because the time budget ran out.");
    }

    const estimatedPrompt =
      lastPromptTokens + estimateTokens(messages.slice(messagesCoveredByLastUsage));
    if (needsCompaction(estimatedPrompt, budget)) {
      await compactNow("approaching context window", estimatedPrompt);
    }

    turns++;
    trajectory.record({ type: "model_request", turn: turns, messages: messages.length, estimated_prompt_tokens: estimatedPrompt });

    let reply;
    try {
      reply = await model.complete(messages, tools.specs(), {
        deadline: options.deadline - DEADLINE_RESERVE_MS,
        maxOutputTokens: budget.maxOutputTokens,
        onRetry: (info) =>
          trajectory.record({
            type: "model_retry",
            turn: turns,
            attempt: info.attempt,
            category: info.category,
            wait_ms: info.waitMs,
            message: info.message,
          }),
      });
    } catch (error) {
      const category = error instanceof ModelError ? error.category : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      trajectory.record({
        type: "model_error",
        turn: turns,
        category,
        message,
        rejected_generation: error instanceof ModelError ? error.rejectedGeneration : undefined,
      });
      if (category === DEADLINE_EXCEEDED) {
        return finish("timeout", "Stopped because the time budget ran out during a model call.");
      }
      if (category === "context_overflow") {
        // The provider's real window is smaller than we assumed: learn it from
        // the request that overflowed, then shrink the conversation to fit.
        consecutiveOverflows++;
        const overflowedAt = estimateTokens(messages) + budget.maxOutputTokens;
        budget.contextWindow = Math.min(budget.contextWindow, Math.floor(overflowedAt * OVERFLOW_WINDOW_SHRINK));
        budget.maxOutputTokens = outputTokenBudget(budget.contextWindow, budget.maxOutputTokens);
        const recovered =
          consecutiveOverflows <= MAX_CONSECUTIVE_OVERFLOW_RECOVERIES &&
          (await compactNow("provider reported context overflow", overflowedAt));
        if (recovered) continue;
        return finish("model_error", `Model call failed: ${message}`, category);
      }
      if (category === "invalid_model_output" && error instanceof ModelError) {
        const feedback = rejectedOutputFeedback(error);
        const stop = recordUnproductiveTurn(feedback, "provider rejected the model's output; fed the error back");
        if (stop) return stop;
        continue;
      }
      return finish("model_error", `Model call failed: ${message}`, category);
    }

    consecutiveOverflows = 0;
    usage.promptTokens += reply.usage.promptTokens;
    usage.completionTokens += reply.usage.completionTokens;
    usage.cachedTokens += reply.usage.cachedTokens;
    if (reply.usage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + reply.usage.costUsd;
    if (reply.usage.promptTokens > 0) {
      lastPromptTokens = reply.usage.promptTokens;
      messagesCoveredByLastUsage = messages.length;
    }

    const assistant = reply.message;
    messages.push(assistant);
    trajectory.record({
      type: "model_response",
      turn: turns,
      served_by: reply.servedBy,
      finish_reason: reply.finishReason,
      latency_ms: reply.latencyMs,
      first_chunk_ms: reply.firstChunkMs,
      attempts: reply.attempts,
      prompt_tokens: reply.usage.promptTokens,
      completion_tokens: reply.usage.completionTokens,
      cached_tokens: reply.usage.cachedTokens,
      cost_usd: reply.usage.costUsd,
      content: assistant.content,
      tool_calls: assistant.toolCalls,
    });

    if (assistant.toolCalls.length === 0) {
      // A reply without tool calls ends the run — unless it is not a real
      // answer: output cut off by the token limit, or no content at all.
      if (reply.finishReason === "length") {
        const stop = recordUnproductiveTurn(
          "Your previous response hit the output token limit and was cut off. Continue from where it stopped; keep individual responses and tool arguments shorter.",
          "output truncated by length limit; asked model to continue",
        );
        if (stop) return stop;
        continue;
      }
      if (assistant.content.trim() === "") {
        const stop = recordUnproductiveTurn(
          "Your previous response was empty. Continue working on the task with a tool call, or, if the task is complete, reply with a summary.",
          "empty reply; asked model to continue",
        );
        if (stop) return stop;
        continue;
      }
      return finish("completed", assistant.content);
    }
    consecutiveUnproductive = 0;

    for (const call of assistant.toolCalls) {
      const executed = await tools.execute(call, options.toolContext);
      toolCallCount++;
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: executed.observation.output });
      trajectory.record({
        type: "tool_result",
        turn: turns,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        ok: executed.observation.ok,
        duration_ms: executed.durationMs,
        output: executed.observation.output,
        omitted_chars: executed.omittedChars,
        full_output_path: executed.fullOutputPath,
        meta: executed.observation.meta,
        summary: summarizeCall(call.name, call.arguments),
      });
    }

    maybeSendTimeCheck();
  }
}

function summarizeCall(name: string, rawArguments: string): string {
  try {
    const args = JSON.parse(rawArguments) as Record<string, unknown>;
    if (name === "bash") return String(args.command).split("\n")[0].slice(0, 120);
    if (name === "editor") return `${args.command} ${args.path}`;
  } catch {
    // fall through
  }
  return "";
}

function rejectedOutputFeedback(error: ModelError): string {
  const generation = error.rejectedGeneration
    ? `\n\nWhat you generated (as returned by the provider):\n${error.rejectedGeneration.slice(0, REJECTED_GENERATION_SNIPPET_CHARS)}`
    : "";
  return (
    `Your previous response was rejected by the model provider: ${error.message}${generation}\n\n` +
    "Try again. Tool arguments must be a single valid JSON object that matches the tool's parameters: " +
    "escape double quotes, backslashes and newlines inside strings, and call only the tools you were given. " +
    "If you were writing a large file, write it in smaller pieces."
  );
}
