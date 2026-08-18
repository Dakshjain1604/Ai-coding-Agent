/**
 * Tests for ProviderFactory.get()/create()/getConfigForProvider()
 * (providers/ProviderFactory.ts) — previously had zero direct coverage
 * of the actual config-passing behavior (providers.test.ts only checks
 * that the factory/router construct without crashing).
 *
 * Two real, independently-confirmed bugs, both on the live path every
 * single LLM call goes through (ModelRouter calls factory.get(type) for
 * every provider resolution):
 *
 * 1. get(type) always passed a hardcoded stub `{type, enabled:true,
 *    models:{}}` into create() — the user's REAL configured apiKey/
 *    baseUrl/models (from coding-agent.json / `config set`) were never
 *    looked up at all, for any provider, ever. Masked in the common
 *    case by each provider's own process.env fallback for apiKey, but
 *    a user configuring apiKey via the config file instead of an env
 *    var would have it silently ignored.
 *
 * 2. getConfigForProvider()'s switch only handled claude/openai/gemini/
 *    local/ollama — groq/openrouter/huggingface/ollama-cloud fell
 *    through to `default: return {}`, discarding their config even
 *    when bug #1 was fixed and a real config WAS looked up. ollama-cloud
 *    was the worst case: its baseUrl has no env var fallback at all, so
 *    it was completely unusable through this factory regardless of how
 *    a user configured it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProviderFactory } from "../../src/providers/ProviderFactory.js";
import { createConfigManager } from "../../src/utils/config.js";

let dir: string;

function seedConfig(providers: Array<Record<string, unknown>>): void {
  dir = mkdtempSync(join(tmpdir(), "provider-factory-"));
  writeFileSync(
    join(dir, "coding-agent.json"),
    JSON.stringify({ providers }, null, 2),
  );
  createConfigManager(dir);
}

beforeEach(() => {
  ProviderFactory.reset();
});

afterEach(() => {
  ProviderFactory.reset();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ProviderFactory.get() — real config lookup fix", () => {
  it("passes a configured apiKey through to Claude, not just process.env", async () => {
    const savedEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      seedConfig([{ type: "claude", enabled: true, apiKey: "sk-from-config-file", models: {} }]);
      const factory = ProviderFactory.getInstance();
      // Would throw "API key not provided" if the config lookup still
      // silently dropped apiKey and there's no env var to fall back to.
      await expect(factory.get("claude")).resolves.toBeDefined();
    } finally {
      if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
    }
  });

  it("falls back to the {type, enabled:true, models:{}} stub when no config entry exists for the type", async () => {
    const savedGoogle = process.env.GOOGLE_API_KEY;
    const savedGemini = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      seedConfig([{ type: "claude", enabled: true, apiKey: "x", models: {} }]);
      const factory = ProviderFactory.getInstance();
      // "gemini" has no entry in the seeded config at all (mergeConfigs
      // replaces the providers array wholesale, it doesn't merge
      // element-by-element) — should not throw a lookup error, just
      // fall through to the stub (which then fails on a genuinely
      // missing API key, a separate, expected failure mode unrelated to
      // this fix).
      await expect(factory.get("gemini")).rejects.toThrow(/API key/);
    } finally {
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
    }
  });
});

describe("ProviderFactory — ollama-cloud config wiring (the worst-case fix)", () => {
  it("constructs successfully when baseUrl comes from config (no env var fallback exists for it)", async () => {
    seedConfig([
      {
        type: "ollama-cloud",
        enabled: true,
        baseUrl: "https://my-ollama-cloud.example.com",
        apiKey: "test-key",
        models: { code: "llama3.2" },
      },
    ]);
    const factory = ProviderFactory.getInstance();
    // Before the fix, this always threw "OllamaCloud baseUrl is
    // required" regardless of configuration, since baseUrl never
    // reached the constructor through this path.
    await expect(factory.get("ollama-cloud")).resolves.toBeDefined();
  });

  it("still throws its own real error when baseUrl is genuinely absent everywhere", async () => {
    seedConfig([{ type: "ollama-cloud", enabled: true, models: {} }]);
    const factory = ProviderFactory.getInstance();
    await expect(factory.get("ollama-cloud")).rejects.toThrow(/baseUrl/i);
  });
});

describe("ProviderFactory — groq/openrouter/huggingface config wiring", () => {
  it("passes a configured apiKey through to Groq", async () => {
    const savedEnv = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      seedConfig([{ type: "groq", enabled: true, apiKey: "gsk-from-config", models: {} }]);
      const factory = ProviderFactory.getInstance();
      await expect(factory.get("groq")).resolves.toBeDefined();
    } finally {
      if (savedEnv !== undefined) process.env.GROQ_API_KEY = savedEnv;
    }
  });

  it("passes a configured apiKey through to OpenRouter", async () => {
    const savedEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      seedConfig([{ type: "openrouter", enabled: true, apiKey: "or-from-config", models: {} }]);
      const factory = ProviderFactory.getInstance();
      await expect(factory.get("openrouter")).resolves.toBeDefined();
    } finally {
      if (savedEnv !== undefined) process.env.OPENROUTER_API_KEY = savedEnv;
    }
  });

  it("passes a configured apiKey through to HuggingFace", async () => {
    const savedEnv = process.env.HUGGINGFACE_API_KEY;
    delete process.env.HUGGINGFACE_API_KEY;
    try {
      seedConfig([{ type: "huggingface", enabled: true, apiKey: "hf-from-config", models: {} }]);
      const factory = ProviderFactory.getInstance();
      await expect(factory.get("huggingface")).resolves.toBeDefined();
    } finally {
      if (savedEnv !== undefined) process.env.HUGGINGFACE_API_KEY = savedEnv;
    }
  });
});

describe("ProviderFactory.get() — caching still works after the fix", () => {
  it("returns the same instance on a second get() call for the same type", async () => {
    seedConfig([{ type: "claude", enabled: true, apiKey: "x", models: {} }]);
    const factory = ProviderFactory.getInstance();
    const first = await factory.get("claude");
    const second = await factory.get("claude");
    expect(first).toBe(second);
  });
});
