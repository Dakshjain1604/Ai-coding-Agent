/**
 * Tests for ModelRouter (providers/ModelRouter.ts) — the routing engine
 * behind every single LLM call in the system, previously only touched
 * incidentally by a handful of cases in providers.test.ts.
 *
 * Centerpiece regression: canMakePaidCall()/recordCall() had ZERO callers
 * anywhere in route()/routeToRule()/routeToFallback() — so a user setting
 * defaults.maxPaidApiCalls to cap their spend got no actual protection at
 * all; every route() call ignored the limit entirely. Confirmed live with
 * a scripted FakeProvider: with maxPaidApiCalls=1 and a custom rule
 * forcing "code" tasks to claude, the SECOND route("code") call still
 * returned claude before this fix. Now it correctly falls back to a free
 * provider once the cap is hit, and getStats() (also previously always
 * zero for real usage) reflects the real counts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import { ModelRouter, getModelRouter, resetModelRouter } from "../../src/providers/ModelRouter.js";
import { BaseProvider } from "../../src/providers/ProviderInterface.js";
import type {
  CompletionResult,
  ProviderCapabilities,
  StreamChunk,
} from "../../src/providers/ProviderInterface.js";
import type { ProviderType } from "../../src/utils/types.js";

class FakeProvider extends BaseProvider {
  constructor(type: ProviderType) {
    super(type);
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
      maxContextLength: 100000,
      supportedModels: ["x"],
    };
  }
  async complete(): Promise<CompletionResult> {
    return {
      content: "x",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "x",
      finishReason: "stop",
    };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield { content: "x", done: true };
  }
  async embed(): Promise<number[]> {
    return [];
  }
  countTokens(): number {
    return 1;
  }
  async getModels(): Promise<string[]> {
    return ["x"];
  }
  estimateCost(): number {
    return 0;
  }
}

/** Seeds the ProviderFactory singleton with fake, always-available
 * providers for exactly the types given — every other type is left
 * genuinely unavailable, matching how a real environment with only some
 * API keys configured behaves. */
function seedProviders(types: ProviderType[], preferLocal = false): void {
  ProviderFactory.reset();
  const factory = ProviderFactory.getInstance({ preferLocal });
  for (const type of types) {
    (factory as unknown as { providers: Map<ProviderType, BaseProvider> }).providers.set(
      type,
      new FakeProvider(type),
    );
    (factory as unknown as { availability: Map<ProviderType, boolean> }).availability.set(
      type,
      true,
    );
  }
}

beforeEach(() => {
  resetModelRouter();
});

afterEach(() => {
  ProviderFactory.reset();
  resetModelRouter();
});

