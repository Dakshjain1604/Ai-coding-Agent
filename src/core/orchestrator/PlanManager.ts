/**
 * Plan Manager - Creates and maintains .md plan files
 * Tracks progress through plan stages and supports resumption
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { getLogger } from '../../utils/logger.js';
import type { Task } from '../../utils/types.js';

export interface PlanStep {
  id: string;
  order: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  agentType?: string;
  dependencies: string[];
  estimatedComplexity?: 'low' | 'medium' | 'high';
  startTime?: Date;
  endTime?: Date;
  result?: string;
  artifacts?: string[];
}

export interface Plan {
  id: string;
  taskId: string;
  title: string;
  description: string;
  steps: PlanStep[];
  createdAt: Date;
  updatedAt: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused';
  metadata?: Record<string, unknown>;
}

export interface PlanProgress {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  inProgress: number;
  percentage: number;
}

/**
 * Plan Manager
 * Manages execution plans stored as markdown files
 */
export class PlanManager {
  private plansDir: string;
  private currentPlan: Plan | null = null;
  private logger = getLogger();

  constructor(plansDir?: string) {
    this.plansDir = plansDir ?? join(process.cwd(), 'plans');
    this.ensureDirectory();
  }

  /**
   * Create a new plan
   */
  create(task: Task, steps: Omit<PlanStep, 'id' | 'order'>[]): Plan {
    const plan: Plan = {
      id: this.generateId(task),
      taskId: task.id,
      title: this.extractTitle(task.description),
      description: task.description,
      steps: steps.map((s, i) => ({
        ...s,
        id: `step-${i + 1}`,
        order: i + 1,
        status: 'pending' as const,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending',
      metadata: task.metadata,
    };

    this.currentPlan = plan;
    this.savePlan(plan);

    this.logger.info(`Created plan ${plan.id} with ${plan.steps.length} steps`);
    return plan;
  }

  /**
   * Load a plan by ID
   */
  load(planId: string): Plan | null {
    const filePath = this.getPlanPath(planId);
    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');
    const plan = this.parsePlan(content);
    this.currentPlan = plan;
    return plan;
  }

  /**
   * Save a plan
   */
  save(plan: Plan): void {
    plan.updatedAt = new Date();
    this.savePlan(plan);
  }

  /**
   * Update plan status
   */
  updateStatus(status: Plan['status']): void {
    if (!this.currentPlan) return;
    this.currentPlan.status = status;
    this.save(this.currentPlan);
  }

  /**
   * Start a step
   */
  startStep(stepId: string): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = 'in_progress';
    step.startTime = new Date();
    this.currentPlan.status = 'in_progress';
    this.save(this.currentPlan);
  }

  /**
   * Complete a step
   */
  completeStep(stepId: string, result?: string, artifacts?: string[]): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = 'completed';
    step.endTime = new Date();
    step.result = result;
    step.artifacts = artifacts;

    // Check if all steps completed
    if (this.currentPlan.steps.every((s) => s.status === 'completed' || s.status === 'skipped')) {
      this.currentPlan.status = 'completed';
    }

    this.save(this.currentPlan);
  }

  /**
   * Fail a step
   */
  failStep(stepId: string, error?: string): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = 'failed';
    step.endTime = new Date();
    step.result = error;
    this.currentPlan.status = 'failed';
    this.save(this.currentPlan);
  }

  /**
   * Skip a step
   */
  skipStep(stepId: string, reason?: string): void {
    if (!this.currentPlan) return;

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = 'skipped';
    step.result = reason;
    this.save(this.currentPlan);
  }

