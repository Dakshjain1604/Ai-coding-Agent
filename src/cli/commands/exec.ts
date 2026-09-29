/**
 * exec — run one task headlessly with the harness agent loop.
 *
 * Built for automation (benchmarks, CI, scripts): no prompts, no spinners,
 * progress on stderr, the final answer on stdout, a structured trajectory
 * and result.json in --logs-dir, and an exit code that reflects the outcome.
 */

import { Command, Flags } from "@oclif/core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runHarness, type RunStatus } from "../../harness/index.js";
import { MODEL_ENV_VAR } from "../../utils/config.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../harness/openrouter-client.js";

export const EXIT_CODES: Record<RunStatus, number> = {
  completed: 0,
  model_error: 1,
  max_turns: 3,
  timeout: 3,
};

export default class ExecCommand extends Command {
  static description =
    "Run a task headlessly to completion (for automation). Exit code: 0 completed, 1 model error, 2 usage error, 3 turn/time budget exhausted.";

  static examples = [
    '<%= config.bin %> exec --model openrouter/nvidia/nemotron-3-ultra-550b-a55b:free "fix the failing tests"',
    "<%= config.bin %> exec --model openrouter/openai/gpt-5.2 --reasoning-effort high --instruction-file task.md",
    "<%= config.bin %> exec --instruction-file task.md --cwd /app --timeout-sec 900 --logs-dir /logs/agent",
  ];

  static strict = false;
  static args = {};

  static flags = {
    "instruction-file": Flags.string({ description: "Read the task instruction from this file." }),
    model: Flags.string({ description: `"openrouter/<model id>" (default: $${MODEL_ENV_VAR})` }),
    "reasoning-effort": Flags.string({
      options: [...REASONING_EFFORTS],
      description: "OpenRouter reasoning effort for models that support it (default: the model's own default).",
    }),
    "reasoning-max-tokens": Flags.integer({
      min: 0,
      description: "Cap on reasoning tokens for models that support reasoning (default: 2048).",
    }),
    cwd: Flags.string({ description: "Working directory for the task (default: current directory)." }),
    "logs-dir": Flags.string({ description: "Directory for trajectory.jsonl, result.json and harness scratch files." }),
    "max-turns": Flags.integer({ default: 150, min: 1, description: "Maximum model turns." }),
    "timeout-sec": Flags.integer({ default: 3600, min: 30, description: "Wall-clock budget for the whole run." }),
    "max-output-tokens": Flags.integer({ default: 16384, min: 256, description: "Output token cap per model call." }),
    "context-window": Flags.integer({ min: 1000, description: "Override the model's context window (tokens)." }),
    quiet: Flags.boolean({ default: false, description: "Suppress progress lines on stderr." }),
  };

  async run(): Promise<void> {
    const { flags, argv } = await this.parse(ExecCommand);

    const inline = (argv as string[]).join(" ").trim();
    const instruction = flags["instruction-file"] ? readFileSync(flags["instruction-file"], "utf8") : inline;
    if (!instruction.trim()) {
      this.error("Provide the task as an argument or with --instruction-file.", { exit: 2 });
    }
    const modelSpec = flags.model ?? process.env[MODEL_ENV_VAR];
    if (!modelSpec) {
      this.error(`Provide --model or set ${MODEL_ENV_VAR}.`, { exit: 2 });
    }

    const logsDir = resolve(
      flags["logs-dir"] ?? join(homedir(), ".coding-agent", "runs", new Date().toISOString().replace(/[:.]/g, "-")),
    );

    let status: RunStatus;
    try {
      const result = await runHarness({
        instruction,
        modelSpec,
        cwd: resolve(flags.cwd ?? process.cwd()),
        logsDir,
        maxTurns: flags["max-turns"],
        timeoutSec: flags["timeout-sec"],
        maxOutputTokens: flags["max-output-tokens"],
        contextWindow: flags["context-window"],
        reasoningEffort: flags["reasoning-effort"] as ReasoningEffort | undefined,
        reasoningMaxTokens: flags["reasoning-max-tokens"],
        progress: flags.quiet ? undefined : (line) => process.stderr.write(line + "\n"),
      });
      status = result.status;
      process.stdout.write(result.finalMessage + "\n");
      process.stderr.write(`status=${result.status} turns=${result.turns} logs=${logsDir}\n`);
    } catch (error) {
      // Setup failures (bad model spec, missing API key) — nothing ran.
      this.error(error instanceof Error ? error.message : String(error), { exit: 2 });
    }
    this.exit(EXIT_CODES[status]);
  }
}
