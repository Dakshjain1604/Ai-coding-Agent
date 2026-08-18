/**
 * TelemetryCollector - Session metrics, token tracking, and turn execution summaries
 */

import chalk from "chalk";
import crypto from "crypto";

export interface LLMCallMetrics {
  turnNumber: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  cost: number;
}

export interface ToolCallMetrics {
  turnNumber: number;
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface TurnSummary {
  turnNumber: number;
  totalLLMCalls: number;
  totalLLMDurationMs: number;
  totalToolCalls: number;
  totalToolDurationMs: number;
  failedTools: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  providerBreakdown: Record<string, { calls: number; tokens: number; cost: number }>;
  toolBreakdown: Record<string, { calls: number; failed: number }>;
}

export class TelemetryCollector {
  private static instance: TelemetryCollector | null = null;
  private sessionId: string;
  private enabled: boolean = true;
  private llmCalls: LLMCallMetrics[] = [];
  private toolCalls: ToolCallMetrics[] = [];

  private constructor() {
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : `sess_${Date.now()}`;
  }

  public static getInstance(): TelemetryCollector {
    if (!TelemetryCollector.instance) {
      TelemetryCollector.instance = new TelemetryCollector();
    }
    return TelemetryCollector.instance;
  }

  public static resetInstance(): void {
    TelemetryCollector.instance = new TelemetryCollector();
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public recordLLMCall(
    _sessionId: string,
    turnNumber: number,
    provider: string,
    model: string,
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number },
    cost: number,
    durationMs: number,
  ): void {
    if (!this.enabled) return;
    this.llmCalls.push({
      turnNumber,
      provider,
      model,
      inputTokens: tokens.promptTokens,
      outputTokens: tokens.completionTokens,
      totalTokens: tokens.totalTokens,
      durationMs,
      cost,
    });
  }

  public recordToolCall(
    _sessionId: string,
    turnNumber: number,
    name: string,
    _args: Record<string, unknown>,
    success: boolean,
    durationMs: number,
    error?: string,
  ): void {
    if (!this.enabled) return;
    this.toolCalls.push({
      turnNumber,
      name,
      durationMs,
      success,
      error,
    });
  }

  public recordTurnStart(_sessionId: string, _turnNumber: number, _mode: string): void {
    // Session turn start hook
  }

  public recordTurnEnd(
    _sessionId: string,
    _turnNumber: number,
    _durationMs: number,
    _summary: TurnSummary,
  ): void {
    // Session turn end hook
  }

  public buildSummary(turnNumber: number): TurnSummary {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let totalLLMDurationMs = 0;

    const providerBreakdown: Record<string, { calls: number; tokens: number; cost: number }> = {};

    // Scoped to this turn only — the arrays are never cleared (a
    // resettable session-lifetime log is intentional, e.g. for future
    // session-total reporting), so without this filter a later turn's
    // summary would silently include every earlier turn's calls too.
    const turnLLMCalls = this.llmCalls.filter((c) => c.turnNumber === turnNumber);
    const turnToolCalls = this.toolCalls.filter((c) => c.turnNumber === turnNumber);

    for (const call of turnLLMCalls) {
      promptTokens += call.inputTokens;
      completionTokens += call.outputTokens;
      totalTokens += call.totalTokens;
      totalCost += call.cost;
      totalLLMDurationMs += call.durationMs;

      if (!providerBreakdown[call.provider]) {
        providerBreakdown[call.provider] = { calls: 0, tokens: 0, cost: 0 };
      }
      providerBreakdown[call.provider].calls += 1;
      providerBreakdown[call.provider].tokens += call.totalTokens;
      providerBreakdown[call.provider].cost += call.cost;
    }

    let totalToolDurationMs = 0;
    let failedTools = 0;
    const toolBreakdown: Record<string, { calls: number; failed: number }> = {};

    for (const tool of turnToolCalls) {
      totalToolDurationMs += tool.durationMs;
      if (!tool.success) failedTools++;

      if (!toolBreakdown[tool.name]) {
        toolBreakdown[tool.name] = { calls: 0, failed: 0 };
      }
      toolBreakdown[tool.name].calls += 1;
      if (!tool.success) toolBreakdown[tool.name].failed += 1;
    }

    return {
      turnNumber,
      totalLLMCalls: turnLLMCalls.length,
      totalLLMDurationMs,
      totalToolCalls: turnToolCalls.length,
      totalToolDurationMs,
      failedTools,
      promptTokens,
      completionTokens,
      totalTokens,
      totalCost,
      providerBreakdown,
      toolBreakdown,
    };
  }

  public printSummary(summary: TurnSummary, turnNumber: number): void {
    console.log("");
    console.log(chalk.cyan("  ┌─ ") + chalk.bold.cyan(`Turn ${turnNumber} Summary`));
    console.log(chalk.cyan("  │"));
    console.log(
      chalk.cyan("  │  LLM Calls:    ") +
        chalk.white(`${summary.totalLLMCalls}`) +
        chalk.gray(`  (${summary.totalLLMDurationMs}ms)`),
    );
    console.log(
      chalk.cyan("  │  Tool Calls:   ") +
        chalk.white(`${summary.totalToolCalls}`) +
        chalk.gray(`  (${summary.totalToolDurationMs}ms)`),
    );
    if (summary.failedTools > 0) {
      console.log(
        chalk.cyan("  │  Failed Tools: ") + chalk.red(`${summary.failedTools}`),
      );
    }
    console.log(
      chalk.cyan("  │  Tokens:       ") +
        chalk.white(
          `${summary.promptTokens} prompt + ${summary.completionTokens} completion = ${summary.totalTokens} total`,
        ),
    );
    console.log(
      chalk.cyan("  │  Cost:         ") + chalk.green(`$${summary.totalCost.toFixed(6)}`),
    );

    if (Object.keys(summary.providerBreakdown).length > 0) {
      console.log(chalk.cyan("  │"));
      for (const [provider, stats] of Object.entries(summary.providerBreakdown)) {
        console.log(
          chalk.cyan("  │  ") +
            chalk.white(
              `${provider}: ${stats.calls} calls, ${stats.tokens} tokens, $${stats.cost.toFixed(6)}`,
            ),
        );
      }
    }

    if (Object.keys(summary.toolBreakdown).length > 0) {
      console.log(chalk.cyan("  │"));
      for (const [name, stats] of Object.entries(summary.toolBreakdown)) {
        const failStr = stats.failed > 0 ? chalk.red(` (${stats.failed} failed)`) : "";
        console.log(chalk.cyan("  │  ") + chalk.white(`${name}: ${stats.calls} calls${failStr}`));
      }
    }

    console.log(chalk.cyan("  └──────────────────────────────────\n"));
  }
}
