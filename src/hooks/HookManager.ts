/**
 * Hook Manager - Manages lifecycle hooks for the agent system
 * Allows customization of agent behavior at various points
 */

import { getLogger } from "../utils/logger.js";
import type {
  Hook,
  HookEvent,
  HookContext,
  HookResult,
  HookConfig,
} from "./types.js";

export class HookManager {
  private hooks: Map<HookEvent, Hook[]> = new Map();
  private logger = getLogger();
  private config: Map<string, HookConfig> = new Map();
  private enabled = true;

  constructor() {
    this.initializeDefaultHooks();
  }

  private initializeDefaultHooks(): void {
    for (const event of this.getAllEvents()) {
      this.hooks.set(event, []);
    }
  }

  private getAllEvents(): HookEvent[] {
    return [
      "pre-tool-use",
      "post-tool-use",
      "pre-agent-execute",
      "post-agent-execute",
      "pre-task-execute",
      "post-task-execute",
      "on-error",
      "on-plan-update",
      "on-memory-store",
      "on-context-compact",
    ];
  }

  register(hook: Hook): void {
    const eventHooks = this.hooks.get(hook.event) || [];

    eventHooks.push({
      ...hook,
      priority: hook.priority ?? 50,
    });

    eventHooks.sort((a, b) => b.priority! - a.priority!);

    this.hooks.set(hook.event, eventHooks);
    this.logger.debug(`Registered hook: ${hook.name} for event: ${hook.event}`);
  }

  unregister(name: string): boolean {
    for (const [event, hooks] of this.hooks) {
      const index = hooks.findIndex((h) => h.name === name);
      if (index !== -1) {
        hooks.splice(index, 1);
        this.logger.debug(`Unregistered hook: ${name}`);
        return true;
      }
    }
    return false;
  }

  async execute(
    event: HookEvent,
    data: Record<string, unknown>,
  ): Promise<HookResult> {
    if (!this.enabled) {
      return { success: true };
    }

    const eventHooks = this.hooks.get(event) || [];

    if (eventHooks.length === 0) {
      return { success: true };
    }

    const context: HookContext = {
      event,
      timestamp: new Date(),
      data,
    };

    let modifiedData = { ...data };

    for (const hook of eventHooks) {
      const hookConfig = this.config.get(hook.name);

      if (hookConfig && !hookConfig.enabled) {
        continue;
      }

      try {
        const timeout = hookConfig?.timeout || 5000;
        const result = await this.executeWithTimeout(hook, context, timeout);

        if (result?.skip) {
          this.logger.debug(`Hook ${hook.name} requested skip`);
          return { success: true, skip: true };
        }

        if (result?.modifiedData) {
          modifiedData = { ...modifiedData, ...result.modifiedData };
        }

        if (!result?.success && hookConfig?.failOnError) {
          this.logger.error(`Hook ${hook.name} failed and failOnError is true`);
          return { success: false, error: result?.error };
        }
      } catch (error) {
        this.logger.error(`Hook ${hook.name} threw error`, error as Error);

        if (hookConfig?.failOnError) {
          return { success: false, error: (error as Error).message };
        }
      }
    }

    return { success: true, modifiedData };
  }

  private async executeWithTimeout(
    hook: Hook,
    context: HookContext,
    timeout: number,
  ): Promise<HookResult | void> {
    return Promise.race([
      hook.handler(context),
      new Promise<HookResult>((resolve) =>
        setTimeout(() => resolve({ success: true }), timeout),
      ),
    ]);
  }

  getHooks(event: HookEvent): Hook[] {
    return this.hooks.get(event) || [];
  }

  setHookConfig(name: string, config: HookConfig): void {
    this.config.set(name, config);
  }

  getHookConfig(name: string): HookConfig | undefined {
    return this.config.get(name);
  }

  enable(): void {
    this.enabled = true;
    this.logger.info("HookManager enabled");
  }

  disable(): void {
    this.enabled = false;
    this.logger.info("HookManager disabled");
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear(event?: HookEvent): void {
    if (event) {
      this.hooks.set(event, []);
    } else {
      for (const e of this.getAllEvents()) {
        this.hooks.set(e, []);
      }
    }
    this.logger.debug("Hooks cleared");
  }
}

let hookManagerInstance: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!hookManagerInstance) {
    hookManagerInstance = new HookManager();
  }
  return hookManagerInstance;
}
