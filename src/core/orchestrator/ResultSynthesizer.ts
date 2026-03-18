/**
 * Result Synthesizer - Aggregates and synthesizes results from multiple agents
 */

import { getLogger } from '../../utils/logger.js';
import type { TaskResult } from '../../utils/types.js';
import { getMemoryManager } from '../../memory/MemoryManager.js';
import type { BaseProvider } from '../../providers/ProviderInterface.js';
import { getProviderFactory } from '../../providers/ProviderFactory.js';

export interface SynthesisOptions {
  includeArtifacts: boolean;
  summarize: boolean;
  storeInMemory: boolean;
}

export interface SynthesisResult {
  summary: string;
  success: boolean;
  agentResults: Map<string, TaskResult>;
  conflicts: Conflict[];
  recommendations: string[];
}

export interface Conflict {
  type: 'content' | 'artifact' | 'decision';
  agents: string[];
  description: string;
  resolution?: string;
}

/**
 * Result Synthesizer
 * Aggregates results from multiple agents into a unified output
 */
export class ResultSynthesizer {
  private logger = getLogger();

  /**
   * Synthesize results from multiple agents
   */
  async synthesize(
    results: Map<string, TaskResult>,
    options?: SynthesisOptions
  ): Promise<SynthesisResult> {
    const opts: SynthesisOptions = {
      includeArtifacts: options?.includeArtifacts ?? true,
      summarize: options?.summarize ?? true,
      storeInMemory: options?.storeInMemory ?? true,
      ...options,
    };

    this.logger.debug(`Synthesizing ${results.size} agent results`);

    // Check for conflicts
    const conflicts = this.detectConflicts(results);

    // Determine overall success
    const success = Array.from(results.values()).every((r) => r.success);

    // Generate summary
    let summary: string;
    if (opts.summarize) {
      summary = await this.generateSummary(results, conflicts);
    } else {
      summary = this.formatResults(results);
    }

    // Store in memory
    if (opts.storeInMemory) {
      await this.storeInMemory(results, summary);
    }

    // Generate recommendations
    const recommendations = this.generateRecommendations(results, conflicts);

    return {
      summary,
      success,
      agentResults: results,
      conflicts,
      recommendations,
    };
  }

  /**
   * Detect conflicts between agent outputs
   */
  private detectConflicts(results: Map<string, TaskResult>): Conflict[] {
    const conflicts: Conflict[] = [];

    // Group results by artifact
    const artifactMap = new Map<string, string[]>();
    for (const [agentId, result] of results) {
      if (result.artifacts) {
        for (const artifact of result.artifacts) {
          if (!artifactMap.has(artifact)) {
            artifactMap.set(artifact, []);
          }
          artifactMap.get(artifact)!.push(agentId);
        }
      }
    }

    // Check for overlapping artifacts
    for (const [artifact, agents] of artifactMap) {
      if (agents.length > 1) {
        conflicts.push({
          type: 'artifact',
          agents,
          description: `Multiple agents modified the same artifact: ${artifact}`,
          resolution: 'Last agent\'s changes take precedence',
        });
      }
    }

    // Check for content conflicts
    const outputMap = new Map<string, string[]>();
    for (const [agentId, result] of results) {
      // Extract key decisions from output
      const decisions = this.extractDecisions(result.output);
      for (const decision of decisions) {
        const key = decision.toLowerCase().trim();
        if (!outputMap.has(key)) {
          outputMap.set(key, []);
        }
        outputMap.get(key)!.push(agentId);
      }
    }

    // No direct conflict detection for content yet
    // Could use LLM to detect semantic conflicts

    return conflicts;
  }

  /**
   * Extract decisions from output
   */
  private extractDecisions(output: string): string[] {
    const decisions: string[] = [];

    // Look for decision patterns
    const patterns = [
      /(?:decision|decided|chose|selected):\s*([^\n]+)/gi,
      /(?:implemented|created|added):\s*([^\n]+)/gi,
      /(?:will|shall|should)\s+([^\n]+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        decisions.push(match[1].trim());
      }
    }

    return decisions;
  }

