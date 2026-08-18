/**
 * Compactor - structured, cache-preserving conversation compaction.
 *
 * Before this, "compaction" in this codebase meant pure heuristic
 * truncation (BaseAgent.truncateMessages): drop whatever doesn't fit the
 * recent-window budget, with no summarization anywhere. This module adds
 * real LLM-based summarization, used as truncateMessages' first choice —
 * heuristic truncation becomes the fallback for when summarization itself
 * fails or times out, not the only mechanism.
 *
 * Two properties this is built around:
 *
 * 1. Cache-preserving order: the compaction call replays the messages
 *    being compacted VERBATIM, using the same system prompt as the main
 *    loop, and appends the summarization instruction as the LAST message.
 *    If the provider already cached this exact prefix from an earlier
 *    real turn (see ClaudeProvider's cache_control), the compaction call
 *    reuses that cache and only pays for the small new instruction.
 *
 * 2. Incremental re-compaction: callers must track how much history has
 *    already been folded into the current summary (BaseAgent does this
 *    via `compactedThroughIndex`) and only pass the NEW-since-last-time
 *    messages here. This function merges them into `existingSummary`
 *    rather than re-summarizing everything from scratch every time.
 */

import type { ChatMessage } from "../../providers/ProviderInterface.js";
import type { BaseProvider } from "../../providers/ProviderInterface.js";

const COMPACTION_TEMPLATE = `## Objective
<the overall task/goal>

## Important Details
<key facts, decisions, and constraints established so far>

## Work State
- Completed: <...>
- Active: <...>
- Blocked: <...>

## Next Move
<what should happen next>

## Relevant Files
<files touched or referenced, one per line — write "none" if none>`;

function buildCompactionInstruction(existingSummary?: string): string {
  if (existingSummary) {
    return `There is an existing summary of even earlier context below. Merge it with the conversation above into ONE updated summary, using exactly the template below. If the conversation above conflicts with the existing summary, the conversation is more recent and wins. Output ONLY the filled-in template, nothing else.

EXISTING SUMMARY:
${existingSummary}

TEMPLATE:
${COMPACTION_TEMPLATE}`;
  }

  return `Summarize the conversation above into exactly this template, filling in each section concisely. Output ONLY the filled-in template, nothing else.

${COMPACTION_TEMPLATE}`;
}

/**
 * Builds the exact message array to send for compaction: the same system
 * messages as the main loop, the messages being compacted replayed
 * verbatim (no reordering, no editing), and the instruction appended last.
 * Pure and synchronous — safe to unit test without a provider.
 */
export function buildCompactionRequest(
  systemMessages: ChatMessage[],
  messagesToCompact: ChatMessage[],
  existingSummary?: string,
): ChatMessage[] {
  return [
    ...systemMessages,
    ...messagesToCompact,
    { role: "user", content: buildCompactionInstruction(existingSummary) },
  ];
}

/**
 * Light sanity check on the model's response — an LLM can refuse, wrap the
 * answer in commentary, or otherwise not follow the template. Rather than
 * propagate a malformed "summary" into the conversation, treat anything
 * without the expected structure as a failure so the caller falls back to
 * heuristic truncation.
 */
export function parseCompactionResponse(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/##\s*objective/i.test(trimmed)) return null;
  return trimmed;
}

export interface CompactionOptions {
  provider: BaseProvider;
  model: string;
  systemMessages: ChatMessage[];
  existingSummary?: string;
  timeoutMs?: number;
}

export interface CompactionOutcome {
  summary: string;
}

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Runs the actual compaction LLM call. Returns null (never throws) on any
 * failure — timeout, provider error, or a malformed response — so the
 * caller can fall back to heuristic truncation without special-casing
 * error handling at every call site.
 */
export async function compactMessages(
  messagesToCompact: ChatMessage[],
  options: CompactionOptions,
): Promise<CompactionOutcome | null> {
  if (messagesToCompact.length === 0) return null;

  const request = buildCompactionRequest(
    options.systemMessages,
    messagesToCompact,
    options.existingSummary,
  );

  try {
    const result = await Promise.race([
      options.provider.complete(request, { model: options.model }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("compaction timed out")),
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ),
      ),
    ]);

    const summary = parseCompactionResponse(result.content);
    if (!summary) return null;
    return { summary };
  } catch {
    return null;
  }
}

/** How the folded-in summary is presented back to the model as a system message. */
export function renderSummaryMessage(summary: string): ChatMessage {
  return {
    role: "system",
    content: `[Conversation Summary — earlier turns compacted to save context]\n${summary}`,
  };
}
