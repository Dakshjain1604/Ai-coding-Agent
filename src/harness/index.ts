/**
 * Composition root for a headless harness run: builds the model client,
 * tools, prompt and trajectory from plain options and runs the loop.
 *
 * All harness-private state (trajectory, shell session files, spilled
 * outputs) lives under `logsDir`, never in the task workspace.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunResult } from "./agent-loop.js";
import { OpenRouterClient, type ReasoningEffort } from "./openrouter-client.js";
import { buildSystemPrompt } from "./prompt.js";
import { BashTool } from "./tools/bash.js";
import { EditorTool } from "./tools/editor.js";
import { ToolExecutor } from "./tools/tool.js";
import { JsonlTrajectory } from "./trajectory.js";
import type { ChatModel } from "./types.js";

export interface HarnessRunOptions {
  instruction: string;
  /** "openrouter/<model id>". */
  modelSpec: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  logsDir: string;
  maxTurns: number;
  timeoutSec: number;
  maxOutputTokens: number;
  contextWindow?: number;
  /** Receives one human-readable progress line per event. */
  progress?: (line: string) => void;
  /** Injected for tests; built from modelSpec otherwise. */
  model?: ChatModel;
}

export async function runHarness(options: HarnessRunOptions): Promise<RunResult> {
  mkdirSync(options.logsDir, { recursive: true });
  const scratchDir = join(options.logsDir, "scratch");
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutSec * 1000;

  const client =
    options.model ??
    new OpenRouterClient({
      spec: options.modelSpec,
      limits: options.contextWindow ? { contextWindow: options.contextWindow } : undefined,
      reasoningEffort: options.reasoningEffort,
    });
  // The model's API key must never be readable by commands the model runs.
  const hiddenEnv = client instanceof OpenRouterClient ? [client.apiKeyEnv] : [];

  const bash = new BashTool({ initialCwd: options.cwd, scratchDir, hiddenEnv });
  const executor = new ToolExecutor([bash, new EditorTool()]);
  const trajectory = new JsonlTrajectory(join(options.logsDir, "trajectory.jsonl"), options.progress);

  const result = await runAgent({
    model: client,
    tools: executor,
    toolContext: { cwd: () => bash.currentDirectory(), startedAt, deadline, scratchDir },
    systemPrompt: buildSystemPrompt({
      cwd: options.cwd,
      platform: `${process.platform} ${process.arch}`,
      shell: process.env.SHELL ?? "bash",
      date: new Date().toISOString().slice(0, 10),
      timeBudgetSec: options.timeoutSec,
    }),
    instruction: options.instruction,
    maxTurns: options.maxTurns,
    deadline,
    maxOutputTokens: options.maxOutputTokens,
    trajectory,
  });

  writeFileSync(join(options.logsDir, "result.json"), JSON.stringify({ model: client.id, ...result }, null, 2));
  return result;
}

export type { RunResult, RunStatus } from "./agent-loop.js";
