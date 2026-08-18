/**
 * Tests for healthcheck.ts (utils/healthcheck.ts) — previously zero
 * coverage despite validateProviders() running on every single
 * invocation of run/debug/test/review/simplify.
 *
 * Centerpiece regression: primaryProvider selection was a chain of
 * ad-hoc per-block negations that had drifted out of sync with each
 * other. Gemini's block computed a health check but never assigned
 * primaryProvider under any condition — so an environment with only
 * GOOGLE_API_KEY set would report overall:true (a provider IS
 * available) but primaryProvider stuck at the "local" default. Groq's
 * and OpenRouter's guard conditions didn't check `!openaiCheck?.
 * available`, so if OpenAI was already correctly selected as primary,
 * a later-checked-but-lower-priority Groq/OpenRouter that also happened
 * to be available would silently steal the primary designation. Fixed
 * with a single primaryChosen flag so only the first available provider
 * in priority order (local > claude > openai > gemini > groq >
 * openrouter > huggingface) ever wins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isAvailableMock, configState } = vi.hoisted(() => ({
  isAvailableMock: vi.fn(),
  configState: {
    providers: [] as Array<{ type: string; enabled: boolean }>,
  },
}));

vi.mock("../../src/providers/ProviderFactory.js", () => ({
  getProviderFactory: () => ({
    isAvailable: (...args: unknown[]) => isAvailableMock(...args),
  }),
}));

vi.mock("../../src/utils/config.js", () => ({
  getConfigManager: () => ({
    get: () => configState,
  }),
}));

import {
  checkProviderHealth,
  printProviderHealth,
  validateProviders,
} from "../../src/utils/healthcheck.js";

/** Sets which provider types report available:true; every other type
 * (including "local") reports false, matching checkLocalProvider's own
 * `factory.isAvailable("local")` call. */
function setAvailable(...types: string[]): void {
  const set = new Set(types);
  isAvailableMock.mockImplementation(async (type: string) => set.has(type));
}

/** Enables the given provider types in the mocked config (local is
 * always implicitly checked regardless of the providers list). */
function enableProviders(...types: string[]): void {
  configState.providers = types.map((type) => ({ type, enabled: true }));
}

beforeEach(() => {
  isAvailableMock.mockReset();
  configState.providers = [];
});

describe("checkProviderHealth — primaryProvider priority fix", () => {
  it("selects local as primary when local is available, regardless of other enabled providers", async () => {
    enableProviders("claude", "groq");
    setAvailable("local", "claude", "groq");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("local");
  });

  it("falls back to claude when local is unavailable", async () => {
    enableProviders("claude");
    setAvailable("claude");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("claude");
  });

  it("selects gemini as primary when it's the only available provider (previously never assigned at all)", async () => {
    enableProviders("gemini");
    setAvailable("gemini");
    const status = await checkProviderHealth();
    expect(status.overall).toBe(true);
    expect(status.primaryProvider).toBe("gemini");
  });

  it("does not let groq override an already-correct openai primary selection (the guard-gap bug)", async () => {
    enableProviders("openai", "groq");
    setAvailable("openai", "groq");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("openai");
  });

  it("does not let openrouter override an already-correct openai primary selection", async () => {
    enableProviders("openai", "openrouter");
    setAvailable("openai", "openrouter");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("openai");
  });

  it("does not let openrouter override an already-correct gemini primary selection", async () => {
    enableProviders("gemini", "openrouter");
    setAvailable("gemini", "openrouter");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("gemini");
  });

  it("falls through to groq when claude/openai/gemini are all unavailable or disabled", async () => {
    enableProviders("groq", "openrouter");
    setAvailable("groq", "openrouter");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("groq");
  });

  it("falls through to openrouter when nothing higher-priority is available", async () => {
    enableProviders("openrouter", "huggingface");
    setAvailable("openrouter", "huggingface");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("openrouter");
  });

  it("falls all the way through to huggingface as a last resort", async () => {
    enableProviders("huggingface");
    setAvailable("huggingface");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("huggingface");
  });

  it("respects declared priority order even when providers are enabled out of order in config", async () => {
    enableProviders("huggingface", "groq", "openai");
    setAvailable("openai", "groq", "huggingface");
    const status = await checkProviderHealth();
    expect(status.primaryProvider).toBe("openai");
  });
});

