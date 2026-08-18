/**
 * Universal Agent - Single agent with mode switching
 * Replaces 6 specialized agents with one flexible agent
 */

import chalk from "chalk";
import ora from "ora";
import path from "path";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { BaseAgent } from "./BaseAgent.js";
import { TelemetryCollector } from "../../telemetry/TelemetryCollector.js";

marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.cyan,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.green.bold,
    firstHeading: chalk.magenta.bold.underline,
    hr: chalk.gray.dim,
    listitem: chalk.white,
    strong: chalk.bold.white,
    em: chalk.italic.white,
    codespan: chalk.yellow,
    link: chalk.blueBright,
    href: chalk.blue.underline.dim,
  }),
});
import { SYSTEM_PROMPTS, type AgentMode } from "./system-prompts.js";
import { TOOL_SETS } from "./tool-sets.js";
import type { Task, TaskResult } from "../../utils/types.js";
import { getToolRegistry } from "../tools/ToolRegistry.js";
import { ensureBuiltinToolsRegistered } from "../tools/builtin.js";
import { getConfigManager } from "../../utils/config.js";
import { getModelRouter } from "../../providers/ModelRouter.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../../providers/ProviderInterface.js";
import { pushSubagentContext, popSubagentContext } from "./subagent-context.js";
import { createContextEpoch, checkContextDrift, type ContextEpoch } from "./ContextEpoch.js";
import type { AgentContext } from "./BaseAgent.js";
import { classifyFailure } from "./failure-classifier.js";

/**
 * Builds the per-task system prompt: mode instructions + output-dir
 * constraint + (if a skill matched, see interactive.ts's handleRequest())
 * the matched skill's instructions. Pulled out as a pure function so the
 * skill-injection behavior is unit-testable without a live LLM call.
 */
export function buildTaskSystemPrompt(mode: AgentMode, task: Task): string {
  const outputDir = (task.metadata?.outputDir as string) || process.cwd();
  let systemPrompt =
    SYSTEM_PROMPTS[mode] +
    `\n\nIMPORTANT: Write ALL output files to this directory: ${outputDir}`;

  const skillInstructions = task.metadata?.skillInstructions as
    | string
    | undefined;
  if (skillInstructions) {
    const skillName = (task.metadata?.skillName as string) ?? "matched skill";
    systemPrompt += `\n\nThe user's request matched the "${skillName}" skill. Follow this guidance:\n${skillInstructions}`;
  }

  return systemPrompt;
}

export class UniversalAgent extends BaseAgent {
  private currentMode: AgentMode = "code";
  /** Incrementing counter for turn numbers across the agent's lifetime */
  private turnCounter: number = 0;
  /**
   * True when the caller explicitly pinned a mode at construction (e.g.
   * ParallelOrchestrator building a sub-agent for a specific pipeline
   * step). execute() must respect that choice rather than silently
   * overriding it via detectMode() — this was a real bug: every
   * spawn_subagent subtask's intended mode was being discarded in favor
   * of a guess from the subtask's description text, since subtasks don't
   * carry task.metadata.mode. False only for the auto-detecting
   * `new UniversalAgent()` (no mode) case, e.g. AgentSpawner's default path.
   */
  private modeExplicitlySet = false;

