/**
 * Task Analyzer - Analyzes task complexity and determines execution strategy
 */

import { getLogger } from '../../utils/logger.js';
import type { Task, TaskComplexity, SpawnStrategy } from '../../utils/types.js';
import type { AgentType } from '../../utils/types.js';

export interface AnalysisResult {
  complexity: TaskComplexity;
  confidence: number;
  factors: AnalysisFactor[];
  suggestedStrategy: SpawnStrategy;
  estimatedTokens: number;
  estimatedDuration: number;
}

export interface AnalysisFactor {
  name: string;
  value: number;
  weight: number;
  description: string;
}

/**
 * Task Analyzer
 * Analyzes tasks to determine complexity and spawn strategy
 */
export class TaskAnalyzer {
  private complexityThreshold: number;
  private logger = getLogger();

  constructor(complexityThreshold: number = 0.7) {
    this.complexityThreshold = complexityThreshold;
  }

  /**
   * Analyze a task
   */
  analyze(task: Task): AnalysisResult {
    this.logger.debug(`Analyzing task: ${task.description}`);

    const factors = this.analyzeFactors(task);
    const complexity = this.calculateComplexity(factors);
    const strategy = this.determineStrategy(complexity, task);
    const estimates = this.estimateResources(complexity, task);

    return {
      complexity,
      confidence: this.calculateConfidence(factors),
      factors,
      suggestedStrategy: strategy,
      estimatedTokens: estimates.tokens,
      estimatedDuration: estimates.duration,
    };
  }

  /**
   * Analyze factors that contribute to complexity
   */
  private analyzeFactors(task: Task): AnalysisFactor[] {
    const factors: AnalysisFactor[] = [];
    const description = task.description.toLowerCase();

    // File count factor
    const fileCount = this.estimateFileCount(task);
    factors.push({
      name: 'fileCount',
      value: Math.min(fileCount / 10, 1),
      weight: 0.15,
      description: `Estimated ${fileCount} files to modify`,
    });

    // Scope factor
    const scope = this.analyzeScope(description);
    factors.push({
      name: 'scope',
      value: scope.value,
      weight: 0.2,
      description: scope.description,
    });

    // Domain complexity factor
    const domains = this.countDomains(description);
    factors.push({
      name: 'domains',
      value: Math.min(domains / 3, 1),
      weight: 0.2,
      description: `Involves ${domains} domain(s)`,
    });

    // Implementation complexity factor
    const implementation = this.analyzeImplementation(description);
    factors.push({
      name: 'implementation',
      value: implementation.value,
      weight: 0.25,
      description: implementation.description,
    });

    // Testing requirements factor
    const testing = this.analyzeTesting(description);
    factors.push({
      name: 'testing',
      value: testing.value,
      weight: 0.1,
      description: testing.description,
    });

    // Dependencies factor
    const dependencies = this.estimateDependencies(description);
    factors.push({
      name: 'dependencies',
      value: Math.min(dependencies / 5, 1),
      weight: 0.1,
      description: `~${dependencies} dependencies`,
    });

    return factors;
  }

  /**
   * Calculate overall complexity from factors
   */
  private calculateComplexity(factors: AnalysisFactor[]): TaskComplexity {
    const weightedSum = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const score = weightedSum / totalWeight;

    if (score < 0.3) return 'simple';
    if (score < 0.7) return 'medium';
    return 'complex';
  }

  /**
   * Calculate confidence in analysis
   */
  private calculateConfidence(factors: AnalysisFactor[]): number {
    // Higher confidence when factors are more certain
    const variance = factors.reduce((sum, f) => {
      const uncertainty = f.value > 0.3 && f.value < 0.7 ? 0.2 : 0;
      return sum + uncertainty;
    }, 0);

    return Math.max(0.5, 1 - variance / factors.length);
  }

