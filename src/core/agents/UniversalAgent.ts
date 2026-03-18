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

    const startTime = Date.now();
    let tokensUsed = 0;
    let toolCalls = 0;

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
      const EARLY_EXIT_THRESHOLD = 3;

      while (iterations < maxIterations) {
        const iterationNum = iterations + 1;

        const llmSpinner = ora({
          text: chalk.italic.gray(this.getThinkingDescription(this.currentMode, iterationNum)),
          spinner: "dots",
        }).start();

        const stream = await this.callLLM({ systemPrompt, stream: false });

        llmSpinner.stop();

        let content = "";
        let tokens = 0;

        const compResult = stream as import("../../providers/ProviderInterface.js").CompletionResult;
        content = compResult.content;
        tokens = compResult.usage?.totalTokens || 0;

        // Strip out tool calls and stray XML for clean display
        const displayContent = content
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<\/?[\w\s="'-]+>/gi, '') // aggressive fallback for broken tags
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

        const toolCallsInOutput = this.parseToolCalls(result.content);
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

        const toolResults: string[] = [];
        for (const { name, params } of toolCallsInOutput) {
          const toolSpinner = ora({
            text: this.getToolDescription(name, params),
            spinner: "dots",
          }).start();

          try {
            const result = await this.executeTool(name, params);
            toolSpinner.succeed(this.getToolSuccessDescription(name, params));
            toolResults.push(this.formatToolResult(name, result));
          } catch (error) {
            toolSpinner.fail(
              `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
            toolResults.push(
              `Error executing ${name}: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
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
        Date.now() - startTime,
        { tokensUsed, toolCalls, iterations, mode: this.currentMode },
      );

      return this.complete(true, lastOutput);
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

      return this.complete(false, `Task failed: ${errorMessage}`);
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
