/**
 * Context-window management.
 *
 * Tool outputs are bounded at the source (ToolExecutor, BashTool), so the
 * transcript grows slowly; compaction is the backstop for long runs on
 * smaller-context models. It is driven by real prompt-token counts from the
 * provider plus an estimate for messages added since, and it only ever
 * cuts at a turn boundary — a tool result is never separated from the
 * assistant message that called it (providers reject orphaned results).
 */

import type { ChatModel, Message } from "./types.js";

const CHARS_PER_TOKEN = 3.5;
/** Compact when the next request would use more than this share of the window. */
const COMPACTION_TRIGGER = 0.8;
/** Recent history kept verbatim after compaction, as a share of the window. */
const KEPT_TAIL_SHARE = 0.3;
/** Largest share of the window reserved for a single response. */
const MAX_OUTPUT_SHARE = 0.25;
const SUMMARY_INPUT_MESSAGE_CHARS = 4_000;
const MAX_SUMMARY_OUTPUT_TOKENS = 4_000;
/** The summary may use at most this share of the window, so a compacted transcript fits below the trigger. */
const MAX_SUMMARY_SHARE = 0.1;
/**
 * Compaction is refused when the removable history is smaller than this share
 * of the window: replacing it with a summary would free almost nothing, and
 * doing it anyway costs a model call every turn without making progress.
 */
const MIN_REMOVABLE_SHARE = 0.1;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.role === "assistant") for (const call of m.toolCalls) chars += call.name.length + call.arguments.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Output tokens to reserve per request: the requested cap, but never more
 * than a quarter of the window. Reserving a large share of a small window
 * would leave the transcript too little room and make compaction fire
 * again on every turn.
 */
export function outputTokenBudget(contextWindow: number, requested: number): number {
  return Math.max(256, Math.min(requested, Math.floor(contextWindow * MAX_OUTPUT_SHARE)));
}

export function needsCompaction(estimatedPromptTokens: number, budget: ContextBudget): boolean {
  return estimatedPromptTokens + budget.maxOutputTokens > budget.contextWindow * COMPACTION_TRIGGER;
}

/**
 * Index where the verbatim tail starts: as much recent history as fits in
 * the tail budget, moved back so it never begins with a tool result.
 * Returns undefined when there is no middle section to compact.
 */
export function tailStartIndex(messages: Message[], budget: ContextBudget, headCount: number): number | undefined {
  const tailBudget = budget.contextWindow * KEPT_TAIL_SHARE;
  let start = messages.length;
  let tokens = 0;
  while (start > headCount) {
    const cost = estimateTokens([messages[start - 1]]);
    if (tokens + cost > tailBudget) break;
    tokens += cost;
    start--;
  }
  while (start < messages.length && messages[start].role === "tool") start++;
  // Keep at least the latest complete turn even if it alone exceeds the tail budget.
  if (start >= messages.length) {
    start = messages.length - 1;
    while (start > headCount && messages[start].role === "tool") start--;
  }
  return start > headCount ? start : undefined;
}

export interface CompactionResult {
  messages: Message[];
  removedMessages: number;
  outcome: "summarized" | "summary_failed_dropped";
}

/**
 * Replaces the middle of the transcript (after the system prompt and task)
 * with a model-written progress summary. If summarization itself fails, the
 * middle is dropped with an explicit note rather than blocking the run.
 */
export async function compact(
  messages: Message[],
  model: ChatModel,
  budget: ContextBudget,
  deadline: number,
): Promise<CompactionResult | undefined> {
  const headCount = Math.min(2, messages.length);
  const tailStart = tailStartIndex(messages, budget, headCount);
  if (tailStart === undefined) return undefined;

  const head = messages.slice(0, headCount);
  const middle = messages.slice(headCount, tailStart);
  const tail = messages.slice(tailStart);
  if (estimateTokens(middle) < budget.contextWindow * MIN_REMOVABLE_SHARE) return undefined;

  let summary: string;
  let outcome: CompactionResult["outcome"] = "summarized";
  try {
    const turn = await model.complete(
      [
        {
          role: "system",
          content:
            "You write handoff notes for an autonomous agent whose earlier working history is being removed to free context. The agent will continue from your notes, so they must be factual and specific.",
        },
        {
          role: "user",
          content: `TASK:\n${head.map((m) => m.content).join("\n\n")}\n\nHISTORY BEING REMOVED:\n${renderForSummary(middle, budget)}\n\nWrite the handoff notes with these sections:\n## Done so far (what was changed, with exact paths/commands)\n## Facts learned (environment details, versions, file locations, errors and their causes)\n## Current state and open problems\n## Next steps`,
        },
      ],
      [],
      { deadline, maxOutputTokens: summaryTokenBudget(budget.contextWindow) },
    );
    summary = turn.message.content.trim();
    if (!summary) throw new Error("empty summary");
    // Models do not always respect max_tokens precisely; enforce the budget.
    const maxSummaryChars = summaryTokenBudget(budget.contextWindow) * CHARS_PER_TOKEN;
    if (summary.length > maxSummaryChars) summary = `${summary.slice(0, maxSummaryChars)}\n[summary truncated]`;
  } catch {
    outcome = "summary_failed_dropped";
    summary = "(A summary could not be produced. Re-check the current state of the environment before continuing.)";
  }

  const note: Message = {
    role: "user",
    content: `[Context compacted: ${middle.length} earlier messages were replaced by these notes. The environment itself is unchanged.]\n\n${summary}`,
  };
  return { messages: [...head, note, ...tail], removedMessages: middle.length, outcome };
}

function summaryTokenBudget(contextWindow: number): number {
  return Math.max(256, Math.min(MAX_SUMMARY_OUTPUT_TOKENS, Math.floor(contextWindow * MAX_SUMMARY_SHARE)));
}

function renderForSummary(messages: Message[], budget: ContextBudget): string {
  const clip = (text: string) =>
    text.length > SUMMARY_INPUT_MESSAGE_CHARS
      ? `${text.slice(0, SUMMARY_INPUT_MESSAGE_CHARS / 2)}\n[...]\n${text.slice(-SUMMARY_INPUT_MESSAGE_CHARS / 2)}`
      : text;
  const rendered = messages
    .map((m) => {
      if (m.role === "assistant") {
        const calls = m.toolCalls.map((c) => `CALL ${c.name} ${clip(c.arguments)}`).join("\n");
        return `ASSISTANT: ${clip(m.content)}${calls ? `\n${calls}` : ""}`;
      }
      if (m.role === "tool") return `RESULT (${m.name}): ${clip(m.content)}`;
      return `${m.role.toUpperCase()}: ${clip(m.content)}`;
    })
    .join("\n\n");
  // The summary request must itself fit the window: keep the most recent part.
  const maxChars = Math.floor(budget.contextWindow * 0.5 * CHARS_PER_TOKEN);
  return rendered.length > maxChars ? `[earliest history omitted]\n${rendered.slice(-maxChars)}` : rendered;
}