describe("checkProviderHealth — enabled/disabled and overall status", () => {
  it("reports overall:false when nothing is available", async () => {
    enableProviders("claude", "openai");
    setAvailable();
    const status = await checkProviderHealth();
    expect(status.overall).toBe(false);
  });

  it("reports overall:true if at least one provider is available", async () => {
    enableProviders("claude");
    setAvailable("claude");
    const status = await checkProviderHealth();
    expect(status.overall).toBe(true);
  });

  it("never checks a provider type that isn't enabled in config", async () => {
    enableProviders("claude");
    setAvailable("claude", "openai", "gemini");
    const status = await checkProviderHealth();
    expect(status.checks.some((c) => c.provider === "openai")).toBe(false);
    expect(status.checks.some((c) => c.provider === "gemini")).toBe(false);
  });

  it("always checks local even when the providers config list is empty", async () => {
    enableProviders();
    setAvailable("local");
    const status = await checkProviderHealth();
    expect(status.checks.some((c) => c.provider === "local (Ollama)")).toBe(true);
  });

  it("includes one check entry per enabled provider type, in priority order", async () => {
    enableProviders("openrouter", "claude", "groq");
    setAvailable();
    const status = await checkProviderHealth();
    const providers = status.checks.map((c) => c.provider);
    expect(providers).toEqual(["local (Ollama)", "claude", "groq", "openrouter"]);
  });
});

describe("checkProviderHealth — per-check messages and suggestions", () => {
  it("local check includes 'ollama serve' suggestions when unavailable", async () => {
    enableProviders();
    setAvailable();
    const status = await checkProviderHealth();
    const local = status.checks.find((c) => c.provider === "local (Ollama)")!;
    expect(local.available).toBe(false);
    expect(local.suggestions).toContain("Start Ollama: ollama serve");
  });

  it("local check reports healthy with no suggestions when available", async () => {
    setAvailable("local");
    const status = await checkProviderHealth();
    const local = status.checks.find((c) => c.provider === "local (Ollama)")!;
    expect(local.healthy).toBe(true);
    expect(local.suggestions).toBeUndefined();
  });

  it("local check catches a thrown error from isAvailable and reports a connection-failure message", async () => {
    isAvailableMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const status = await checkProviderHealth();
    const local = status.checks.find((c) => c.provider === "local (Ollama)")!;
    expect(local.available).toBe(false);
    expect(local.message).toContain("ECONNREFUSED");
    expect(local.suggestions?.some((s) => s.includes("ollama.ai"))).toBe(true);
  });

  it("cloud provider check suggests setting the right env var when unavailable", async () => {
    enableProviders("claude");
    setAvailable();
    const status = await checkProviderHealth();
    const claude = status.checks.find((c) => c.provider === "claude")!;
    expect(claude.suggestions?.some((s) => s.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("cloud provider check catches a thrown error from isAvailable", async () => {
    enableProviders("groq");
    isAvailableMock.mockImplementation(async () => {
      throw new Error("timeout");
    });
    const status = await checkProviderHealth();
    const groq = status.checks.find((c) => c.provider === "groq")!;
    expect(groq.available).toBe(false);
    expect(groq.message).toContain("timeout");
  });
});

describe("printProviderHealth", () => {
  it("does not throw for a healthy status", async () => {
    setAvailable("local");
    const status = await checkProviderHealth();
    expect(() => printProviderHealth(status)).not.toThrow();
  });

  it("does not throw for an unhealthy status", async () => {
    setAvailable();
    const status = await checkProviderHealth();
    expect(() => printProviderHealth(status)).not.toThrow();
  });
});

describe("validateProviders", () => {
  it("resolves without throwing when at least one provider is healthy", async () => {
    setAvailable("local");
    await expect(validateProviders()).resolves.toBeUndefined();
  });

  it("throws a descriptive error when no providers are available", async () => {
    enableProviders("claude");
    setAvailable();
    await expect(validateProviders()).rejects.toThrow(/No LLM providers available/);
  });

  it("prints the health report before throwing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setAvailable();
    await expect(validateProviders()).rejects.toThrow();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
