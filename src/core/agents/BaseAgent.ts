/**
 * Base Agent - Abstract base class for all agents
 * Provides common functionality for task execution, tool usage, and memory
 */

import { v4 as uuid } from "uuid";
import { getLogger } from "../../utils/logger.js";
import { getSystemAnalyzer } from "../../utils/system-analyzer.js";
import type {
  Task,
  TaskResult,
  AgentType,
  AgentConfig,
  AgentState,
} from "../../utils/types.js";
import type {
  ChatMessage,
  CompletionResult,
  StreamChunk,
} from "../../providers/ProviderInterface.js";
import type { BaseProvider } from "../../providers/ProviderInterface.js";
import { getProviderFactory } from "../../providers/ProviderFactory.js";
import { getModelRouter } from "../../providers/ModelRouter.js";
import { getMemoryManager } from "../../memory/MemoryManager.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import { parseToolCalls } from "./tool-parser.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentContext {
  taskId: string;
  task: Task;
  messages: ChatMessage[];
  toolResults: Map<string, unknown>;
  memory: MemoryManager;
  provider: BaseProvider;
  model: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  artifacts?: string[];
  metrics: {
    tokensUsed: number;
    durationMs: number;
    toolCalls: number;
  };
}

/**
 * Abstract Base Agent
 * All agent types inherit from this class
 */
export abstract class BaseAgent {
  protected id: string;
  protected type: AgentType;
  protected config: AgentConfig;
  protected tools: Map<string, AgentTool> = new Map();
  protected state: AgentState;
  protected logger = getLogger();
  protected context: AgentContext | null = null;
  protected toolCallCount = 0;
  protected totalCost = 0;

  constructor(type: AgentType, config: Partial<AgentConfig>) {
    this.id = uuid();
    this.type = type;
    this.config = this.getDefaultConfig(type, config);
    this.state = {
      id: this.id,
      type: this.type,
      status: "idle",
    };
  }

  /**
   * Execute a task
   */
  abstract execute(task: Task): Promise<TaskResult>;

  /**
   * Get agent type
   */
  getType(): AgentType {
    return this.type;
  }

  /**
   * Get agent ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Get agent state
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Register a tool
   */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
    this.logger.debug(`Tool registered: ${tool.name}`);
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get available tools
   */
  getTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Spawn a subtask (to be implemented by specific agents)
   */
  async spawn(subtask: Task): Promise<TaskResult> {
    // This is implemented by the orchestrator
    throw new Error("spawn() must be implemented by subclass");
  }

  /**
   * Report progress
   */
  report(progress: { message: string; percentage?: number }): void {
    this.logger.info(
      `[${this.type}] ${progress.message}${progress.percentage ? ` (${progress.percentage}%)` : ""}`,
    );
  }

  /**
   * Store in memory
   */
  async store(key: string, value: unknown): Promise<void> {
    const memory = getMemoryManager();
    await memory.store("execution", `${key}: ${JSON.stringify(value)}`, {
      key,
    });
  }