  /**
   * Generate summary using LLM
   */
  private async generateSummary(
    results: Map<string, TaskResult>,
    conflicts: Conflict[]
  ): Promise<string> {
    try {
      const provider = await this.getProvider();
      const prompt = this.buildSummaryPrompt(results, conflicts);

      const response = await provider.complete(
        [{ role: 'user', content: prompt }],
        { maxTokens: 2000 }
      );

      return response.content;
    } catch (error) {
      this.logger.warn(`Failed to generate summary with LLM: ${error}`);
      return this.formatResults(results);
    }
  }

  /**
   * Format results without LLM
   */
  private formatResults(results: Map<string, TaskResult>): string {
    const lines: string[] = [];

    lines.push('# Execution Results\n');

    for (const [agentId, result] of results) {
      const status = result.success ? '✓' : '✗';
      lines.push(`## ${agentId} ${status}\n`);
      lines.push(`Duration: ${result.durationMs}ms\n`);
      lines.push(`Output:\n${result.output.slice(0, 500)}\n`);
      if (result.artifacts && result.artifacts.length > 0) {
        lines.push(`Artifacts: ${result.artifacts.join(', ')}\n`);
      }
      lines.push('\n');
    }

    return lines.join('');
  }

  /**
   * Build summary prompt for LLM
   */
  private buildSummaryPrompt(
    results: Map<string, TaskResult>,
    conflicts: Conflict[]
  ): string {
    const parts: string[] = [
      'Summarize the following agent execution results into a concise, informative summary.',
      'Focus on what was accomplished, any issues encountered, and the final outcome.',
      '',
    ];

    for (const [agentId, result] of results) {
      parts.push(`Agent: ${agentId}`);
      parts.push(`Success: ${result.success}`);
      parts.push(`Duration: ${result.durationMs}ms`);
      parts.push(`Output: ${result.output.slice(0, 1000)}`);
      if (result.artifacts && result.artifacts.length > 0) {
        parts.push(`Artifacts: ${result.artifacts.join(', ')}`);
      }
      parts.push('');
    }

    if (conflicts.length > 0) {
      parts.push('Conflicts detected:');
      for (const conflict of conflicts) {
        parts.push(`- ${conflict.description}`);
      }
      parts.push('');
    }

    parts.push('Provide a summary in markdown format with:');
    parts.push('1. Overall outcome (success/failure)');
    parts.push('2. Key accomplishments');
    parts.push('3. Any issues or conflicts');
    parts.push('4. Artifacts created/modified');

    return parts.join('\n');
  }

  /**
   * Store synthesis in memory
   */
  private async storeInMemory(
    results: Map<string, TaskResult>,
    summary: string
  ): Promise<void> {
    try {
      const memory = getMemoryManager();
      await memory.store('execution', summary, {
        type: 'synthesis',
        agents: Array.from(results.keys()),
        success: Array.from(results.values()).every((r) => r.success),
      });
    } catch (error) {
      this.logger.warn(`Failed to store synthesis in memory: ${error}`);
    }
  }

  /**
   * Generate recommendations based on results
   */
  private generateRecommendations(
    results: Map<string, TaskResult>,
    conflicts: Conflict[]
  ): string[] {
    const recommendations: string[] = [];

    // Check for failures
    const failures = Array.from(results.values()).filter((r) => !r.success);
    if (failures.length > 0) {
      recommendations.push('Review failed agent outputs for error details');
      recommendations.push('Consider running failed tasks individually');
    }

    // Check for conflicts
    if (conflicts.length > 0) {
      recommendations.push('Review conflicts and verify final state');
      for (const conflict of conflicts) {
        if (!conflict.resolution) {
          recommendations.push(`Resolve conflict: ${conflict.description}`);
        }
      }
    }

    // Check for long-running tasks
    const longRunning = Array.from(results.values()).filter((r) => r.durationMs > 60000);
    if (longRunning.length > 0) {
      recommendations.push('Consider optimizing long-running tasks');
    }

    // Check for missing artifacts
    const allArtifacts = Array.from(results.values())
      .flatMap((r) => r.artifacts ?? []);
    if (allArtifacts.length === 0) {
      recommendations.push('No artifacts were created - verify execution completed');
    }

    return recommendations;
  }

  /**
   * Get LLM provider for summary generation
   */
  private async getProvider(): Promise<BaseProvider> {
    const factory = getProviderFactory();
    return factory.getBestProvider('simple');
  }
}

/**
 * Create a ResultSynthesizer instance
 */
export function createResultSynthesizer(): ResultSynthesizer {
  return new ResultSynthesizer();
}