  /**
   * Determine spawn strategy based on complexity
   */
  private determineStrategy(complexity: TaskComplexity, task: Task): SpawnStrategy {
    const description = task.description.toLowerCase();

    // Check for explicit agent type in metadata
    if (task.metadata?.agentType) {
      return {
        mode: 'single',
        agents: [task.metadata.agentType as AgentType],
        maxParallel: 1,
      };
    }

    // Keywords that suggest specific agents
    const agentKeywords: Record<AgentType, string[]> = {
      plan: ['plan', 'analyze', 'design', 'architecture', 'research'],
      code: ['implement', 'create', 'build', 'write', 'add', 'fix', 'update'],
      test: ['test', 'verify', 'validate', 'coverage'],
      debug: ['debug', 'fix bug', 'error', 'issue', 'problem', 'diagnose'],
      review: ['review', 'audit', 'check quality', 'analyze code'],
      orchestrator: ['coordinate', 'orchestrate', 'multi-step', 'complex'],
    };

    // Check for single-agent tasks
    for (const [agent, keywords] of Object.entries(agentKeywords)) {
      if (keywords.some((k) => description.includes(k))) {
        if (complexity === 'simple') {
          return {
            mode: 'single',
            agents: [agent as AgentType],
            maxParallel: 1,
          };
        }
      }
    }

    // Determine strategy by complexity
    switch (complexity) {
      case 'simple':
        return {
          mode: 'single',
          agents: ['code'],
          maxParallel: 1,
        };

      case 'medium':
        // Pipeline: plan -> code -> test
        if (description.includes('implement') || description.includes('create')) {
          return {
            mode: 'pipeline',
            agents: ['plan', 'code', 'test'],
            maxParallel: 1,
          };
        }
        // Debug pipeline
        if (description.includes('debug') || description.includes('fix')) {
          return {
            mode: 'pipeline',
            agents: ['debug', 'code'],
            maxParallel: 1,
          };
        }
        // Review pipeline
        if (description.includes('review')) {
          return {
            mode: 'pipeline',
            agents: ['review', 'code'],
            maxParallel: 1,
          };
        }
        // Default medium complexity
        return {
          mode: 'pipeline',
          agents: ['plan', 'code'],
          maxParallel: 1,
        };

      case 'complex': {
        // Check for parallel-friendly tasks
        const parallelAgents = this.identifyParallelAgents(description);
        if (parallelAgents.length > 1) {
          return {
            mode: 'parallel',
            agents: ['orchestrator', ...parallelAgents],
            maxParallel: 3,
          };
        }
        // Full orchestration
        return {
          mode: 'parallel',
          agents: ['orchestrator', 'plan', 'code', 'test', 'review'],
          maxParallel: 3,
        };
      }
    }
  }

  /**
   * Estimate resources needed
   */
  private estimateResources(complexity: TaskComplexity, task: Task): { tokens: number; duration: number } {
    const estimates: Record<TaskComplexity, { tokens: number; duration: number }> = {
      simple: { tokens: 5000, duration: 30000 },
      medium: { tokens: 25000, duration: 120000 },
      complex: { tokens: 100000, duration: 300000 },
    };

    const base = estimates[complexity];

    // Adjust based on description length
    const length = task.description.length;
    const lengthMultiplier = Math.min(1.5, 1 + length / 1000);

    return {
      tokens: Math.round(base.tokens * lengthMultiplier),
      duration: Math.round(base.duration * lengthMultiplier),
    };
  }

  // ============================================================================
  // Factor Analysis Helpers
  // ============================================================================

  private estimateFileCount(task: Task): number {
    const description = task.description.toLowerCase();

    // Count explicit file mentions
    const filePatterns = [
      /\b(\w+\/\w+\.\w+)\b/g, // paths like src/file.ts
      /\bfile\b/gi,
      /\bmodule\b/gi,
      /\bcomponent\b/gi,
    ];

    let count = 0;
    for (const pattern of filePatterns) {
      const matches = description.match(pattern);
      if (matches) count += matches.length;
    }

    // Check for scope indicators
    if (description.includes('project') || description.includes('entire')) {
      count = Math.max(count, 20);
    } else if (description.includes('single') || description.includes('one')) {
      count = Math.max(count, 1);
    }

    return Math.max(1, count);
  }

