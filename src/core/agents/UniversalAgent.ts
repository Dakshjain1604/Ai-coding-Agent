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
import { registerBuiltInTools } from "../tools/built-in.js";

export class UniversalAgent extends BaseAgent {
  private currentMode: AgentMode = "code";
  /** Incrementing counter for turn numbers across the agent's lifetime */
  private turnCounter: number = 0;

  constructor(mode?: AgentMode) {
    super("code", {});
    // Ensure built-in tools are registered in the singleton ToolRegistry
    registerBuiltInTools();
    if (mode) {
      this.setMode(mode);
    } else {
      this.registerDefaultTools();
    }
  }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
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
      mode = task.metadata.mode as AgentMode;
    } else {
      mode = this.detectMode(task.description);
    }
    this.setMode(mode);

    const turnStartWallTime = Date.now();
    let tokensUsed = 0;
    let toolCalls = 0;

    // ---- Telemetry: turn start ----
    const turnNumber = ++this.turnCounter;
    const collector = TelemetryCollector.getInstance();

    // Share session/turn context with BaseAgent so callLLM/executeTool inherit it
    this.telemetrySessionId = collector.getSessionId();
    this.telemetryTurnNumber = turnNumber;

    try {
      this.safeRecordTurnStart(collector, turnNumber, mode);
    } catch {
      // Telemetry must never crash the agent
    }

    try {
      const context = await this.initializeContext(task);

      const memorySpinner = ora({
        text: "Searching past sessions for context...",
        spinner: "dots",
      }).start();
      await context.memory.initSession();
      await context.memory.startConversation();
      memorySpinner.succeed("Context loaded");

      const outputDir = (task.metadata?.outputDir as string) || process.cwd();
      const systemPrompt =
        SYSTEM_PROMPTS[this.currentMode] +
        `\n\nIMPORTANT: Write ALL output files to this directory: ${outputDir}`;
      this.addMessage("user", task.description);

      const relevantMemories = await context.memory.search(task.description, 5);
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

      while (iterations < maxIterations) {
        const iterationNum = iterations + 1;

        const llmSpinner = ora({
          text: chalk.italic.gray(this.getThinkingDescription(this.currentMode, iterationNum)),
          spinner: "dots",
        }).start();

        let compResult: import("../../providers/ProviderInterface.js").CompletionResult | null = null;
        let retries = 0;
        const maxRetries = 3;
        let hasFallenBack = false;
        
        while (retries < maxRetries) {
          try {
            const stream = await this.callLLM({ systemPrompt, stream: false });
            compResult = stream as import("../../providers/ProviderInterface.js").CompletionResult;
            break;
          } catch (err) {
            retries++;
            
            if (retries >= maxRetries && !hasFallenBack) {
              hasFallenBack = true;
              try {
                console.log(chalk.yellow(`\nAll retries failed for ${context.provider.getType()}. Attempting dynamic fallback...`));
                const router = new (await import("../../providers/ModelRouter.js")).ModelRouter();
                const tokens = this.estimateTokenCount(context.messages);
                const routing = await router.route("complex", tokens);
                context.provider = routing.provider;
                context.model = routing.model;
                console.log(chalk.green(`Switched to ${context.provider.getType()}/${context.model}. Retrying...`));
                retries = 0;
                continue;
              } catch(fallbackErr) {
                // If fallback fails, throw original error
              }
            }
            
            if (retries >= maxRetries) throw err;
            
            const delayMs = Math.pow(2, retries) * 1000;
            console.log(
              chalk.yellow(
                `LLM call encountered an error. Retrying in ${delayMs}ms... (Attempt ${retries}/${maxRetries})`,
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

        // Strip out tool calls and stray XML for clean display
        const displayContent = content
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
          .replace(/<\/?[\w\s="'-]+>/gi, "") // aggressive fallback for broken tags
          .trim();

        if (displayContent) {
          console.log(marked.parse(displayContent));
        }

        if (!tokens) {
          tokens = this.estimateTokenCount([{ role: "assistant", content }]);
        }

        tokensUsed += tokens;
        lastOutput = content;

        const result = { content };

        // Prefer native tool calls, fallback to text parser if empty
        let toolCallsInOutput: Array<{ name: string; params: Record<string, unknown> }> = [];
        if (compResult.toolCalls && compResult.toolCalls.length > 0) {
          toolCallsInOutput = compResult.toolCalls;
        } else {
          toolCallsInOutput = this.parseToolCalls(result.content);
        }

        // --- Action Cycle Detector ---
        const currentToolCallsString = JSON.stringify(toolCallsInOutput);
        if (toolCallsInOutput.length > 0 && currentToolCallsString === lastToolCallsString) {
          identicalActionCount++;
          if (identicalActionCount >= ACTION_CYCLE_LIMIT) {
             console.log(chalk.red(`\nAction Cycle Detected (${ACTION_CYCLE_LIMIT} identical actions). Injecting intervention...`));
             this.addMessage("system", "ACTION CYCLE DETECTED: You have attempted the exact same tool calls multiple times without progressing. You MUST rethink your approach, try a different file, or change your methodology completely. Do not repeat the same action.");
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
            const res = await this.executeTool(name, params);
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

      if (errorMessage.includes("fetch failed") || errorMessage.includes("ECONNREFUSED")) {
        console.log(chalk.gray("  │  ") + chalk.yellow("Recommendation: Ensure your AI provider (e.g., Ollama) is running and accessible."));
      }
      console.log(chalk.red("  └──────────────────────────────────\n"));

      // ---- Telemetry: turn end (error) ----
      this.finalizeTurn(collector, turnNumber, mode);

      return this.complete(false, `Task failed: ${errorMessage}`);
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
      collector.recordTurnStart(
        collector.getSessionId(),
        turnNumber,
        mode,
      );
    } catch {
      // Telemetry must never crash the agent
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
    } catch {
      // Telemetry must never crash the agent
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
      "Finalizing details..."
    ];
    return followUps[Math.min(iteration - 2, followUps.length - 1)];
  }

  private getToolDescription(
    name: string,
    params: Record<string, unknown>,
  ): string {
    const formatPath = (p?: unknown) =>
      p ? chalk.cyan(path.relative(process.cwd(), p as string)) : "unknown file";

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
      p ? chalk.cyan(path.relative(process.cwd(), p as string)) : "unknown file";

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