  /**
   * Retrieve from memory
   */
  async retrieve(key: string): Promise<unknown | null> {
    const memory = getMemoryManager();
    const results = await memory.search(key, 1);
    if (results.length === 0) return null;

    const content = results[0].entry.content;
    const match = content.match(new RegExp(`^${key}: (.+)$`));
    if (!match) return null;

    try {
      return JSON.parse(match[1]);
    } catch {
      return match[1];
    }
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  /**
   * Initialize agent context
   */
  protected async initializeContext(task: Task): Promise<AgentContext> {
    const router = getModelRouter();
    const taskCategory = this.getTaskCategory();
    const routing = await router.route(taskCategory);

    const memory = getMemoryManager();
    const conversationId = memory.startConversation();

    const context: AgentContext = {
      taskId: task.id,
      task,
      messages: [],
      toolResults: new Map(),
      memory,
      provider: routing.provider,
      model: routing.model,
    };

    this.context = context;
    this.state.status = "running";
    this.state.currentTask = task;
    this.state.startTime = new Date();

    return context;
  }

  /**
   * Add a message to the context
   */
  protected addMessage(role: ChatMessage["role"], content: string): void {
    if (!this.context) return;

    this.context.messages.push({
      role,
      content,
    });
  }

  /**
   * Call the LLM with current context
   */
  protected async callLLM(options?: {
    systemPrompt?: string;
    stream?: boolean;
  }): Promise<CompletionResult | AsyncIterable<StreamChunk>> {
    if (!this.context) {
      throw new Error("Context not initialized");
    }

    const { provider, model, messages } = this.context;
    const allMessages: ChatMessage[] = [];

    if (options?.systemPrompt) {
      allMessages.push({ role: "system", content: options.systemPrompt });
    }

    allMessages.push(...messages);

    const truncatedMessages = this.truncateMessages(
      allMessages,
      this.config.maxTokens,
    );

    if (options?.stream) {
      return provider.stream(truncatedMessages, {
        model,
        maxTokens: this.config.maxTokens,
      });
    }

    return provider.complete(truncatedMessages, {
      model,
      maxTokens: this.config.maxTokens,
    });
  }

  protected truncateMessages(
    messages: ChatMessage[],
    maxTokens: number,
  ): ChatMessage[] {
    const estimatedTokens = this.estimateTokenCount(messages);
    if (estimatedTokens <= maxTokens) return messages;

    const systemMessages = messages.filter((m) => m.role === "system");
    const firstUserMsg = messages.find((m) => m.role === "user");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const systemBudget = Math.floor(maxTokens * 0.2);
    const conversationBudget = maxTokens - systemBudget;

    const recent: ChatMessage[] = [];
    let tokenCount = 0;

    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msg = nonSystemMessages[i];
      const tokens = this.estimateTokenCount([msg]);
      if (tokenCount + tokens > conversationBudget) break;
      recent.unshift(msg);
      tokenCount += tokens;
    }

    const hasFirstUser = recent.some((m) => m === firstUserMsg);
    const pinned = hasFirstUser
      ? recent
      : [firstUserMsg!, ...recent].filter(Boolean);

    return [...systemMessages, ...pinned];
  }