  private analyzeScope(description: string): { value: number; description: string } {
    if (description.includes('project') || description.includes('entire') || description.includes('all')) {
      return { value: 1, description: 'Project-wide scope' };
    }
    if (description.includes('module') || description.includes('feature') || description.includes('component')) {
      return { value: 0.6, description: 'Module-level scope' };
    }
    if (description.includes('file') || description.includes('function') || description.includes('method')) {
      return { value: 0.3, description: 'File/function-level scope' };
    }
    if (description.includes('line') || description.includes('fix typo') || description.includes('small')) {
      return { value: 0.1, description: 'Line-level scope' };
    }
    return { value: 0.5, description: 'Moderate scope' };
  }

  private countDomains(description: string): number {
    const domains = [
      'frontend', 'backend', 'database', 'api', 'ui', 'ux',
      'testing', 'security', 'performance', 'infrastructure', 'devops',
      'documentation', 'configuration', 'authentication', 'authorization',
    ];

    let count = 0;
    for (const domain of domains) {
      if (description.includes(domain)) count++;
    }

    // Infer domains from context
    if (description.includes('user') && !description.includes('database')) count++;
    if (description.includes('database') || description.includes('query')) count++;
    if (description.includes('deploy') || description.includes('build')) count++;

    return Math.max(1, count);
  }

  private analyzeImplementation(description: string): { value: number; description: string } {
    const complexityKeywords: Record<string, number> = {
      'refactor': 0.8,
      'implement': 0.7,
      'create': 0.6,
      'add': 0.5,
      'update': 0.4,
      'modify': 0.4,
      'fix': 0.5,
      'debug': 0.6,
      'optimize': 0.7,
      'integrate': 0.8,
      'migrate': 0.9,
      'rewrite': 0.9,
    };

    for (const [keyword, value] of Object.entries(complexityKeywords)) {
      if (description.includes(keyword)) {
        return { value, description: `${keyword} operation` };
      }
    }

    return { value: 0.5, description: 'Standard implementation' };
  }

  private analyzeTesting(description: string): { value: number; description: string } {
    if (description.includes('test') || description.includes('verify')) {
      return { value: 0.7, description: 'Testing required' };
    }
    if (description.includes('coverage') || description.includes('unit test')) {
      return { value: 0.9, description: 'Comprehensive testing required' };
    }
    return { value: 0.2, description: 'Basic testing' };
  }

  private estimateDependencies(description: string): number {
    let count = 1;

    // Check for dependency keywords
    if (description.includes('depends on') || description.includes('requires')) count += 2;
    if (description.includes('integration') || description.includes('connect')) count += 2;
    if (description.includes('api') || description.includes('service')) count += 1;
    if (description.includes('database') || description.includes('storage')) count += 1;
    if (description.includes('external') || description.includes('third-party')) count += 2;

    return count;
  }

  private identifyParallelAgents(description: string): AgentType[] {
    const agents: AgentType[] = [];

    if (description.includes('frontend') || description.includes('ui')) {
      agents.push('code');
    }
    if (description.includes('backend') || description.includes('api')) {
      agents.push('code');
    }
    if (description.includes('database') || description.includes('data')) {
      agents.push('code');
    }
    if (description.includes('test') || description.includes('verify')) {
      agents.push('test');
    }

    // Remove duplicates
    return [...new Set(agents)];
  }
}

/**
 * Create a TaskAnalyzer instance
 */
export function createTaskAnalyzer(complexityThreshold?: number): TaskAnalyzer {
  return new TaskAnalyzer(complexityThreshold);
}

// Singleton instance
let taskAnalyzerInstance: TaskAnalyzer | null = null;

/**
 * Get the TaskAnalyzer singleton
 */
export function getTaskAnalyzer(complexityThreshold?: number): TaskAnalyzer {
  if (!taskAnalyzerInstance) {
    taskAnalyzerInstance = createTaskAnalyzer(complexityThreshold);
  }
  return taskAnalyzerInstance;
}