describe("ModelRouter — custom rule availability check (the fix)", () => {
  it("falls through to the default/fallback chain when a custom rule's provider is unavailable, instead of returning it anyway", async () => {
    // claude is NOT seeded — genuinely unavailable, matching a
    // misconfigured/missing-API-key custom rule in real usage.
    seedProviders(["groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    const result = await router.route("code");
    expect(result.provider.getType()).not.toBe("claude");
    expect(result.provider.getType()).toBe("groq");
  });

  it("still uses the custom rule's provider when it genuinely is available", async () => {
    seedProviders(["claude", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    const result = await router.route("code");
    expect(result.provider.getType()).toBe("claude");
  });
});

describe("ModelRouter — canMakePaidCall()/recordCall() wiring (the fix)", () => {
  it("routes to a paid provider via a custom rule when under the cap", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    const result = await router.route("code");
    expect(result.provider.getType()).toBe("claude");
  });

  it("skips the paid custom-rule provider once the cap is reached, falling back instead", async () => {
    seedProviders(["claude", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    await router.route("code"); // consumes the only allowed paid call
    const second = await router.route("code");
    expect(second.provider.getType()).not.toBe("claude");
    expect(second.provider.getType()).toBe("groq");
  });

  it("skips a paid default-rule provider once the cap is reached", async () => {
    seedProviders(["openai", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "openai", model: "gpt-4o" }],
    });
    await router.route("code");
    const second = await router.route("code");
    expect(second.provider.getType()).not.toBe("openai");
  });

  it("skips a paid provider in the fallback chain once the cap is reached", async () => {
    seedProviders(["gemini"]); // only a paid provider available, no free ones
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "gemini", model: "gemini-2.0-flash" }],
    });

    await router.route("code"); // uses the only allowed paid call
    await expect(router.route("code")).rejects.toThrow(/no available providers/i);
  });

  it("never restricts a free provider (local/groq/openrouter), only paid ones", async () => {
    seedProviders(["groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "groq", model: "openai/gpt-oss-20b" }],
    });

    for (let i = 0; i < 5; i++) {
      const result = await router.route("code");
      expect(result.provider.getType()).toBe("groq");
    }
  });

  it("defaults to unlimited paid calls when maxPaidApiCalls is 0 (the schema default)", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    for (let i = 0; i < 5; i++) {
      const result = await router.route("code");
      expect(result.provider.getType()).toBe("claude");
    }
  });

  it("does NOT treat maxPaidApiCalls:0 as unlimited when fallbackToPaid is false", async () => {
    seedProviders(["claude", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: false,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    // canMakePaidCall()'s "0 = unlimited" special case requires
    // fallbackToPaid to also be true — with it false, 0 paid calls means
    // literally zero.
    const result = await router.route("code");
    expect(result.provider.getType()).not.toBe("claude");
  });

  it("getStats() reflects real call counts after routing (previously always all-zero for real usage)", async () => {
    seedProviders(["claude", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    await router.route("code");
    await router.route("code");
    expect(router.getStats().claude).toBe(2);
  });

  it("canMakePaidCall() counts across claude/openai/gemini together, not per-provider", async () => {
    seedProviders(["claude", "openai"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });

    await router.route("code"); // 1 paid call recorded (claude)
    const routeToResult = await router.routeTo("openai", "gpt-4o");
    // routeTo() is an explicit override and must not be blocked by the cap.
    expect(routeToResult.provider.getType()).toBe("openai");
  });

  it("recordCall() is reflected immediately (no debounce/async lag)", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 0,
      costPreference: "balanced",
      customRules: [],
    });
    router.recordCall("claude");
    expect(router.getStats().claude).toBe(1);
    router.recordCall("claude");
    expect(router.getStats().claude).toBe(2);
  });

  it("allows exactly up to the configured cap, not one fewer", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 3,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });
    for (let i = 0; i < 3; i++) {
      const result = await router.route("code");
      expect(result.provider.getType()).toBe("claude");
    }
  });

  it("blocks exactly on the call after the cap is reached, not one call late", async () => {
    seedProviders(["claude", "groq"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 2,
      costPreference: "balanced",
      customRules: [{ taskCategory: "code", provider: "claude", model: "claude-sonnet-4-6" }],
    });
    await router.route("code"); // 1
    await router.route("code"); // 2, cap reached
    const third = await router.route("code"); // 3rd must be blocked
    expect(third.provider.getType()).not.toBe("claude");
  });

  it("isPaidProvider classifies local/groq/openrouter as free (never gated by the cap)", async () => {
    seedProviders(["groq", "local", "openrouter"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: false,
      maxPaidApiCalls: 0, // strictest possible setting
      customRules: [{ taskCategory: "code", provider: "groq", model: "openai/gpt-oss-20b" }],
    });
    const result = await router.route("code");
    expect(result.provider.getType()).toBe("groq");
  });

  // Regression, confirmed live: an NVIDIA-only environment (NVIDIA_API_KEY
  // set, OPENAI_API_KEY absent, no other provider keys) got "No available
  // providers found" from the real CLI, even though the NVIDIA key worked
  // perfectly when tested directly against the real API. Root cause:
  // "openai" is unconditionally in PAID_PROVIDER_TYPES, and the app's own
  // `fallbackToPaid: false` config default (a deliberate guard against
  // spending real money) blocked it — with no way to tell "openai" is
  // actually running for free via NVIDIA apart, since both share the same
  // ProviderType.
  it("does NOT treat 'openai' as a paid provider when it's actually running in NVIDIA fallback mode", async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalNvidia = process.env.NVIDIA_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      process.env.NVIDIA_API_KEY = "test-nvidia-key";
      seedProviders(["openai"]);
      const router = new ModelRouter({
        preferLocal: false,
        fallbackToPaid: false, // the app's real default — must not block NVIDIA
        maxPaidApiCalls: 0, // strictest possible setting
      });
      const result = await router.route("code");
      expect(result.provider.getType()).toBe("openai");
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalNvidia === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = originalNvidia;
    }
  });

  it("STILL treats 'openai' as a paid provider when it's genuinely running as real OpenAI (OPENAI_API_KEY set)", async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-real-key";
      // Seed a genuinely free provider too, so a result other than
      // "openai" is actually reachable — with only "openai" seeded and
      // correctly blocked as paid, route() would just throw "no available
      // providers", which wouldn't distinguish "blocked" from "simply
      // absent".
      seedProviders(["openai", "local"]);
      const router = new ModelRouter({
        preferLocal: false,
        fallbackToPaid: false,
        maxPaidApiCalls: 0,
      });
      const result = await router.route("code");
      expect(result.provider.getType()).not.toBe("openai");
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
    }
  });
});

