/**
 * Structured run log. Every model call, retry, tool execution, compaction
 * and the final outcome is one JSON line, so a run can be analyzed — or
 * replayed — without scraping human-oriented console output. The harness
 * writes this itself; nothing depends on an external tracer.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TrajectoryEventType =
  | "run_start"
  | "model_request"
  | "model_retry"
  | "model_response"
  | "model_error"
  | "tool_result"
  | "compaction"
  | "notice"
  | "run_end";

export interface TrajectoryEvent {
  type: TrajectoryEventType;
  [key: string]: unknown;
}

export interface TrajectorySink {
  record(event: TrajectoryEvent): void;
}

export class JsonlTrajectory implements TrajectorySink {
  private readonly started = Date.now();

  constructor(
    private readonly file: string | undefined,
    private readonly progress: ((line: string) => void) | undefined = undefined,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  record(event: TrajectoryEvent): void {
    const elapsedMs = Date.now() - this.started;
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), elapsed_ms: elapsedMs, ...event }) + "\n");
      } catch {
        // Logging must never break the run.
      }
    }
    const line = this.progress ? summarize(event) : undefined;
    if (line) this.progress?.(`[${(elapsedMs / 1000).toFixed(1)}s] ${line}`);
  }
}

/** One human-readable line per event, for live progress on stderr. */
function summarize(event: TrajectoryEvent): string | undefined {
  switch (event.type) {
    case "run_start":
      return `run start · model ${event.model} · cwd ${event.cwd}`;
    case "model_response": {
      const calls = (event.tool_calls as Array<{ name: string }>).map((c) => c.name).join(", ");
      return `turn ${event.turn} · ${event.latency_ms}ms · ${event.prompt_tokens}+${event.completion_tokens} tok · ${calls || `finish=${event.finish_reason}`}`;
    }
    case "model_retry":
      return `retry ${event.attempt} (${event.category}) in ${event.wait_ms}ms: ${String(event.message).slice(0, 160)}`;
    case "model_error":
      return `model error (${event.category}): ${String(event.message).slice(0, 300)}`;
    case "tool_result":
      return `  ${event.name} · ${event.ok ? "ok" : "fail"} · ${event.duration_ms}ms${event.summary ? ` · ${event.summary}` : ""}`;
    case "compaction":
      return `compaction · removed ${event.removed_messages} messages · ${event.outcome}`;
    case "notice":
      return `notice: ${event.message}`;
    case "run_end":
      return `run end · ${event.status} · ${event.turns} turns · ${event.duration_ms}ms`;
    default:
      return undefined;
  }
}
