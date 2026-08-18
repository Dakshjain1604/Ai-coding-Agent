/**
 * Shared test harness for driving UniversalAgent.execute() end-to-end
 * against a scripted, deterministic fake provider — no network, no rate
 * limits, no dependency on a real LLM being configured.
 *
 * Unlike the ad hoc fakes in compactor.test.ts / base-agent-compaction.test.ts
 * (which hand-set agent.context and call internal methods directly), this
 * seeds the REAL provider-routing chain (ProviderFactory + ModelRouter) so
 * that initializeContext() and the full execute() loop run unmodified —
 * this is what actually gets exercised in production, not a stand-in for it.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BaseProvider } from "../../src/providers/ProviderInterface.js";
import type {
  ChatMessage,
  CompletionResult,
  ProviderCapabilities,
  StreamChunk,
} from "../../src/providers/ProviderInterface.js";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import { resetModelRouter } from "../../src/providers/ModelRouter.js";
import { resetMemoryManager, getMemoryManager } from "../../src/memory/MemoryManager.js";

/**
 * A scripted provider: each call to complete()/stream() returns the next
 * entry in `script`, in order (the last entry repeats if execute() calls
 * more times than scripted — most tests script exactly as many turns as
 * they expect).
 */
export class FakeProvider extends BaseProvider {
  private callIndex = 0;
  /** Every call's message list, in order — for asserting what the agent sent. */
  public calls: ChatMessage[][] = [];

  constructor(private readonly script: CompletionResult[]) {
    super("local");
  }

  private nextResult(): CompletionResult {
    const result = this.script[Math.min(this.callIndex, this.script.length - 1)];
    this.callIndex++;
    return result;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      embeddings: false,
      functionCalling: true,
      vision: false,
      maxContextLength: 128000,
      supportedModels: ["fake-model"],
    };
  }

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.calls.push(messages);
    return this.nextResult();
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<StreamChunk> {
    this.calls.push(messages);
    const result = this.nextResult();
    // One chunk carrying the full content is enough to exercise the real
    // consumption path (BaseAgent.callLLM's measuredStream, UniversalAgent's
    // token-by-token stdout write) without needing to fake token-by-token
    // network timing.
    yield { content: result.content, done: false };
  }

  async embed(): Promise<number[]> {
    return [];
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async getModels(): Promise<string[]> {
    return ["fake-model"];
  }

  estimateCost(): number {
    return 0;
  }
}

export interface FakeAgentEnv {
  provider: FakeProvider;
  tmpDir: string;
  cleanup: () => void;
}

/**
 * Wires a FakeProvider into the real provider-routing singletons
 * (ProviderFactory + ModelRouter) under the "local" provider type — which
 * is what `preferLocal` routing (the project default) picks first — and
 * points MemoryManager at a throwaway temp directory so tests never touch
 * the real project's .claude/memory.db. Call this in beforeEach; call the
 * returned cleanup() in afterEach.
 */
export function setupFakeAgentEnv(script: CompletionResult[]): FakeAgentEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-e2e-test-"));

  resetModelRouter();
  ProviderFactory.reset();
  resetMemoryManager();

  // Seed MemoryManager's singleton with a temp-dir config BEFORE
  // initializeContext() calls the bare getMemoryManager() — since the
  // singleton already exists at that point, it returns this instance
  // unchanged instead of constructing a new one against process.cwd().
  getMemoryManager({
    project: { rootDir: tmpDir },
    sqlite: { path: join(tmpDir, ".claude", "memory.db") },
  });

  const provider = new FakeProvider(script);
  const factory = ProviderFactory.getInstance({ preferLocal: true }) as unknown as {
    providers: Map<string, BaseProvider>;
    availability: Map<string, boolean>;
  };
  factory.providers.set("local", provider);
  factory.availability.set("local", true);

  const cleanup = () => {
    resetModelRouter();
    ProviderFactory.reset();
    resetMemoryManager();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { provider, tmpDir, cleanup };
}

/** Convenience builder for a scripted CompletionResult. */
export function scriptedResult(
  content: string,
  overrides?: Partial<CompletionResult>,
): CompletionResult {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    model: "fake-model",
    finishReason: "stop",
    ...overrides,
  };
}