  constructor(mode?: AgentMode) {
    super("code", {});
    // Ensure built-in tools are registered in the singleton ToolRegistry
    ensureBuiltinToolsRegistered();
    if (mode) {
      this.modeExplicitlySet = true;
      this.setMode(mode);
    } else {
      this.registerDefaultTools();
    }
  }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    // BaseAgent's constructor always ran `super("code", {})` — without
    // this, `this.type` (and therefore per-mode iteration/timeout/cost
    // limits from getDefaultConfig, and getTaskCategory()'s model-routing
    // category) stayed "code" forever regardless of what mode the agent
    // actually ran in. Confirmed live: a "plan"-classified task was still
    // routed with code's task category and code's iteration budget.
    this.type = mode;
    this.config = this.getDefaultConfig(mode, {});
    this.tools.clear();
    const toolNames = TOOL_SETS[mode];
    const registry = getToolRegistry();
    for (const toolName of toolNames) {
      const agentTool = registry.toAgentTool(toolName);
      if (agentTool) {
        this.registerTool(agentTool);
      }
    }
  }

  detectMode(taskDescription: string): AgentMode {
    const desc = taskDescription.toLowerCase();
    if (/\b(debug|fix|bug|error|crash|broken|issue|exception)\b/.test(desc))
      return "debug";
    if (/\b(test|spec|coverage|jest|vitest|mocha|unit|e2e)\b/.test(desc))
      return "test";
    if (/\b(review|analyze|quality|lint|refactor|improve|suggest)\b/.test(desc))
      return "review";
    if (/\b(plan|break|steps|design|architect|outline|strategy)\b/.test(desc))
      return "plan";
    return "code";
  }

  async execute(task: Task): Promise<TaskResult> {
    let mode = this.currentMode;
    if (task.metadata?.mode && task.metadata.mode !== "auto") {
      // The task explicitly requests a mode — this always wins, even over
      // a mode pinned at construction (a caller building a task-specific
      // override is making a more specific choice than the agent's default).
      mode = task.metadata.mode as AgentMode;
    } else if (!this.modeExplicitlySet) {
      // Only auto-detect when nobody already chose a mode for this agent.
      mode = this.detectMode(task.description);
    }
    this.setMode(mode);
    pushSubagentContext({
      parentTask: task,
      parentToolNames: this.getTools().map((t) => t.name),
    });

    const turnStartWallTime = Date.now();
    let tokensUsed = 0;
    let toolCalls = 0;

    // ---- Telemetry: turn start ----
    const turnNumber = ++this.turnCounter;
    const collector = TelemetryCollector.getInstance();

    // Share session/turn context with BaseAgent so callLLM/executeTool inherit it
    this.telemetrySessionId = collector.getSessionId();
    this.telemetryTurnNumber = turnNumber;

    // safeRecordTurnStart() already swallows and logs its own errors — no
    // need for a second try/catch layer around the call site.
    this.safeRecordTurnStart(collector, turnNumber, mode);

    try {
      try {
        const context = await this.initializeContext(task);

        const memorySpinner = ora({
          text: "Searching past sessions for context...",
          spinner: "dots",
        }).start();
        await context.memory.initSession();
        memorySpinner.succeed("Context loaded");

        // Context Epoch: build the baseline system prompt once (mode +
        // skill instructions + a snapshot of date/git-status/project
        // instructions) and reuse it verbatim for every LLM call in this
        // task — never rebuilt mid-task, so it stays eligible for the
        // provider's prompt cache (see ClaudeProvider's cache_control).
        const epoch: ContextEpoch = await createContextEpoch(
          buildTaskSystemPrompt(this.currentMode, task),
          process.cwd(),
        );
        const systemPrompt = epoch.baselineSystemPrompt;

        this.addMessage("user", task.description);

        const relevantMemories = await context.memory.search(
          task.description,
          5,
        );
        if (relevantMemories.length > 0) {
          const memoryContext = relevantMemories
            .map((r) => `[${r.entry.type}] ${r.entry.content}`)
            .join("\n\n");
          this.addMessage(
            "user",
            `Relevant context from memory:\n\n${memoryContext}`,
          );
        }

        let iterations = 0;
        const maxIterations = this.config.maxIterations;
        let lastOutput = "";
        let consecutiveIdle = 0;
        let identicalActionCount = 0;
        let lastToolCallsString = "";
        const EARLY_EXIT_THRESHOLD = 3;
        const ACTION_CYCLE_LIMIT = 3;
        const streamingEnabled = getConfigManager().get().defaults.streaming;

        while (iterations < maxIterations) {
          const iterationNum = iterations + 1;

          const llmSpinner = ora({
            text: chalk.italic.gray(
              this.getThinkingDescription(this.currentMode, iterationNum),
            ),
            spinner: "dots",
          }).start();

          let compResult: CompletionResult | null = null;
          let retries = 0;
          const maxRetries = 3;
          let hasFallenBack = false;

          while (retries < maxRetries) {
            try {
              if (streamingEnabled) {
                const streamIter = (await this.callLLM({
                  systemPrompt,
                  stream: true,
                })) as AsyncIterable<StreamChunk>;

                let collected = "";
                let firstChunk = true;
                for await (const chunk of streamIter) {
                  if (firstChunk && chunk.content) {
                    llmSpinner.stop();
                    firstChunk = false;
                  }
                  if (chunk.content) {
                    process.stdout.write(chunk.content);
                    collected += chunk.content;
                  }
                }
                if (!firstChunk) {
                  process.stdout.write("\n");
                }

                const estTokens = this.estimateTokenCount([
                  { role: "assistant", content: collected },
                ]);
                compResult = {
                  content: collected,
                  usage: {
                    totalTokens: estTokens,
                    inputTokens: 0,
                    outputTokens: estTokens,
                  },
                  model: context.model,
                  finishReason: "stop",
                };
              } else {
                const result = await this.callLLM({
                  systemPrompt,
                  stream: false,
                });
                compResult = result as CompletionResult;
              }
              break;
            } catch (err) {
              retries++;
              const classified = classifyFailure(err);
              this.logger.debug(
                `LLM call failed (attempt ${retries}/${maxRetries}, category=${classified.category}, retryable=${classified.retryable}): ${classified.reason} — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
              );

              const exhausted = retries >= maxRetries;
              const nonRetryable = !classified.retryable;
              // Only worth trying a different provider if switching
              // plausibly helps (shouldChangeStrategy) or we've exhausted
              // retries on an otherwise-retryable error (where a
              // different provider is a reasonable last resort even
              // without an explicit signal). A category like
              // internal_error is deliberately neither retryable NOR
              // shouldChangeStrategy — a bug in our own request-building
              // code fails identically on any provider, so no fallback
              // attempt should be wasted on it either.
              const worthTryingFallback =
                (classified.shouldChangeStrategy || exhausted) && !hasFallenBack;

              if (worthTryingFallback) {
                hasFallenBack = true;
                console.log(
                  chalk.yellow(
                    `\n${nonRetryable ? `Non-retryable error (${classified.category})` : "All retries failed"} for ${context.provider.getType()}. Attempting dynamic fallback...`,
                  ),
                );
                if (await this.attemptDynamicFallback(context)) {
                  retries = 0;
                  continue;
                }
              }

              // Either non-retryable with no (useful) fallback available,
              // or retryable but out of both retries and fallback options.
              if (nonRetryable || exhausted) throw err;

              const delayMs = Math.pow(2, retries) * 1000;
              console.log(
                chalk.yellow(
                  `LLM call encountered an error (${classified.category}). Retrying in ${delayMs}ms... (Attempt ${retries}/${maxRetries})`,
                ),
              );
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }

          llmSpinner.stop();

          if (!compResult) {
            throw new Error("Failed to receive LLM response after retries.");
          }

          let content = "";
          let tokens = 0;

          content = compResult.content;
          tokens = compResult.usage?.totalTokens || 0;

          if (!streamingEnabled) {
            // Buffered mode: strip tool calls / stray XML and render once as markdown.
            // (Streaming mode already printed raw tokens live as they arrived.)
            const displayContent = content
              .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
              .replace(/<\/?[\w\s="'-]+>/gi, "") // aggressive fallback for broken tags
              .trim();

            if (displayContent) {
              console.log(marked.parse(displayContent));
            }
          }

          if (!tokens) {
            tokens = this.estimateTokenCount([{ role: "assistant", content }]);
          }

          tokensUsed += tokens;
          lastOutput = content;

          const result = { content };

          // Prefer native tool calls, fallback to text parser if empty
          let toolCallsInOutput: Array<{
            name: string;
            params: Record<string, unknown>;
          }> = [];
          if (compResult.toolCalls && compResult.toolCalls.length > 0) {
            toolCallsInOutput = compResult.toolCalls;
          } else {
            toolCallsInOutput = this.parseToolCalls(result.content);
          }

          // --- Action Cycle Detector ---
          const currentToolCallsString = JSON.stringify(toolCallsInOutput);
          if (
            toolCallsInOutput.length > 0 &&
            currentToolCallsString === lastToolCallsString
          ) {
            identicalActionCount++;
            if (identicalActionCount >= ACTION_CYCLE_LIMIT) {
              console.log(
                chalk.red(
                  `\nAction Cycle Detected (${ACTION_CYCLE_LIMIT} identical actions). Injecting intervention...`,
                ),
              );
              this.addMessage(
                "system",
                "ACTION CYCLE DETECTED: You have attempted the exact same tool calls multiple times without progressing. You MUST rethink your approach, try a different file, or change your methodology completely. Do not repeat the same action.",
              );
              identicalActionCount = 0; // reset
            }
          } else {
            identicalActionCount = 0;
            lastToolCallsString = currentToolCallsString;
          }

          toolCalls += toolCallsInOutput.length;

          if (toolCallsInOutput.length === 0) {
            consecutiveIdle++;
            if (consecutiveIdle >= EARLY_EXIT_THRESHOLD) {
              console.log(
                chalk.yellow("No more actions needed. Finishing up...\n"),
              );
              break;
            }
          } else {
            consecutiveIdle = 0;
          }

          if (toolCallsInOutput.length === 0 && iterations > 0) {
            break;
          }

          let consecutiveToolErrors = 0;
          const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

          const toolResults: string[] = [];
          for (const { name, params } of toolCallsInOutput) {
            const toolSpinner = ora({
              text: this.getToolDescription(name, params),
              spinner: "dots",
            }).start();

            try {
              // A high-risk task always gets linted by workspace_verify,
              // regardless of whether the model remembered to ask for it
              // (same "override effective params" pattern used for
              // pre-tool-use hook modifications in BaseAgent.executeTool()).
              const effectiveParams =
                name === "workspace_verify" && context.task.risk === "high"
                  ? { ...params, risk: "high" }
                  : params;
              const res = await this.executeTool(name, effectiveParams);
              toolSpinner.succeed(this.getToolSuccessDescription(name, params));
              let formatted = this.formatToolResult(name, res);
              const MAX_RESULT_CHARS = 16000;
              if (formatted.length > MAX_RESULT_CHARS) {
                formatted =
                  formatted.slice(0, MAX_RESULT_CHARS) +
                  `\n...[Output truncated to prevent RAM bloat (${formatted.length} total chars)]`;
              }
              toolResults.push(formatted);
              consecutiveToolErrors = 0;
            } catch (error) {
              consecutiveToolErrors++;
              const errMsg =
                error instanceof Error ? error.message : "Unknown error";
              toolSpinner.fail(`Error: ${errMsg}`);
              toolResults.push(
                `Tool execution failed for '${name}' with parameters ${JSON.stringify(params)}.\nError details: ${errMsg}\nPlease analyze the error, correct your parameters or approach, and try again.`,
              );

              if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
                console.log(
                  chalk.red(
                    `Exceeded maximum consecutive tool execution failures (${MAX_CONSECUTIVE_TOOL_ERRORS}). Aborting tool loop to prevent infinite loop.`,
                  ),
                );
                break;
              }
            }
          }

          this.addMessage("assistant", result.content);
          this.addMessage("user", toolResults.join("\n\n"));

          // Tool calls (e.g. git commit, or the task just running long
          // enough to cross a day boundary) can make the epoch's cached
          // sources stale. Append a small delta instead of rebuilding the
          // baseline — rebuilding would defeat the provider's prompt cache.
          if (toolCallsInOutput.length > 0) {
            const drift = await checkContextDrift(epoch, process.cwd());
            if (drift) {
              this.addMessage("system", drift);
            }
          }

          iterations++;
        }

        const flushSpinner = ora({
          text: "Saving session to memory...",
          spinner: "dots",
        }).start();
        await context.memory.flushSession();
        flushSpinner.succeed("Session saved");

        context.memory.logExecution(
          "universal",
          task.description,
          lastOutput,
          Date.now() - turnStartWallTime,
          { tokensUsed, toolCalls, iterations, mode: this.currentMode },
        );

        const taskResult = this.complete(true, lastOutput);

        // ---- Telemetry: turn end (success) ----
        this.finalizeTurn(collector, turnNumber, mode);

        return taskResult;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.log("");
        console.log(chalk.red("  ┌─ ") + chalk.bold.red("Execution Error"));
        console.log(chalk.gray("  │  ") + chalk.white(errorMessage));

        if (
          errorMessage.includes("fetch failed") ||
          errorMessage.includes("ECONNREFUSED")
        ) {
          console.log(
            chalk.gray("  │  ") +
              chalk.yellow(
                "Recommendation: Ensure your AI provider (e.g., Ollama) is running and accessible.",
              ),
          );
        }
        console.log(chalk.red("  └──────────────────────────────────\n"));

        // ---- Telemetry: turn end (error) ----
        this.finalizeTurn(collector, turnNumber, mode);

        return this.complete(false, `Task failed: ${errorMessage}`);
      }
    } finally {
      popSubagentContext();
    }
  }

  /**
   * Attempts to re-route context.provider/context.model to a different
   * provider, excluding the one that just failed. Returns true if a
   * different provider was actually found and switched to, false if none
   * was available (e.g. only one API key configured) — the caller decides
   * what to do next (retry fresh vs. give up) based on that.
   */
  private async attemptDynamicFallback(context: AgentContext): Promise<boolean> {
    try {
      // Reuse the shared, already-configured router singleton (set up in
      // BaseAgent.initializeContext()) rather than a bare `new
      // ModelRouter()`, which would silently ignore the user's
      // preferLocal/fallbackToPaid config.
      const router = getModelRouter();
      const tokens = this.estimateTokenCount(context.messages);
      // Exclude the provider that just failed — isAvailable() caches its
      // result for the process lifetime, so without this, route() would
      // just re-select the same provider that just failed.
      const routing = await router.route(this.getTaskCategory(), tokens, {
        exclude: [context.provider.getType()],
      });
      context.provider = routing.provider;
      context.model = routing.model;
      console.log(
        chalk.green(
          `Switched to ${context.provider.getType()}/${context.model}. Retrying...`,
        ),
      );
      return true;
    } catch (fallbackErr) {
      // No other provider available either — the caller surfaces the
      // original LLM error, not this routing error.
      this.logger.debug(
        `Dynamic fallback found no alternate provider: ${
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        }`,
      );
      return false;
    }
  }

  /**
   * Safely record turn_start telemetry event.
   */
  private safeRecordTurnStart(
    collector: TelemetryCollector,
    turnNumber: number,
    mode: string,
  ): void {
    try {
      collector.recordTurnStart(collector.getSessionId(), turnNumber, mode);
    } catch (err) {
      // Telemetry must never crash the agent
      this.logger.debug(
        `Turn-start telemetry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Finalize a turn: build summary, print to console, record turn_end.
   * All wrapped in try/catch for graceful degradation.
   */
  private finalizeTurn(
    collector: TelemetryCollector,
    turnNumber: number,
    mode: string,
  ): void {
    try {
      const summary = collector.buildSummary(turnNumber);

      // Print human-readable summary to console
      collector.printSummary(summary, turnNumber);

      // Record turn_end event
      const turnDurationMs = this.state?.startTime
        ? Date.now() - this.state.startTime.getTime()
        : 0;
      collector.recordTurnEnd(
        collector.getSessionId(),
        turnNumber,
        turnDurationMs,
        summary,
      );
    } catch (err) {
      // Telemetry must never crash the agent
      this.logger.debug(
        `Turn-end telemetry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getModeDescription(mode: AgentMode): string {
    const descriptions: Record<AgentMode, string> = {
      code: "writing or modifying code",
      debug: "debugging and fixing issues",
      test: "writing or running tests",
      review: "reviewing and analyzing code",
      plan: "planning and breaking down tasks",
    };
    return descriptions[mode];
  }

  private getThinkingDescription(mode: AgentMode, iteration: number): string {
    if (iteration === 1) {
      const initial: Record<AgentMode, string> = {
        code: "Analyzing requirements and planning approach...",
        debug: "Investigating issue and scanning codebase...",
        test: "Reviewing code structure for test coverage...",
        review: "Scanning code for quality and security...",
        plan: "Understanding goals and breaking down tasks...",
      };
      return initial[mode] || "Analyzing request...";
    }

    const followUps = [
      "Evaluating tool results...",
      "Formulating next steps...",
      "Refining implementation...",
      "Synthesizing information...",
      "Finalizing details...",
    ];
    return followUps[Math.min(iteration - 2, followUps.length - 1)];
  }

  private getToolDescription(
    name: string,
    params: Record<string, unknown>,
  ): string {
    const formatPath = (p?: unknown) =>
      p
        ? chalk.cyan(path.relative(process.cwd(), p as string))
        : "unknown file";

    switch (name) {
      case "file_read":
        return `Reading ${formatPath(params.path)}...`;
      case "file_write":
        return `Writing ${formatPath(params.path)}...`;
      case "directory_create":
        return `Creating directory ${formatPath(params.path)}...`;
      case "shell_exec":
        return `Running command: ${chalk.cyan(params.command || "unknown")}...`;
      case "git_status":
        return "Checking git status...";
      case "git_diff":
        return "Checking git diff...";
      case "git_add":
        return "Staging changes...";
      case "git_commit":
        return "Committing changes...";
      case "test_run":
        return "Running tests...";
      case "coverage_report":
        return "Generating coverage report...";
      default:
        return `Executing ${name}...`;
    }
  }

  private getToolSuccessDescription(
    name: string,
    params: Record<string, unknown>,
  ): string {
    const formatPath = (p?: unknown) =>
      p
        ? chalk.cyan(path.relative(process.cwd(), p as string))
        : "unknown file";

    switch (name) {
      case "file_read":
        return `Read ${formatPath(params.path)}`;
      case "file_write":
        return `Wrote ${formatPath(params.path)}`;
      case "directory_create":
        return `Created directory ${formatPath(params.path)}`;
      case "shell_exec":
        return `Executed command`;
      case "git_status":
        return "Retrieved git status";
      case "git_diff":
        return "Retrieved git diff";
      case "git_add":
        return "Staged changes";
      case "git_commit":
        return "Committed changes";
      case "test_run":
        return "Completed tests";
      case "coverage_report":
        return "Generated coverage report";
      default:
        return `${name} completed`;
    }
  }

  protected buildSystemPrompt(): string {
    return SYSTEM_PROMPTS[this.currentMode];
  }

  private registerDefaultTools(): void {
    this.setMode("code");
  }
}