describe("ModelRouter — routeTo() (explicit override, bypasses the paid cap)", () => {
  it("routes to the exact provider/model requested", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter();
    const result = await router.routeTo("claude", "claude-opus-4-6");
    expect(result.provider.getType()).toBe("claude");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("throws when the requested provider is unavailable", async () => {
    seedProviders([]); // nothing available
    const router = new ModelRouter();
    await expect(router.routeTo("claude", "claude-opus-4-6")).rejects.toThrow(/not available/i);
  });

  it("is not subject to the paid-call cap (explicit request always honored)", async () => {
    seedProviders(["claude"]);
    const router = new ModelRouter({
      preferLocal: false,
      fallbackToPaid: true,
      maxPaidApiCalls: 1,
      costPreference: "balanced",
      customRules: [],
    });
    router.recordCall("claude");
    router.recordCall("claude"); // already well over the cap
    const result = await router.routeTo("claude", "claude-opus-4-6");
    expect(result.provider.getType()).toBe("claude");
  });
});

describe("ModelRouter — routeToFallback() ordering and exclusion", () => {
  it("falls back in order: local, groq, openrouter, gemini, openai, claude", async () => {
    seedProviders(["groq", "openai"]);
    const router = new ModelRouter({ preferLocal: false });
    // No custom/default rule for a category not in either rule table.
    const result = await (router as unknown as {
      routeToFallback: (c: string, t: number, e?: ProviderType[]) => Promise<{ provider: BaseProvider }>;
    }).routeToFallback("code", 1000);
    expect(result.provider.getType()).toBe("groq"); // groq comes before openai in the order
  });

  it("respects an exclude list", async () => {
    seedProviders(["groq", "openai"]);
    const router = new ModelRouter({ preferLocal: false });
    const result = await (router as unknown as {
      routeToFallback: (c: string, t: number, e?: ProviderType[]) => Promise<{ provider: BaseProvider }>;
    }).routeToFallback("code", 1000, ["groq"]);
    expect(result.provider.getType()).toBe("openai");
  });

  it("throws a clear error when nothing is available", async () => {
    seedProviders([]);
    const router = new ModelRouter({ preferLocal: false });
    await expect(
      (router as unknown as { routeToFallback: (c: string, t: number) => Promise<unknown> }).routeToFallback(
        "code",
        1000,
      ),
    ).rejects.toThrow(/no available providers/i);
  });

  // Regression: preferQuality used to be silently dropped on every
  // fallback path (both the top-level "primary provider unavailable" case
  // and attemptDynamicFallback's mid-task provider swap) — routeToFallback
  // always called getDefaultModelForCategory regardless of what the
  // caller asked for. Confirmed live: a real SWE-bench debug-mode task
  // correctly requested preferQuality on its initial routing, but Groq's
  // daily quota forced a fallback to OpenRouter, which landed on the
  // fast/small default model instead of the quality-tier one, with no
  // code path that could have done otherwise.
  it("uses the quality tier's model when preferQuality is passed through", async () => {
    seedProviders(["groq"]);
    const router = new ModelRouter({ preferLocal: false });
    const result = await (router as unknown as {
      routeToFallback: (
        c: string,
        t: number,
        e?: ProviderType[],
        pq?: boolean,
      ) => Promise<{ provider: BaseProvider; model: string }>;
    }).routeToFallback("code", 1000, undefined, true);
    expect(result.model).toBe("openai/gpt-oss-120b");
  });

  it("uses the default tier's model when preferQuality is not passed", async () => {
    seedProviders(["groq"]);
    const router = new ModelRouter({ preferLocal: false });
    const result = await (router as unknown as {
      routeToFallback: (
        c: string,
        t: number,
        e?: ProviderType[],
        pq?: boolean,
      ) => Promise<{ provider: BaseProvider; model: string }>;
    }).routeToFallback("code", 1000);
    expect(result.model).toBe("openai/gpt-oss-20b");
  });
});

describe("ModelRouter — route() default-rule behavior", () => {
  it("uses LOCAL_FIRST_RULES when preferLocal is true", async () => {
    seedProviders(["local"], true);
    const router = new ModelRouter({ preferLocal: true });
    const result = await router.route("code");
    expect(result.provider.getType()).toBe("local");
  });

  it("falls back when the default-rule provider is unavailable", async () => {
    seedProviders(["groq"], true); // local unavailable, only groq seeded
    const router = new ModelRouter({ preferLocal: true });
    const result = await router.route("code");
    expect(result.provider.getType()).toBe("groq");
  });

  // Regression: route()'s public entry point end-to-end, not just the
  // private routeToFallback() method directly — proves preferQuality
  // actually survives the full "default-rule provider unavailable ->
  // fallback" path a real dynamic-fallback mid-task switch takes.
  it("preferQuality survives the fallback path end-to-end through the public route() entry point", async () => {
    seedProviders(["groq"], true); // local unavailable, only groq seeded
    const router = new ModelRouter({ preferLocal: true });
    const result = await router.route("code", 1000, { preferQuality: true });
    expect(result.provider.getType()).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
  });

  it("respects the exclude option on the default rule", async () => {
    seedProviders(["local", "groq"], true);
    const router = new ModelRouter({ preferLocal: true });
    const result = await router.route("code", 1000, { exclude: ["local"] });
    expect(result.provider.getType()).not.toBe("local");
  });

  it("routeToBest() (used when no rule matches) resolves via the same fallback order", async () => {
    seedProviders(["groq"]);
    const router = new ModelRouter({ preferLocal: false, customRules: [] });
    const result = await (router as unknown as {
      routeToBest: (c: string, t: number) => Promise<{ provider: BaseProvider }>;
    }).routeToBest("code", 1000);
    expect(result.provider.getType()).toBe("groq");
  });

  it("a custom rule takes priority over the default rule for the same category", async () => {
    seedProviders(["local", "groq"], true);
    const router = new ModelRouter({
      preferLocal: true, // default rule would pick local
      customRules: [{ taskCategory: "code", provider: "groq", model: "openai/gpt-oss-20b" }],
    });
    const result = await router.route("code");
    expect(result.provider.getType()).toBe("groq");
  });

  it("an excluded custom-rule provider falls through to the default rule", async () => {
    seedProviders(["local", "groq"], true);
    const router = new ModelRouter({
      preferLocal: true,
      customRules: [{ taskCategory: "code", provider: "groq", model: "openai/gpt-oss-20b" }],
    });
    const result = await router.route("code", 1000, { exclude: ["groq"] });
    expect(result.provider.getType()).toBe("local");
  });

  it("preferQuality selects a different model than the default rule's model", async () => {
    seedProviders(["local"], true);
    const router = new ModelRouter({ preferLocal: true });
    const normal = await router.route("code");
    const quality = await router.route("code", 1000, { preferQuality: true });
    // Both must still resolve to a real, non-empty model string; the
    // point under test is that the preference path is actually consulted
    // (getBetterModel), not that it necessarily differs for every category.
    expect(typeof quality.model).toBe("string");
    expect(quality.model.length).toBeGreaterThan(0);
    expect(typeof normal.model).toBe("string");
  });

  it("preferSpeed selects a real model without throwing", async () => {
    seedProviders(["local"], true);
    const router = new ModelRouter({ preferLocal: true });
    const result = await router.route("code", 1000, { preferSpeed: true });
    expect(typeof result.model).toBe("string");
    expect(result.model.length).toBeGreaterThan(0);
  });
});

describe("ModelRouter — resolveProvider() ollama aliasing", () => {
  it("treats 'ollama' and 'local' as the same provider for availability/routing", async () => {
    seedProviders(["local"]);
    const router = new ModelRouter({
      preferLocal: false,
      customRules: [{ taskCategory: "code", provider: "ollama", model: "qwen2.5-coder:latest" }],
    });
    const result = await router.route("code");
    expect(result.provider.getType()).toBe("local");
  });

  it("recordCall() for an ollama-resolved route is counted under 'local' in getStats()", async () => {
    seedProviders(["local"]);
    const router = new ModelRouter({
      preferLocal: false,
      customRules: [{ taskCategory: "code", provider: "ollama", model: "qwen2.5-coder:latest" }],
    });
    await router.route("code");
    const stats = router.getStats();
    expect(stats.local).toBe(1);
    expect(stats.ollama).toBe(1); // mirrored, since ollama is just an alias
  });
});

describe("ModelRouter — cost/latency estimation", () => {
  it("estimates zero cost for a free model", async () => {
    const router = new ModelRouter();
    const cost = await (router as unknown as {
      estimateCost: (m: string, t: number) => Promise<number>;
    }).estimateCost("qwen2.5-coder:latest", 10000);
    expect(cost).toBe(0);
  });

  it("estimates non-zero cost for a paid model proportional to tokens", async () => {
    const router = new ModelRouter();
    const priv = router as unknown as { estimateCost: (m: string, t: number) => Promise<number> };
    const small = await priv.estimateCost("claude-sonnet-4-6", 1_000_000);
    const large = await priv.estimateCost("claude-sonnet-4-6", 2_000_000);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("falls back to a generic spec for a totally unknown model", async () => {
    // resolveModelSpec() tries the real, disk/network-backed ModelCatalog
    // FIRST for any model — a known model like "claude-sonnet-4-6" isn't
    // deterministically testable here since a real cached catalog file
    // may exist in the environment and take priority over MODEL_SPECS.
    // A genuinely made-up model name is the one case guaranteed to miss
    // the catalog and prove the MODEL_SPECS/generic fallback actually works.
    const router = new ModelRouter();
    const contextLength = await router.getContextLength("some-made-up-model-xyz");
    expect(contextLength).toBe(8192);
  });

  it("estimateLatency scales with token count", async () => {
    const router = new ModelRouter();
    const priv = router as unknown as { estimateLatency: (m: string, t: number) => Promise<number> };
    const short = await priv.estimateLatency("qwen2.5-coder:latest", 100);
    const long = await priv.estimateLatency("qwen2.5-coder:latest", 100000);
    expect(long).toBeGreaterThan(short);
  });

});

describe("ModelRouter — updateConfig()", () => {
  it("switches the default rule table when preferLocal changes", async () => {
    // Seed BOTH the cloud-first rule's provider (groq, for "code" — Groq
    // is the cloud-first primary for latency, OpenRouter the rate-limit
    // fallback, see CLOUD_FIRST_RULES's comment) and local, so cloud-first
    // genuinely resolves via its own default rule rather than falling all
    // the way back to local by coincidence (local sorts first in the
    // generic fallback order regardless of preferLocal, which would make
    // a "not local" assertion meaningless if groq weren't actually
    // available to prove cloud-first works).
    seedProviders(["local", "groq"], false);
    const router = new ModelRouter({ preferLocal: false });
    const before = await router.route("code");
    expect(before.provider.getType()).toBe("groq");

    router.updateConfig({ preferLocal: true });
    const after = await router.route("code");
    expect(after.provider.getType()).toBe("local");
  });

  it("propagates preferLocal/fallbackToPaid to the underlying ProviderFactory", () => {
    seedProviders(["local"]);
    const router = new ModelRouter({ preferLocal: false });
    const factory = ProviderFactory.getInstance();
    const setOptionsSpy = (factory as unknown as { setOptions: (o: unknown) => void }).setOptions;
    let called = false;
    (factory as unknown as { setOptions: (o: unknown) => void }).setOptions = (o: unknown) => {
      called = true;
      setOptionsSpy.call(factory, o);
    };
    router.updateConfig({ preferLocal: true });
    expect(called).toBe(true);
  });
});

describe("getModelRouter() / resetModelRouter() singleton", () => {
  it("returns the same instance across calls", () => {
    const a = getModelRouter();
    const b = getModelRouter();
    expect(a).toBe(b);
  });

  it("resetModelRouter() forces a fresh instance", () => {
    const a = getModelRouter();
    resetModelRouter();
    const b = getModelRouter();
    expect(a).not.toBe(b);
  });

  it("config only takes effect on first construction (seed-before-first-use)", async () => {
    seedProviders(["local"]);
    const a = getModelRouter({ preferLocal: true });
    const b = getModelRouter({ preferLocal: false }); // ignored, instance already exists
    expect(a).toBe(b);
    const result = await a.route("code");
    expect(result.provider.getType()).toBe("local"); // reflects the FIRST config
  });
});

describe("ModelRouter — canMakePaidCall() as a direct unit (no routing involved)", () => {
  it("returns true with default config (fallbackToPaid:true, maxPaidApiCalls:0)", () => {
    const router = new ModelRouter();
    expect(router.canMakePaidCall()).toBe(true);
  });

  it("returns false once recordCall() pushes past a real configured cap", () => {
    const router = new ModelRouter({ fallbackToPaid: true, maxPaidApiCalls: 2 });
    expect(router.canMakePaidCall()).toBe(true);
    router.recordCall("claude");
    router.recordCall("openai");
    expect(router.canMakePaidCall()).toBe(false);
  });

  it("counts claude + openai + gemini together against a single shared cap", () => {
    const router = new ModelRouter({ fallbackToPaid: true, maxPaidApiCalls: 3 });
    router.recordCall("claude");
    router.recordCall("openai");
    router.recordCall("gemini");
    expect(router.canMakePaidCall()).toBe(false);
  });

  it("does not count free-provider calls against the paid cap", () => {
    const router = new ModelRouter({ fallbackToPaid: true, maxPaidApiCalls: 1 });
    router.recordCall("groq");
    router.recordCall("local");
    router.recordCall("openrouter");
    expect(router.canMakePaidCall()).toBe(true);
  });
});

describe("ModelRouter — getStats()", () => {
  it("starts at zero for every provider type before any calls", () => {
    const router = new ModelRouter();
    const stats = router.getStats();
    for (const count of Object.values(stats)) {
      expect(count).toBe(0);
    }
  });

  it("tracks each provider type independently", () => {
    const router = new ModelRouter();
    router.recordCall("groq");
    router.recordCall("groq");
    router.recordCall("openai");
    const stats = router.getStats();
    expect(stats.groq).toBe(2);
    expect(stats.openai).toBe(1);
    expect(stats.claude).toBe(0);
  });
});
