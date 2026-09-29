/**
 * Tool contract and executor.
 *
 * Invariant: every tool call the model makes yields exactly one complete,
 * bounded observation — never a thrown exception, never unbounded output,
 * never a silently dropped stream. Argument parsing, validation, crash
 * handling, output bounding and secret scrubbing all happen here, once,
 * instead of being re-implemented (and missed) inside each tool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeArguments, parseArgumentsJson } from "../../providers/openai-stream-tools.js";
import { scrubSecrets } from "../../utils/secret-scrubber.js";
import type { JsonSchemaProperty, ToolCallRecord, ToolSpec } from "../types.js";

export { normalizeArguments, parseArgumentsJson } from "../../providers/openai-stream-tools.js";

export interface ToolContext {
  /** Current working directory of the agent's shell session. */
  cwd(): string;
  /** Epoch ms when the whole run started. */
  startedAt: number;
  /** Epoch ms when the whole run must end. */
  deadline: number;
  /** Harness-private scratch directory (never inside the task workspace). */
  scratchDir: string;
}

export interface Observation {
  ok: boolean;
  output: string;
  /** Structured facts for the trajectory (exit code, bytes, ...); not shown to the model. */
  meta?: Record<string, unknown>;
}

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<Observation>;
}

export interface ExecutedCall {
  observation: Observation;
  durationMs: number;
  /** Chars removed from the middle of the output to fit the observation budget. */
  omittedChars: number;
  /** Where the untruncated output was saved, when truncation happened. */
  fullOutputPath?: string;
}

export interface ToolExecutorOptions {
  maxObservationChars?: number;
}

const DEFAULT_MAX_OBSERVATION_CHARS = 30_000;

export class ToolExecutor {
  private readonly tools: Map<string, Tool>;
  private readonly maxObservationChars: number;
  private spillCount = 0;

  constructor(tools: Tool[], options: ToolExecutorOptions = {}) {
    this.tools = new Map(tools.map((t) => [t.spec.name, t]));
    this.maxObservationChars = options.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  async execute(call: ToolCallRecord, ctx: ToolContext): Promise<ExecutedCall> {
    const started = Date.now();
    const raw = await this.runSafely(call, ctx);
    const output = scrubSecrets(raw.output);
    const bounded = this.bound(output, ctx);
    return {
      observation: { ...raw, output: bounded.text + timeFooter(ctx) },
      durationMs: Date.now() - started,
      omittedChars: bounded.omittedChars,
      fullOutputPath: bounded.fullOutputPath,
    };
  }

  private async runSafely(call: ToolCallRecord, ctx: ToolContext): Promise<Observation> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        ok: false,
        output: `Error: unknown tool "${call.name}". Available tools: ${[...this.tools.keys()].join(", ")}.`,
      };
    }

    let rawArgs: unknown;
    try {
      rawArgs = parseArgumentsJson(call.arguments);
    } catch (error) {
      return {
        ok: false,
        output: `Error: arguments for ${call.name} are not valid JSON (${(error as Error).message}). Received: ${call.arguments.slice(0, 500)}`,
      };
    }
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return { ok: false, output: `Error: arguments for ${call.name} must be a JSON object.` };
    }

    const args = normalizeArguments(rawArgs as Record<string, unknown>);
    const problems = validateArguments(args, tool.spec);
    if (problems.length > 0) {
      return {
        ok: false,
        output: `Error: invalid arguments for ${call.name}:\n- ${problems.join("\n- ")}`,
      };
    }

    try {
      return await tool.run(args, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `Error: ${call.name} failed unexpectedly: ${message}` };
    }
  }

  /** Keeps the head and the (usually more informative) tail; saves the full text to a file the agent can read. */
  private bound(text: string, ctx: ToolContext): { text: string; omittedChars: number; fullOutputPath?: string } {
    if (text.length <= this.maxObservationChars) return { text, omittedChars: 0 };
    const headChars = Math.floor(this.maxObservationChars * 0.3);
    const tailChars = this.maxObservationChars - headChars;
    const omittedChars = text.length - headChars - tailChars;

    let fullOutputPath: string | undefined;
    try {
      const dir = join(ctx.scratchDir, "outputs");
      mkdirSync(dir, { recursive: true });
      fullOutputPath = join(dir, `observation-${++this.spillCount}.txt`);
      writeFileSync(fullOutputPath, text);
    } catch {
      fullOutputPath = undefined;
    }

    const where = fullOutputPath ? ` Full output saved to ${fullOutputPath}.` : "";
    const marker = `\n\n[... ${omittedChars} characters omitted.${where} ...]\n\n`;
    return {
      text: text.slice(0, headChars) + marker + text.slice(text.length - tailChars),
      omittedChars,
      fullOutputPath,
    };
  }
}

/**
 * Every observation ends with the run's time budget. The model otherwise has
 * no way to know how long it has left, and plans as if time were unlimited —
 * confirmed live: an agent spent its entire budget investigating a COBOL
 * program's edge-case semantics and never wrote the file the task asked for.
 * Minutes, not seconds, so the number is stable across a turn.
 */
export function timeFooter(ctx: ToolContext): string {
  if (!Number.isFinite(ctx.deadline) || !Number.isFinite(ctx.startedAt)) return "";
  const now = Date.now();
  const elapsedMin = Math.floor((now - ctx.startedAt) / 60_000);
  const remainingMin = Math.floor(Math.max(0, ctx.deadline - now) / 60_000);
  return `\n[time: ${elapsedMin}m elapsed, ~${remainingMin}m left]`;
}

export function validateArguments(args: Record<string, unknown>, spec: ToolSpec): string[] {
  const problems: string[] = [];
  const { properties, required } = spec.parameters;
  for (const name of required) {
    if (args[name] === undefined || args[name] === null) problems.push(`missing required parameter "${name}"`);
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!schema) {
      problems.push(`unknown parameter "${name}" (expected: ${Object.keys(properties).join(", ")})`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const typeProblem = checkType(value, schema);
    if (typeProblem) problems.push(`parameter "${name}" ${typeProblem}`);
  }
  return problems;
}

function checkType(value: unknown, schema: JsonSchemaProperty): string | undefined {
  const actual = Array.isArray(value) ? "array" : typeof value;
  switch (schema.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `must be an integer, got ${JSON.stringify(value)}`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `must be a number, got ${JSON.stringify(value)}`;
      break;
    case "array":
    case "object":
    case "string":
    case "boolean":
      if (actual !== schema.type) return `must be a ${schema.type}, got ${actual}`;
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    return `must be one of ${schema.enum.join(", ")}, got ${JSON.stringify(value)}`;
  }
  return undefined;
}