  protected estimateTokenCount(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += Math.ceil(msg.content.length / 4);
    }
    return total;
  }

  /**
   * Execute a tool
   */
  protected async executeTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const { getPermissionSystem } =
      await import("../../utils/permission-system.js");
    const permissionSystem = getPermissionSystem();

    const check = permissionSystem.checkPermission(name, params);
    if (!check.allowed) {
      if (check.requiresPrompt) {
        const approved = await permissionSystem.requestPermission({
          tool: name,
          params,
          description: check.description,
        });
        if (!approved) {
          return { success: false, output: `Permission denied for: ${name}` };
        }
      } else {
        return { success: false, output: `Tool not allowed: ${name}` };
      }
    }

    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    this.logger.debug(`Executing tool: ${name}`);

    // Check tool call budget
    const maxToolCalls = this.config.maxToolCalls ?? 50;
    if (this.toolCallCount >= maxToolCalls) {
      throw new Error(
        `Tool call budget exceeded: ${this.toolCallCount}/${maxToolCalls} calls`,
      );
    }

    const result = await tool.execute(params);
    this.toolCallCount++;
    this.context?.toolResults.set(`${name}_${Date.now()}`, result);
    return result;
  }

  /**
   * Check if tool call budget is exceeded
   */
  protected isOverBudget(): boolean {
    const maxToolCalls = this.config.maxToolCalls ?? 50;
    const maxCost = this.config.maxCost ?? Infinity;
    return this.toolCallCount >= maxToolCalls || this.totalCost >= maxCost;
  }

  /**
   * Get current budget status
   */
  protected getBudgetStatus(): {
    toolCalls: number;
    maxToolCalls: number;
    cost: number;
    maxCost: number;
  } {
    return {
      toolCalls: this.toolCallCount,
      maxToolCalls: this.config.maxToolCalls ?? 50,
      cost: this.totalCost,
      maxCost: this.config.maxCost ?? Infinity,
    };
  }

  /**
   * Complete the task and return result
   */
  protected complete(
    success: boolean,
    output: string,
    artifacts?: string[],
  ): TaskResult {
    const endTime = new Date();
    const durationMs = this.state.startTime
      ? endTime.getTime() - this.state.startTime.getTime()
      : 0;

    this.state.status = success ? "completed" : "failed";
    this.state.endTime = endTime;

    return {
      taskId: this.context?.taskId ?? this.id,
      success,
      output,
      artifacts,
      durationMs,
      agentType: this.type,
    };
  }

  /**
   * Get default config for agent type
   */
  protected getDefaultConfig(
    type: AgentType,
    override: Partial<AgentConfig>,
  ): AgentConfig {
    const sysCaps = getSystemAnalyzer().analyze();
    const maxTokens = sysCaps.recommendedMaxTokens;

    const defaults: Record<AgentType, AgentConfig> = {
      orchestrator: {
        type: "orchestrator",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["planning", "file_system", "git", "memory"],
        maxIterations: 10,
        timeout: 300000,
        maxToolCalls: 20,
        maxCost: 1.0,
      },
      plan: {
        type: "plan",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["file_system", "git", "memory"],
        maxIterations: 6,
        timeout: 180000,
        maxToolCalls: 12,
        maxCost: 0.5,
      },
      code: {
        type: "code",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["file_system", "shell", "git", "memory"],
        maxIterations: 12,
        timeout: 300000,
        maxToolCalls: 25,
        maxCost: 1.0,
      },
      test: {
        type: "test",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["test_runner", "file_system", "memory"],
        maxIterations: 10,
        timeout: 240000,
        maxToolCalls: 20,
        maxCost: 0.75,
      },
      debug: {
        type: "debug",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["logs", "shell", "file_system", "memory"],
        maxIterations: 10,
        timeout: 240000,
        maxToolCalls: 15,
        maxCost: 0.75,
      },
      review: {
        type: "review",
        model: "qwen2.5-coder:latest",
        maxTokens,
        tools: ["diff", "linter", "file_system", "memory"],
        maxIterations: 8,
        timeout: 180000,
        maxToolCalls: 15,
        maxCost: 0.5,
      },
    };

    return { ...defaults[type], ...override };
  }

  /**
   * Get task category for model routing
   */
  protected getTaskCategory(): "simple" | "code" | "complex" | "reasoning" {
    const categoryMap: Record<
      AgentType,
      "simple" | "code" | "complex" | "reasoning"
    > = {
      orchestrator: "complex",
      plan: "reasoning",
      code: "code",
      test: "code",
      debug: "reasoning",
      review: "code",
    };

    return categoryMap[this.type] ?? "complex";
  }

  /**
   * Build system prompt for the agent
   */
  protected abstract buildSystemPrompt(): string;

  /**
   * Parse tool calls from LLM output - delegates to tool-parser.ts
   */
  protected parseToolCalls(
    output: string,
  ): Array<{ name: string; params: Record<string, unknown> }> {
    return parseToolCalls(output) as Array<{
      name: string;
      params: Record<string, unknown>;
    }>;
  }

  /**
   * Format tool result for LLM
   */
  protected formatToolResult(name: string, result: unknown): string {
    return `\`\`\`result\n${name}\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  }

  /**
   * Log execution metrics
   */
  protected logMetrics(metrics: {
    tokensUsed: number;
    durationMs: number;
    toolCalls: number;
  }): void {
    this.logger.info(
      `[${this.type}] Task completed: ${metrics.tokensUsed} tokens, ${metrics.durationMs}ms, ${metrics.toolCalls} tool calls`,
    );
  }
}