  /**
   * Get current plan
   */
  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  /**
   * Get plan progress
   */
  getProgress(): PlanProgress {
    if (!this.currentPlan) {
      return { total: 0, completed: 0, failed: 0, pending: 0, inProgress: 0, percentage: 0 };
    }

    const steps = this.currentPlan.steps;
    const total = steps.length;
    const completed = steps.filter((s) => s.status === 'completed').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const pending = steps.filter((s) => s.status === 'pending').length;
    const inProgress = steps.filter((s) => s.status === 'in_progress').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, failed, pending, inProgress, percentage };
  }

  /**
   * List all plans
   */
  list(): Plan[] {
    if (!existsSync(this.plansDir)) return [];

    const files = readdirSync(this.plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(this.plansDir, f));

    return files.map((f) => this.parsePlan(readFileSync(f, 'utf-8')));
  }

  /**
   * Delete a plan
   */
  delete(planId: string): boolean {
    const filePath = this.getPlanPath(planId);
    if (!existsSync(filePath)) return false;

    const { unlinkSync } = require('fs');
    unlinkSync(filePath);
    if (this.currentPlan?.id === planId) {
      this.currentPlan = null;
    }

    return true;
  }

  /**
   * Find the next pending step
   */
  getNextPendingStep(): PlanStep | null {
    if (!this.currentPlan) return null;
    return this.currentPlan.steps.find((s) => s.status === 'pending') ?? null;
  }

  /**
   * Find the next step with satisfied dependencies
   */
  getNextRunnableStep(): PlanStep | null {
    if (!this.currentPlan) return null;

    for (const step of this.currentPlan.steps) {
      if (step.status !== 'pending') continue;

      // Check if all dependencies are completed
      const depsCompleted = step.dependencies.every((depId) => {
        const dep = this.currentPlan!.steps.find((s) => s.id === depId);
        return dep?.status === 'completed' || dep?.status === 'skipped';
      });

      if (depsCompleted) {
        return step;
      }
    }

    return null;
  }

  /**
   * Export plan as markdown
   */
  exportMarkdown(plan: Plan): string {
    const lines: string[] = [];

    lines.push(`# ${plan.title}`);
    lines.push('');
    lines.push(`**Plan ID:** ${plan.id}`);
    lines.push(`**Task ID:** ${plan.taskId}`);
    lines.push(`**Status:** ${plan.status}`);
    lines.push(`**Created:** ${plan.createdAt.toISOString()}`);
    lines.push(`**Updated:** ${plan.updatedAt.toISOString()}`);
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(plan.description);
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    for (const step of plan.steps) {
      const statusIcon = this.getStatusIcon(step.status);
      lines.push(`### ${statusIcon} ${step.id}: ${step.description}`);
      lines.push('');
      lines.push(`- **Status:** ${step.status}`);
      if (step.agentType) {
        lines.push(`- **Agent:** ${step.agentType}`);
      }
      if (step.dependencies.length > 0) {
        lines.push(`- **Dependencies:** ${step.dependencies.join(', ')}`);
      }
      if (step.startTime) {
        lines.push(`- **Started:** ${step.startTime.toISOString()}`);
      }
      if (step.endTime) {
        lines.push(`- **Ended:** ${step.endTime.toISOString()}`);
      }
      if (step.result) {
        lines.push('');
        lines.push('**Result:**');
        lines.push('```');
        lines.push(step.result);
        lines.push('```');
      }
      if (step.artifacts && step.artifacts.length > 0) {
        lines.push('');
        lines.push(`**Artifacts:** ${step.artifacts.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureDirectory(): void {
    if (!existsSync(this.plansDir)) {
      mkdirSync(this.plansDir, { recursive: true });
    }
  }

  private generateId(task: Task): string {
    const timestamp = Date.now();
    const hash = this.hashString(task.description).slice(0, 8);
    return `plan-${timestamp}-${hash}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private extractTitle(description: string): string {
    // Extract first line or first 50 characters
    const firstLine = description.split('\n')[0];
    return firstLine.length > 50 ? firstLine.slice(0, 47) + '...' : firstLine;
  }

  private getPlanPath(planId: string): string {
    return join(this.plansDir, `${planId}.md`);
  }

  private savePlan(plan: Plan): void {
    const content = this.exportMarkdown(plan);
    writeFileSync(this.getPlanPath(plan.id), content, 'utf-8');
  }

  private parsePlan(content: string): Plan {
    const lines = content.split('\n');
    const plan: Partial<Plan> = {
      steps: [],
    };

    let currentStep: Partial<PlanStep> | null = null;
    let inResult = false;
    let resultLines: string[] = [];

    for (const line of lines) {
      // Parse header
      if (line.startsWith('# ')) {
        plan.title = line.slice(2).trim();
      } else if (line.startsWith('**Plan ID:**')) {
        plan.id = line.split(':')[1].trim();
      } else if (line.startsWith('**Task ID:**')) {
        plan.taskId = line.split(':')[1].trim();
      } else if (line.startsWith('**Status:**')) {
        plan.status = line.split(':')[1].trim() as Plan['status'];
      } else if (line.startsWith('**Created:**')) {
        plan.createdAt = new Date(line.split(':')[1].trim());
      } else if (line.startsWith('**Updated:**')) {
        plan.updatedAt = new Date(line.split(':')[1].trim());
      } else if (line.startsWith('## Description')) {
        // Skip, description follows
      } else if (line.startsWith('## Steps')) {
        // Skip, steps follow
      } else if (line.startsWith('### ')) {
        // New step
        if (currentStep) {
          if (resultLines.length > 0) {
            currentStep.result = resultLines.join('\n').trim();
          }
          plan.steps!.push(currentStep as PlanStep);
        }

        const match = line.match(/### \S+ (\S+): (.+)/);
        if (match) {
          currentStep = {
            id: match[1],
            description: match[2],
            status: 'pending',
            dependencies: [],
          };
          resultLines = [];
          inResult = false;
        }
      } else if (currentStep) {
        // Parse step details
        if (line.startsWith('- **Status:**')) {
          currentStep.status = line.split(':')[1].trim() as PlanStep['status'];
        } else if (line.startsWith('- **Agent:**')) {
          currentStep.agentType = line.split(':')[1].trim();
        } else if (line.startsWith('- **Dependencies:**')) {
          currentStep.dependencies = line.split(':')[1].trim().split(',').map((s) => s.trim());
        } else if (line.startsWith('- **Started:**')) {
          currentStep.startTime = new Date(line.split(':')[1].trim());
        } else if (line.startsWith('- **Ended:**')) {
          currentStep.endTime = new Date(line.split(':')[1].trim());
        } else if (line.startsWith('**Artifacts:**')) {
          currentStep.artifacts = line.split(':')[1].trim().split(',').map((s) => s.trim());
        } else if (line.startsWith('**Result:**')) {
          inResult = true;
        } else if (inResult && line.startsWith('```')) {
          // Toggle result block
          inResult = !inResult;
        } else if (inResult && !line.startsWith('```')) {
          resultLines.push(line);
        } else if (!line.startsWith('##') && !line.startsWith('- **') && !line.startsWith('**') && !line.startsWith('```')) {
          // Description line
          if (!currentStep.description) {
            currentStep.description = line;
          }
        }
      } else if (!line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*') && line.trim()) {
        // Description
        if (!plan.description) {
          plan.description = line;
        } else {
          plan.description += '\n' + line;
        }
      }
    }

    // Add last step
    if (currentStep) {
      if (resultLines.length > 0) {
        currentStep.result = resultLines.join('\n').trim();
      }
      plan.steps!.push(currentStep as PlanStep);
    }

    return plan as Plan;
  }

  private getStatusIcon(status: PlanStep['status']): string {
    const icons: Record<PlanStep['status'], string> = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      failed: '❌',
      skipped: '⏭️',
    };
    return icons[status] ?? '❓';
  }
}

/**
 * Create a PlanManager instance
 */
export function createPlanManager(plansDir?: string): PlanManager {
  return new PlanManager(plansDir);
}