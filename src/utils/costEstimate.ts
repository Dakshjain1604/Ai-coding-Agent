/**
 * Cost Estimation
 * Estimates the potential cost of a task before execution
 */

import { getConfigManager } from "../utils/config.js";
import chalk from "chalk";

export interface CostEstimate {
  provider: string;
  model: string;
  estimatedTokens: number;
  estimatedCost: number;
  maxIterations: number;
  maxToolCalls: number;
  worstCaseCost: number;
}

export interface TaskCostSummary {
  estimates: CostEstimate[];
  totalWorstCase: number;
  primaryEstimate: CostEstimate;
}

/**
 * Estimate cost for a task based on complexity and agent type
 */
export function estimateTaskCost(
  agentType: string,
  complexity: "simple" | "medium" | "complex" = "medium",
): TaskCostSummary {
  const config = getConfigManager().get();

  // Base token estimates by complexity
  const baseTokens = {
    simple: 2000,
    medium: 8000,
    complex: 25000,
  };

  // Tool call estimates
  const toolCallEstimates = {
    simple: 5,
    medium: 15,
    complex: 30,
  };

  // Agent iteration defaults
  const agentIterations = {
    orchestrator: 15,
    plan: 10,
    code: 15,
    test: 15,
    debug: 10,
    review: 10,
  };

  const baseTokenCount = baseTokens[complexity];
  const estimatedToolCalls = toolCallEstimates[complexity];
  const iterations =
    agentIterations[agentType as keyof typeof agentIterations] ?? 10;

  const estimates: CostEstimate[] = [];

  // Check each provider
  for (const provider of config.providers) {
    if (!provider.enabled) continue;

    const model =
      provider.models?.code ?? provider.models?.complex ?? "default";
    const modelCost = getModelCost(provider.type, model);

    // Estimate: base tokens + (iterations * tokens per iteration)
    const totalTokens = baseTokenCount + iterations * 500;
    const cost = (totalTokens / 1_000_000) * modelCost;

    // Worst case: max iterations * tokens per iteration
    const maxTokens =
      baseTokenCount +
      config.agents[agentType as keyof typeof config.agents]?.maxIterations! *
        1000;
    const worstCase = (maxTokens / 1_000_000) * modelCost;

    estimates.push({
      provider: provider.type,
      model,
      estimatedTokens: totalTokens,
      estimatedCost: cost,
      maxIterations:
        config.agents[agentType as keyof typeof config.agents]?.maxIterations ??
        iterations,
      maxToolCalls:
        config.agents[agentType as keyof typeof config.agents]?.maxToolCalls ??
        estimatedToolCalls,
      worstCaseCost: worstCase,
    });
  }

  // Add local provider as fallback if no providers enabled
  if (estimates.length === 0) {
    estimates.push({
      provider: "local (Ollama)",
      model: "qwen2.5-coder:latest",
      estimatedTokens: baseTokenCount,
      estimatedCost: 0, // Local is free
      maxIterations: iterations,
      maxToolCalls: estimatedToolCalls,
      worstCaseCost: 0,
    });
  }

  const totalWorstCase = estimates.reduce((sum, e) => sum + e.worstCaseCost, 0);

  return {
    estimates,
    totalWorstCase,
    primaryEstimate: estimates[0],
  };
}

function getModelCost(provider: string, model: string): number {
  // Cost per 1M tokens (approximate)
  const costs: Record<string, number> = {
    // Ollama (local - free)
    "qwen2.5-coder:latest": 0,
    "qwen3.5:2b": 0,
    "llama3.2:3b": 0,
    "deepseek-coder:6.7b": 0,
    "mixtral:8x7b": 0,

    // Claude
    "claude-opus-4-6": 15,
    "claude-sonnet-4-6": 3,
    "claude-haiku-4-5-20251001": 0.8,

    // OpenAI
    "gpt-4o": 2.5,
    "gpt-4o-mini": 0.15,
    "o1-preview": 15,

    // Gemini
    "gemini-2.0-flash": 0.075,
    "gemini-2.0-pro": 1.25,
  };

  return costs[model] ?? 0;
}

/**
 * Print cost estimate to console
 */
export function printCostEstimate(summary: TaskCostSummary): void {
  console.log(chalk.bold("\n💰 Cost Estimate\n"));

  for (const estimate of summary.estimates) {
    if (estimate.estimatedCost === 0) {
      console.log(chalk.green(`  ${estimate.provider}:`));
      console.log(chalk.gray(`    Model: ${estimate.model}`));
      console.log(chalk.gray(`    Estimated: $0.00 (local)`));
    } else {
      console.log(chalk.yellow(`  ${estimate.provider}:`));
      console.log(chalk.gray(`    Model: ${estimate.model}`));
      console.log(
        chalk.gray(
          `    Estimated: $${estimate.estimatedCost.toFixed(4)} (${estimate.estimatedTokens.toLocaleString()} tokens)`,
        ),
      );
      console.log(
        chalk.gray(
          `    Worst case: $${estimate.worstCaseCost.toFixed(4)} (${estimate.maxIterations} iterations)`,
        ),
      );
    }
  }

  if (summary.totalWorstCase > 0) {
    console.log(
      chalk.gray(
        `\n  Max potential cost: $${summary.totalWorstCase.toFixed(4)}`,
      ),
    );
  } else {
    console.log(chalk.green(`\n  Cost: $0.00 (using local models)`));
  }
  console.log("");
}
