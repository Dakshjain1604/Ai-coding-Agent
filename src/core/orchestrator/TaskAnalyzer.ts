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
  risk: "low" | "medium" | "high";
  riskFactors: AnalysisFactor[];
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
    const riskFactors = this.analyzeRiskFactors(task.description.toLowerCase());
    const risk = this.calculateRisk(riskFactors);

    return {
      complexity,
      confidence: this.calculateConfidence(factors),
      factors,
      suggestedStrategy: strategy,
      estimatedTokens: estimates.tokens,
      estimatedDuration: estimates.duration,
      risk,
      riskFactors,
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
   * Word-boundary-aware keyword check — `description.includes(word)` alone
   * produces false positives against any identifier that happens to
   * CONTAIN the trigger substring. Confirmed live against a real SWE-bench
   * task: a genuine astropy bug report repeatedly referencing its
   * `Linear1D` model class got scored "Line-level scope" — the LOWEST
   * complexity tier, meant for one-line typo fixes — purely because
   * "linear1d".includes("line") is true. None of this file's keyword
   * lists are safe from this class of bug (e.g. "review" is a substring of
   * "preview", "fix" of "prefix"/"suffix", "plan" of "explanation", "api"
   * of "rapid"), so every keyword-matching site in this file goes through
   * this helper rather than raw `.includes()`.
   */
  private hasWord(text: string, phrase: string): boolean {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  }

  private hasAnyWord(text: string, phrases: string[]): boolean {
    return phrases.some((p) => this.hasWord(text, p));
  }

  /**
   * Risk is scored independently from complexity/scope — they measure
   * different things. "Rename a UI label across 20 files" scores high on
   * complexity's scope/fileCount factors but is low-risk; "delete the
   * users table in production" is a 4-word description that scores low on
   * every complexity factor but is obviously high-risk. Reusing the
   * complexity score for risk would silently misfire on exactly the cases
   * that matter most.
   */
  private analyzeRiskFactors(description: string): AnalysisFactor[] {
    const destructiveKeywords = [
      "delete",
      "drop",
      "truncate",
      "wipe",
      "remove all",
      "force push",
      "rm -rf",
      "reset --hard",
    ];
    const sensitiveKeywords = [
      "credential",
      "secret",
      "token",
      "password",
      "auth",
      "payment",
      "permission",
      "api key",
    ];
    const irreversibleKeywords = [
      "production",
      "prod",
      "deploy",
      "release",
      "migrate",
      "migration",
      "schema change",
    ];

    const countHits = (keywords: string[]) =>
      keywords.filter((k) => this.hasWord(description, k)).length;

    const destructiveHits = countHits(destructiveKeywords);
    const sensitiveHits = countHits(sensitiveKeywords);
    const irreversibleHits = countHits(irreversibleKeywords);

    return [
      {
        name: "destructiveOps",
        value: Math.min(destructiveHits, 1),
        weight: 0.45,
        description:
          destructiveHits > 0
            ? "Contains destructive/irreversible operation keywords"
            : "No destructive operation keywords found",
      },
      {
        name: "sensitiveDomain",
        value: Math.min(sensitiveHits, 1),
        weight: 0.3,
        description:
          sensitiveHits > 0
            ? "Touches credentials/secrets/auth/payment"
            : "No sensitive-domain keywords found",
      },
      {
        name: "irreversibility",
        value: Math.min(irreversibleHits, 1),
        weight: 0.25,
        description:
          irreversibleHits > 0
            ? "Involves production/deployment/migration"
            : "No production/deployment keywords found",
      },
    ];
  }

  private calculateRisk(
    riskFactors: AnalysisFactor[],
  ): "low" | "medium" | "high" {
    const weightedSum = riskFactors.reduce(
      (sum, f) => sum + f.value * f.weight,
      0,
    );
    const totalWeight = riskFactors.reduce((sum, f) => sum + f.weight, 0);
    const score = weightedSum / totalWeight;

    if (score < 0.3) return "low";
    if (score < 0.6) return "medium";
    return "high";
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

    // Keywords that suggest specific agents. Even with word-boundary
    // matching (hasWord/hasAnyWord, not raw .includes()), a trigger word
    // still needs to be a genuinely SPECIFIC signal — "complex" is just
    // common English ("if I make the model more complex..."), not an
    // orchestration-specific term, and used to false-positive on any
    // moderately technical task description, immediately routing it to
    // 'orchestrator' (-> single unverified plan-mode agent, no file-write
    // tools) via the early-return below regardless of the task's actual
    // complexity score. Confirmed live: this exact word match, in a real
    // SWE-bench bug report, was why that task got routed to plan mode.
    // 'coordinate'/'orchestrate'/'multi-step' are specific enough to keep.
    const agentKeywords: Record<AgentType, string[]> = {
      plan: ['plan', 'analyze', 'design', 'architecture', 'research'],
      code: ['implement', 'create', 'build', 'write', 'add', 'fix', 'update'],
      test: ['test', 'verify', 'validate', 'coverage'],
      // 'bug' (not just 'fix bug'/'debug') matters on its own — confirmed
      // live: a real GitHub bug report said "this feels like a bug to me"
      // and matched none of the other debug keywords, routing to 'code'
      // mode's switch-statement default instead of 'debug' mode, which
      // meant it never got debug's task category ("reasoning") and so
      // never got the preferQuality model upgrade either (see
      // BaseAgent.initializeContext()). Safe from the "debug"/"debugging"
      // false-positive concern that motivated hasWord()'s word-boundary
      // matching in the first place — "debug".match(/\bbug\b/) is false,
      // since there's no boundary between "de" and "bug" in one word.
      debug: ['debug', 'bug', 'fix bug', 'error', 'issue', 'problem', 'diagnose'],
      review: ['review', 'audit', 'check quality', 'analyze code'],
      orchestrator: ['coordinate', 'orchestrate', 'multi-step'],
    };

    // Check for single-agent tasks
    for (const [agent, keywords] of Object.entries(agentKeywords)) {
      if (this.hasAnyWord(description, keywords)) {
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
        if (this.hasAnyWord(description, ['implement', 'create'])) {
          return {
            mode: 'pipeline',
            agents: ['plan', 'code', 'test'],
            maxParallel: 1,
          };
        }
        // Debug pipeline
        if (this.hasAnyWord(description, ['debug', 'fix'])) {
          return {
            mode: 'pipeline',
            agents: ['debug', 'code'],
            maxParallel: 1,
          };
        }
        // Review pipeline
        if (this.hasWord(description, 'review')) {
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

    // Check for scope indicators. "one" in particular is a common
    // substring of ordinary words ("done", "gone", "someone", "phone") —
    // word-boundary matching here isn't optional.
    if (this.hasAnyWord(description, ['project', 'entire'])) {
      count = Math.max(count, 20);
    } else if (this.hasAnyWord(description, ['single', 'one'])) {
      count = Math.max(count, 1);
    }

    return Math.max(1, count);
  }

  private analyzeScope(description: string): { value: number; description: string } {
    if (this.hasAnyWord(description, ['project', 'entire', 'all'])) {
      return { value: 1, description: 'Project-wide scope' };
    }
    if (this.hasAnyWord(description, ['module', 'feature', 'component'])) {
      return { value: 0.6, description: 'Module-level scope' };
    }
    if (this.hasAnyWord(description, ['file', 'function', 'method'])) {
      return { value: 0.3, description: 'File/function-level scope' };
    }
    if (this.hasAnyWord(description, ['line', 'fix typo', 'small'])) {
      return { value: 0.1, description: 'Line-level scope' };
    }
    // No scope signal found at all — bias toward "assume narrow" rather
    // than "assume moderate". A 0.5 default here (combined with
    // analyzeImplementation's old 0.5 default) was enough on its own to
    // push any keyword-free task — e.g. "say hello" — into "medium"
    // complexity, which then routed to a 2-agent pipeline instead of a
    // single lightweight agent. Confirmed live: this is what a plain "say
    // hello" task actually did before this fix.
    return { value: 0.2, description: 'No scope signal found (assumed narrow)' };
  }

  private countDomains(description: string): number {
    const domains = [
      'frontend', 'backend', 'database', 'api', 'ui', 'ux',
      'testing', 'security', 'performance', 'infrastructure', 'devops',
      'documentation', 'configuration', 'authentication', 'authorization',
    ];

    let count = 0;
    for (const domain of domains) {
      if (this.hasWord(description, domain)) count++;
    }

    // Infer domains from context
    if (this.hasWord(description, 'user') && !this.hasWord(description, 'database')) count++;
    if (this.hasAnyWord(description, ['database', 'query'])) count++;
    if (this.hasAnyWord(description, ['deploy', 'build'])) count++;

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
      if (this.hasWord(description, keyword)) {
        return { value, description: `${keyword} operation` };
      }
    }

    // No imperative keyword matched — before falling back to "assumed
    // simple", check for a keyword-independent signal that this is real
    // technical work anyway: code examples. Confirmed live: a genuine
    // GitHub bug report ("X does not compute Y correctly... this feels
    // like a bug to me, but I might be missing something?") contains ZERO
    // imperative verbs — real bug reports are observations, not commands —
    // but typically includes runnable code demonstrating the problem. That
    // combination (no command verb, real code present) is a strong signal
    // of investigative work, not evidence of triviality the way a
    // genuinely keyword-and-code-free task like "say hello" is.
    const fencedBlocks = (description.match(/```/g) || []).length / 2;
    const inlineCodeSpans = (description.match(/`[^`\n]+`/g) || []).length;
    if (fencedBlocks >= 1 || inlineCodeSpans >= 3) {
      return {
        value: 0.5,
        description:
          'No complexity keyword found, but contains code examples (treated as real investigative work)',
      };
    }

    // Same reasoning as analyzeScope's default: no complexity keyword
    // found is evidence of nothing, not evidence of "standard/moderate"
    // work — bias low so unrecognized phrasing doesn't get inflated.
    return { value: 0.2, description: 'No complexity keyword found (assumed simple)' };
  }

  private analyzeTesting(description: string): { value: number; description: string } {
    if (this.hasAnyWord(description, ['test', 'verify'])) {
      return { value: 0.7, description: 'Testing required' };
    }
    if (this.hasAnyWord(description, ['coverage', 'unit test'])) {
      return { value: 0.9, description: 'Comprehensive testing required' };
    }
    return { value: 0.2, description: 'Basic testing' };
  }

  private estimateDependencies(description: string): number {
    let count = 1;

    // Check for dependency keywords
    if (this.hasAnyWord(description, ['depends on', 'requires'])) count += 2;
    if (this.hasAnyWord(description, ['integration', 'connect'])) count += 2;
    if (this.hasAnyWord(description, ['api', 'service'])) count += 1;
    if (this.hasAnyWord(description, ['database', 'storage'])) count += 1;
    if (this.hasAnyWord(description, ['external', 'third-party'])) count += 2;

    return count;
  }

  private identifyParallelAgents(description: string): AgentType[] {
    const agents: AgentType[] = [];

    if (this.hasAnyWord(description, ['frontend', 'ui'])) {
      agents.push('code');
    }
    if (this.hasAnyWord(description, ['backend', 'api'])) {
      agents.push('code');
    }
    if (this.hasAnyWord(description, ['database', 'data'])) {
      agents.push('code');
    }
    if (this.hasAnyWord(description, ['test', 'verify'])) {
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