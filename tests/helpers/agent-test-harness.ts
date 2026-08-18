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
import type { ProviderType } from "../../src/utils/types.js";

/** A script entry is either a successful completion or a thrown error —
 * used to test the retry/fallback loop's failure-classification behavior. */
export type ScriptEntry = CompletionResult | { __throws: Error };

function isThrowEntry(entry: ScriptEntry): entry is { __throws: Error } {
  return typeof entry === "object" && entry !== null && "__throws" in entry;
}

/**
 * A scripted provider: each call to complete()/stream() returns (or
 * throws) the next entry in `script`, in order (the last entry repeats if
 * execute() calls more times than scripted — most tests script exactly as
 * many turns as they expect).
 */
export class FakeProvider extends BaseProvider {
  private callIndex = 0;
  /** Every call's message list, in order — for asserting what the agent sent. */
  public calls: ChatMessage[][] = [];

  constructor(
    private readonly script: ScriptEntry[],
    type: ProviderType = "local",
  ) {
    super(type);
  }

  private nextEntry(): ScriptEntry {
    const entry = this.script[Math.min(this.callIndex, this.script.length - 1)];
    this.callIndex++;
    return entry;
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
    const entry = this.nextEntry();
    if (isThrowEntry(entry)) throw entry.__throws;
    return entry;
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<StreamChunk> {
    this.calls.push(messages);
    const entry = this.nextEntry();
    if (isThrowEntry(entry)) throw entry.__throws;
    // One chunk carrying the full content is enough to exercise the real
    // consumption path (BaseAgent.callLLM's measuredStream, UniversalAgent's
    // token-by-token stdout write) without needing to fake token-by-token
    // network timing.
    yield { content: entry.content, done: false };
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
  /** Set only when a fallbackScript was provided to setupFakeAgentEnv. */
  fallbackProvider?: FakeProvider;
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
 *
 * Pass `fallbackScript` to also seed a second provider ("groq") available
 * for the retry loop's dynamic-fallback path to switch to when the
 * primary ("local") provider fails — without this, fallback attempts find
 * no alternate provider and the original error surfaces immediately.
 */
export function setupFakeAgentEnv(
  script: ScriptEntry[],
  fallbackScript?: ScriptEntry[],
): FakeAgentEnv {
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

  const provider = new FakeProvider(script, "local");
  const factory = ProviderFactory.getInstance({ preferLocal: true }) as unknown as {
    providers: Map<string, BaseProvider>;
    availability: Map<string, boolean>;
  };
  factory.providers.set("local", provider);
  factory.availability.set("local", true);

  let fallbackProvider: FakeProvider | undefined;
  if (fallbackScript) {
    fallbackProvider = new FakeProvider(fallbackScript, "groq");
    factory.providers.set("groq", fallbackProvider);
    factory.availability.set("groq", true);
  }

  const cleanup = () => {
    resetModelRouter();
    ProviderFactory.reset();
    resetMemoryManager();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { provider, fallbackProvider, tmpDir, cleanup };
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

/** Convenience builder for a scripted thrown error. */
export function scriptedError(message: string): ScriptEntry {
  return { __throws: new Error(message) };
}
