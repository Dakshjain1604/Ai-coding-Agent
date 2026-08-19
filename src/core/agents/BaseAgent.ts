/**
 * Base Agent - Abstract base class for all agents
 * Provides common functionality for task execution, tool usage, and memory
 */

import { getLogger } from "../../utils/logger.js";
import { getSystemAnalyzer } from "../../utils/system-analyzer.js";
import type {
  Task,
  TaskResult,
  AgentType,
  AgentConfig,
  AgentState,
  ToolSchema,
} from "../../utils/types.js";
import type {
  ChatMessage,
  CompletionResult,
  StreamChunk,
} from "../../providers/ProviderInterface.js";
import type { BaseProvider } from "../../providers/ProviderInterface.js";
import { getModelRouter } from "../../providers/ModelRouter.js";
import { getConfigManager } from "../../utils/config.js";
import { getMemoryManager } from "../../memory/MemoryManager.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import { parseToolCalls, hasIncompleteToolCallAttempt } from "./tool-parser.js";
import { TelemetryCollector } from "../../telemetry/TelemetryCollector.js";
import { compactMessages, renderSummaryMessage } from "./Compactor.js";
import { getHookManager } from "../../hooks/HookManager.js";
import { getPermissionSystem } from "../../utils/permission-system.js";
import { scrubSecrets } from "../../utils/secret-scrubber.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentContext {
  taskId: string;
  task: Task;
  conversationId: string;
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
  /** Session ID for telemetry events (set by UniversalAgent or inherited) */
  protected telemetrySessionId?: string;
  /** Current turn number for telemetry (set by UniversalAgent turn tracking) */
  protected telemetryTurnNumber?: number;
  /** Current structured compaction summary, if any turns have been compacted yet (see Compactor.ts). */
  private compactionSummary?: string;
  /** How many entries of the append-only history array are already folded into compactionSummary — only messages after this index get sent for (re-)compaction. */
  private compactedThroughIndex = 0;
  /**
   * Set by cancel() — checked between iterations of UniversalAgent's main
   * loop (not mid-call; this isn't a full AbortController threaded into
   * every provider's fetch(), just a cooperative "don't start another
   * iteration" flag). AgentSpawner.executeWithTimeout() previously only
   * rejected its own wrapper promise on timeout — the underlying
   * agent.execute() call kept running for as long as it wanted, with
   * nothing ever told to stop. Confirmed live on a real SWE-bench task: a
   * "timed out after 300000ms" failure was reported to the user, then the
   * agent kept executing — several MORE tool calls (including a
   * destructive file_write that corrupted a real source file) — for
   * minutes afterward, completely unsupervised, consuming API quota the
   * caller had no visibility into and no way to stop. Checking this flag
   * at the top of each loop iteration stops that continuation at the next
   * natural boundary instead of letting it run to its own completion.
   */
  protected cancelled = false;

  /** Called by AgentSpawner.executeWithTimeout() when its timeout fires. */
  cancel(): void {
    this.cancelled = true;
  }

  constructor(type: AgentType, config: Partial<AgentConfig>) {
    this.id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.type = type;
    this.config = this.getDefaultConfig(type, config);
    this.state = {
      id: this.id,
      type: this.type,
      status: "idle",
    };
  }

  public getToolSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [];
    for (const tool of this.tools.values()) {
      const rawProps =
        (tool.parameters.properties as Record<string, unknown>) ||
        tool.parameters;
      // AgentTool.parameters is a FLAT map (e.g. {path: {type, required},
      // content: {type, required}}), not a JSON-Schema-style {properties,
      // required} object — there is no top-level `.required` field on it
      // to read. `tool.parameters.required` was therefore always
      // undefined, so `req` was always `[]` for every tool, meaning the
      // `required` array sent to every provider's native function-calling
      // API (OpenAI/Claude/Gemini/Groq/OpenRouter all forward this
      // ToolSchema.parameters object verbatim into their request) told
      // the model that NOTHING was ever required, for every tool. Now
      // correctly derives it from each individual parameter's own
      // `required: true` flag, which is what ToolRegistry.
      // validateParameters() (the downstream enforcement layer) already
      // reads correctly — this was purely a gap in what got told to the
      // model upfront, not a validation hole.
      const req = Object.entries(tool.parameters)
        .filter(
          ([, param]) =>
            typeof param === "object" &&
            param !== null &&
            (param as { required?: boolean }).required === true,
        )
        .map(([name]) => name);
      // Each per-property entry still carries our own internal `required`
      // boolean (used above to build `req`) — that's not a valid JSON
      // Schema keyword at the property level (only a top-level `required:
      // string[]` on the object schema is valid), and providers that
      // actually validate the schema server-side reject it. Confirmed
      // live against Groq's real API: `properties.encoding.required` on
      // file_read's schema produced "400 invalid JSON schema ...
      // '/properties/encoding/required' ... expected array, but got
      // boolean" — a hard failure, not a warning, once tools actually
      // started being forwarded to Groq (see GroqProvider.complete/stream).
      const props = Object.fromEntries(
        Object.entries(rawProps).map(([name, param]) => {
          if (typeof param !== "object" || param === null) {
            return [name, param];
          }
          const { required: _required, ...rest } = param as Record<
            string,
            unknown
          >;
          return [name, rest];
        }),
      );
      schemas.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: props,
          required: req,
        },
      });
    }
    return schemas;
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
    // getModelRouter() is a singleton — pass the real config on first
    // construction so `defaults.preferLocal` actually takes effect (it's
    // only read by the router's own constructor default otherwise).
    const { defaults } = getConfigManager().get();
    const router = getModelRouter({
      preferLocal: defaults.preferLocal,
      fallbackToPaid: defaults.fallbackToPaid,
      maxPaidApiCalls: defaults.maxPaidApiCalls,
    });
    const taskCategory = this.getTaskCategory();
    // ModelRouter.route()'s `preferQuality` option (-> ProviderRegistry's
    // "quality" tier, e.g. Groq's openai/gpt-oss-120b instead of the
    // default -20b) was fully implemented but had zero real callers
    // anywhere — every task always got the fast/small "default" tier
    // model, regardless of task category. Confirmed live via a real
    // SWE-bench task: the small default model both (a) answered a genuine
    // bug report conversationally from its own pretrained knowledge
    // instead of investigating with its tools, giving a confidently wrong
    // explanation, and (b) in a follow-up run, correctly found the right
    // file but then returned a blank response with 0 completion tokens.
    // "reasoning" (debug/plan) and "complex" (orchestrator) categories are
    // exactly the investigative, multi-step work most exposed to that
    // kind of failure — "code"/"simple" categories (mechanical edits once
    // a plan or diagnosis already exists) don't need the same headroom.
    const preferQuality = taskCategory === "reasoning" || taskCategory === "complex";
    const routing = await router.route(taskCategory, undefined, { preferQuality });

    // getDefaultConfig() sizes `maxTokens` (the context/history BUDGET —
    // see AgentConfig's comment) from SystemAnalyzer's LOCAL machine load
    // — as low as 8000 on this session's own "critical"-status dev
    // machine — which is the right call for a local Ollama model, where
    // local RAM/CPU genuinely constrains what can run, but is a category
    // error for a cloud provider: a remote API's real context window
    // (128K+ for Groq/OpenAI/OpenRouter/NVIDIA, higher still for Gemini)
    // has nothing to do with this laptop's current memory pressure.
    // Confirmed live on a real SWE-bench task: with a cloud provider
    // serving the request, conversation history repeatedly exceeded
    // 100%+ of that 8000-token ceiling despite active compaction —
    // compaction's own 50%-of-maxTokens target (4000 tokens) leaves far
    // too little room for a real tool-heavy investigative task's system
    // prompt + tool schemas + search results. The real provider isn't
    // known until routing resolves it here, so this can't be decided at
    // construction time (getDefaultConfig() runs before any provider is
    // chosen) — re-derive it now that it is known.
    if (routing.provider.getType() !== "local") {
      const { maxContextLength } = routing.provider.getCapabilities();
      // Half the model's real context window, capped at a sane ceiling —
      // generous headroom for tool-heavy conversations without sending
      // needlessly huge payloads just because a model theoretically
      // supports more (slower, and on some free tiers, more likely to
      // trip a provider's own separate rate limit).
      this.config.maxTokens = Math.min(Math.floor(maxContextLength * 0.5), 32000);
    }

    const memory = getMemoryManager();
    const conversationId = memory.startConversation();

    const context: AgentContext = {
      taskId: task.id,
      task,
      conversationId,
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
    // Defensive reset — in practice every UniversalAgent is constructed
    // fresh per task (see AgentSpawner/ParallelOrchestrator), so this
    // shouldn't carry state across tasks, but initializeContext() is the
    // one place that's true by construction rather than by convention.
    this.compactionSummary = undefined;
    this.compactedThroughIndex = 0;

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

    // Best-effort — a memory-write failure must never break the agent loop.
    try {
      this.context.memory.recordTurn(this.context.conversationId, role, content);
    } catch (err) {
      this.logger.debug(
        `Failed to record conversation turn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Call the LLM with current context
   * Instrumented with telemetry: records timing, token usage, and provider info.
   */
  protected async callLLM(options?: {
    systemPrompt?: string;
    stream?: boolean;
    tools?: ToolSchema[];
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

    const truncatedMessages = await this.truncateMessages(
      allMessages,
      this.config.maxTokens,
    );

    const toolsToSend = options?.tools ?? this.getToolSchemas();

    if (options?.stream) {
      // ---- Telemetry-instrumented streaming call ----
      const streamStartTime = Date.now();
      const originalStream = provider.stream(truncatedMessages, {
        model,
        // outputMaxTokens (generation length), not maxTokens (the
        // context/history budget) — see AgentConfig's comment. Falls
        // back to maxTokens only if outputMaxTokens somehow isn't set
        // (shouldn't happen — getDefaultConfig() always sets it — but a
        // hand-built AgentConfig in a test or override could omit it).
        maxTokens: this.config.outputMaxTokens ?? this.config.maxTokens,
        tools: toolsToSend.length > 0 ? toolsToSend : undefined,
      });

      // Wrap the stream to measure time-to-first-token and collect content
      // Capture method references (avoids 'this' aliasing lint error)
      const safeRecord = this.safeRecordLLMCall.bind(this);
      const debugLog = this.logger.debug.bind(this.logger);

      const measuredStream = async function* (): AsyncIterable<StreamChunk> {
        let firstToken = true;
        let collectedContent = "";
        let firstTokenTime = streamStartTime;

        for await (const chunk of originalStream) {
          if (firstToken) {
            firstTokenTime = Date.now();
            const timeToFirstToken = firstTokenTime - streamStartTime;
            firstToken = false;

            // Log time-to-first-token for observability
            debugLog(
              `[telemetry] Time to first token: ${timeToFirstToken}ms (${provider.getType()}/${model})`,
            );
          }

          collectedContent += chunk.content;
          yield chunk;
        }

        // After stream completes, record LLM call telemetry
        const streamDurationMs = Date.now() - streamStartTime;
        const inputText = truncatedMessages.map((m) => m.content).join("\n");
        const estimatedInput = Math.ceil(inputText.length / 4);
        const estimatedOutput = Math.ceil(collectedContent.length / 4);

        safeRecord(
          provider.getType(),
          model,
          estimatedInput + estimatedOutput,
          estimatedInput,
          estimatedOutput,
          streamDurationMs,
          {
            content: collectedContent,
            usage: {
              inputTokens: estimatedInput,
              outputTokens: estimatedOutput,
              totalTokens: estimatedInput + estimatedOutput,
            },
            model,
            finishReason: "stop",
          },
        );
      };

      return measuredStream();
    }

    // ---- Telemetry-instrumented non-streaming call ----
    const startTime = Date.now();
    const result = await provider.complete(truncatedMessages, {
      model,
      maxTokens: this.config.outputMaxTokens ?? this.config.maxTokens,
      tools: toolsToSend.length > 0 ? toolsToSend : undefined,
    });
    const durationMs = Date.now() - startTime;

    // Record telemetry event
    this.safeRecordLLMCall(
      provider.getType(),
      model,
      result.usage?.totalTokens ?? 0,
      result.usage?.inputTokens ?? 0,
      result.usage?.outputTokens ?? 0,
      durationMs,
      result,
    );

    return result;
  }

  /**
   * Safely record an LLM call telemetry event.
   * Falls back to countTokens() estimate if usage data is missing (zero tokens).
   */
  private safeRecordLLMCall(
    providerType: string,
    model: string,
    totalTokens: number,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    result: CompletionResult,
  ): void {
    try {
      const collector = TelemetryCollector.getInstance();
      if (!collector.isEnabled()) return;

      // If usage data is missing (zero total), fall back to estimate
      let finalInput = inputTokens;
      let finalOutput = outputTokens;
      let finalTotal = totalTokens;

      if (finalTotal === 0 && this.context) {
        // Estimate: use the provider's countTokens or the rough estimate
        try {
          finalInput = this.context.provider.countTokens(
            this.context.messages.map((m) => m.content).join("\n"),
          );
          finalOutput = this.estimateTokenCount([
            { role: "assistant", content: result.content },
          ]);
          finalTotal = finalInput + finalOutput;
        } catch {
          // Fall back to length-based estimate
          finalInput = Math.ceil(
            this.context.messages
              .map((m) => this.extractTextContent(m.content))
              .join("\n").length / 4,
          );
          finalOutput = Math.ceil(result.content.length / 4);
          finalTotal = finalInput + finalOutput;
        }
      }

      // Compute estimated cost from provider
      let cost = 0;
      try {
        if (this.context) {
          cost = this.context.provider.estimateCost(
            finalInput,
            finalOutput,
            model,
          );
        }
      } catch (err) {
        // Cost estimation failure must never crash the agent, but it does
        // mean maxCost budget enforcement silently sees $0 for this call.
        this.logger.debug(
          `Cost estimation failed for ${model}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      collector.recordLLMCall(
        this.telemetrySessionId || collector.getSessionId(),
        this.telemetryTurnNumber || 1,
        providerType,
        model,
        {
          promptTokens: finalInput,
          completionTokens: finalOutput,
          totalTokens: finalTotal,
        },
        cost,
        durationMs,
      );
    } catch (err) {
      // Telemetry failure must NEVER crash the agent
      this.logger.debug(
        `LLM call telemetry recording failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The sole hot-path context-budget decision for what the model sees.
   * Above the threshold, tries structured LLM-based compaction first
   * (Compactor.ts) — a fixed-template summary of whatever's aging out of
   * the recent window, merged into any existing summary. Falls back to
   * pure heuristic truncation (drop what doesn't fit) if compaction fails,
   * times out, or there's no active provider context to call.
   */
  protected async truncateMessages(
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<ChatMessage[]> {
    const estimatedTokens = this.estimateTokenCount(messages);
    const COMPACTION_THRESHOLD = 0.7; // Proactive compaction at 70% capacity
    const effectiveLimit = Math.floor(maxTokens * COMPACTION_THRESHOLD);

    // If under 70%, no compaction needed
    if (estimatedTokens <= effectiveLimit) return messages;

    const percentage = Math.round((estimatedTokens / maxTokens) * 100);
    this.logger.warn(
      `Context usage reached ${percentage}% (${estimatedTokens}/${maxTokens} tokens). Compacting context to 50% capacity...`,
    );

    const systemMessages = messages.filter((m) => m.role === "system");
    const firstUserMsg = messages.find((m) => m.role === "user");
    // Stable-indexed (append-only) history excluding system messages and
    // the pinned first user message — compactedThroughIndex/recentStartIndex
    // are positions into this array and stay valid turn-to-turn since
    // messages are only ever appended, never reordered or removed.
    const historyMessages = messages.filter(
      (m) => m.role !== "system" && m !== firstUserMsg,
    );

    // Reduce to 50% target size when compacting
    const targetBudget = Math.floor(maxTokens * 0.5);
    const systemBudget = Math.floor(targetBudget * 0.2);
    const conversationBudget = targetBudget - systemBudget;

    const recent: ChatMessage[] = [];
    let tokenCount = 0;
    let recentStartIndex = historyMessages.length;

    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msg = historyMessages[i];
      const tokens = this.estimateTokenCount([msg]);
      if (tokenCount + tokens > conversationBudget) break;
      recent.unshift(msg);
      tokenCount += tokens;
      recentStartIndex = i;
    }

    const pinnedHead = firstUserMsg ? [firstUserMsg] : [];

    // Only messages aged out since the LAST compaction need summarizing —
    // never re-send content that's already folded into compactionSummary.
    const compactFrom = Math.min(this.compactedThroughIndex, recentStartIndex);
    const newOlderMessages = historyMessages.slice(compactFrom, recentStartIndex);

    if (newOlderMessages.length === 0) {
      const summaryMsgs = this.compactionSummary
        ? [renderSummaryMessage(this.compactionSummary)]
        : [];
      return [...systemMessages, ...pinnedHead, ...summaryMsgs, ...recent];
    }

    if (this.context) {
      const outcome = await compactMessages(newOlderMessages, {
        provider: this.context.provider,
        model: this.context.model,
        systemMessages,
        existingSummary: this.compactionSummary,
      });

      if (outcome) {
        this.compactionSummary = outcome.summary;
        this.compactedThroughIndex = recentStartIndex;
        return [
          ...systemMessages,
          ...pinnedHead,
          renderSummaryMessage(outcome.summary),
          ...recent,
        ];
      }
    }

    // Compaction unavailable or failed this turn — fall back to dropping
    // the un-summarized older messages. compactedThroughIndex is NOT
    // advanced, so this content is still eligible for a future compaction
    // attempt rather than being permanently lost from the summary.
    const summaryMsgs = this.compactionSummary
      ? [renderSummaryMessage(this.compactionSummary)]
      : [];
    return [...systemMessages, ...pinnedHead, ...summaryMsgs, ...recent];
  }

  private extractTextContent(
    content:
      | string
      | import("../../providers/ProviderInterface.js").ContentBlock[],
  ): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("\n");
    }
    return "";
  }

  protected estimateTokenCount(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      const text = this.extractTextContent(msg.content);
      total += Math.ceil(text.length / 4);
    }
    return total;
  }

  /**
   * Builds the "Why" line shown in the permission prompt when the current
   * task was flagged high-risk by TaskAnalyzer — reuses the riskFactors
   * already stashed on task.metadata by AgentSpawner.executeTask(), rather
   * than re-deriving anything here.
   */
  private buildRiskReason(): string | undefined {
    const task = this.context?.task;
    if (!task || task.risk !== "high") return undefined;

    const riskFactors = task.metadata?.riskFactors as
      | { value: number; description: string }[]
      | undefined;
    const hits = riskFactors?.filter((f) => f.value > 0).map((f) => f.description);

    return hits && hits.length > 0
      ? `Task flagged high-risk: ${hits.join("; ")}`
      : "Task flagged high-risk";
  }

  /**
   * Execute a tool
   * Instrumented with telemetry: records timing, tool name/args, and success/error.
   */
  protected async executeTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const hookManager = getHookManager();

    // Pre-tool-use hooks are a hard safety rail (e.g. blocking `rm -rf`) and
    // run before the interactive permission check — a hook block is not
    // something the user gets prompted to override.
    const preHookResult = await hookManager.execute("pre-tool-use", {
      toolName: name,
      params,
    });

    if (preHookResult.skip) {
      return {
        success: false,
        output: preHookResult.error || `Blocked by pre-tool-use hook: ${name}`,
      };
    }

    const effectiveParams =
      (preHookResult.modifiedData?.params as Record<string, unknown>) ?? params;

    const permissionSystem = getPermissionSystem();

    const check = permissionSystem.checkPermission(name, effectiveParams);
    if (!check.allowed) {
      if (check.requiresPrompt) {
        const approved = await permissionSystem.requestPermission({
          tool: name,
          params: effectiveParams,
          description: check.description,
          riskReason: this.buildRiskReason(),
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

    // ---- Telemetry: record start time ----
    const toolStartTime = Date.now();
    let toolSuccess = true;
    let toolError: string | undefined;
    let toolResultValue: unknown;

    // Counts every ATTEMPT against the budget, not just successes — used
    // to only increment in the try block's success path, so a tool that
    // kept failing (wrong params, a transient error, etc.) never counted
    // against maxToolCalls at all. A single LLM turn can contain many
    // tool calls (UniversalAgent's loop processes them in a plain
    // sequential for-of, not one-per-iteration), so maxIterations alone
    // doesn't reliably bound total tool-call attempts either — an agent
    // stuck repeatedly failing the same call could make far more actual
    // attempts than maxToolCalls implies while the counter stayed at 0.
    this.toolCallCount++;

    try {
      const rawResult = await tool.execute(effectiveParams);
      const result = this.scrubToolResult(rawResult);
      toolResultValue = result;
      this.context?.toolResults.set(`${name}_${Date.now()}`, result);
      return result;
    } catch (err) {
      toolSuccess = false;
      toolError = err instanceof Error ? err.message : String(err);

      await hookManager
        .execute("on-error", {
          error: err,
          toolName: name,
          taskId: this.context?.taskId,
          agentType: this.type,
        })
        .catch(() => {
          // Hook failures must never mask the original tool error
        });

      throw err; // Re-throw — caller handles the error
    } finally {
      const durationMs = Date.now() - toolStartTime;

      await hookManager
        .execute("post-tool-use", {
          toolName: name,
          params: effectiveParams,
          duration: durationMs,
          success: toolSuccess,
          result: toolResultValue,
          error: toolError,
        })
        .catch(() => {
          // Hook failures must never crash the agent
        });

      // Always record telemetry (even on error)
      this.safeRecordToolCall(
        name,
        effectiveParams,
        toolStartTime,
        toolSuccess,
        toolError,
      );
    }
  }

  /**
   * Safely record a tool call telemetry event.
   * Redacts secrets: truncates command strings > 200 chars, strips file contents.
   */
  private safeRecordToolCall(
    name: string,
    params: Record<string, unknown>,
    startTime: number,
    success: boolean,
    error?: string,
  ): void {
    try {
      const collector = TelemetryCollector.getInstance();
      if (!collector.isEnabled()) return;

      const durationMs = Date.now() - startTime;

      // Redact sensitive params
      const redactedArgs = this.redactToolArgs(name, params);

      collector.recordToolCall(
        this.telemetrySessionId || collector.getSessionId(),
        this.telemetryTurnNumber || 1,
        name,
        redactedArgs,
        success,
        durationMs,
        error,
      );
    } catch (err) {
      // Telemetry failure must NEVER crash the agent
      this.logger.debug(
        `Tool call telemetry recording failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Scrub secret-shaped values (API keys, tokens, Bearer headers) out of a
   * tool's own result before it's stored or returned — this is the boundary
   * where a raw secret (e.g. printed by `env` or `cat .env`) would otherwise
   * flow straight into the LLM conversation. Distinct from redactToolArgs()
   * below, which only ever fed the telemetry payload, not the conversation.
   */
  private scrubToolResult(result: unknown): unknown {
    if (typeof result !== "object" || result === null) return result;
    const r = result as { output?: unknown; metadata?: Record<string, unknown> };
    const scrubbed: Record<string, unknown> = { ...(result as object) };

    if (typeof r.output === "string") {
      scrubbed.output = scrubSecrets(r.output);
    }
    if (r.metadata && typeof r.metadata === "object") {
      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(r.metadata)) {
        metadata[key] = typeof value === "string" ? scrubSecrets(value) : value;
      }
      scrubbed.metadata = metadata;
    }
    return scrubbed;
  }

  /**
   * Redact potentially sensitive data from tool arguments.
   * - Truncate command strings > 200 chars
   * - Strip file contents from file_write/file_read params
   */
  private redactToolArgs(
    name: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      // Truncate string values that are too long
      if (typeof value === "string") {
        if (key === "command" || key === "cmd") {
          redacted[key] =
            value.length > 200 ? value.substring(0, 197) + "..." : value;
        } else if (
          (key === "content" || key === "data") &&
          value.length > 500
        ) {
          redacted[key] = value.substring(0, 497) + "...";
        } else {
          redacted[key] = value;
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Recursively redact nested objects
        redacted[key] = this.redactToolArgs(
          name,
          value as Record<string, unknown>,
        );
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
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

    // Sensible, fixed output-generation default (not derived from local
    // system load, nor from a provider's context-window size — see
    // AgentConfig.outputMaxTokens's comment). initializeContext() doesn't
    // override this the way it overrides `maxTokens`; a single turn's
    // response doesn't need to scale with the model's context window.
    return { ...defaults[type], outputMaxTokens: 4096, ...override };
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
   * Parse tool calls from LLM output - delegates to tool-parser.ts.
   * Passes this agent's actual registered tool names as the known-tools
   * gate (see tool-parser.ts) instead of relying on its hardcoded fallback
   * list, which would otherwise silently drop calls to any tool not on
   * that stale list (previously missing most real tools, e.g.
   * workspace_verify, and including some that never existed).
   */
  protected parseToolCalls(
    output: string,
  ): Array<{ name: string; params: Record<string, unknown> }> {
    return parseToolCalls(output, new Set(this.tools.keys())) as Array<{
      name: string;
      params: Record<string, unknown>;
    }>;
  }

  /**
   * True when `output` names a real tool inside a ```tool fence but
   * parseToolCalls() still returned zero calls for it — i.e. the model
   * tried to call a tool and the attempt was malformed/incomplete, not a
   * genuine final answer. See tool-parser.ts's hasIncompleteToolCallAttempt
   * for the real failure this distinguishes.
   */
  protected hasIncompleteToolCallAttempt(output: string): boolean {
    return hasIncompleteToolCallAttempt(output, new Set(this.tools.keys()));
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
