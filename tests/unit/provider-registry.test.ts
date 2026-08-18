import { describe, it, expect } from "vitest";
import { getModelFor } from "../../src/providers/ProviderRegistry.js";

describe("ProviderRegistry.getModelFor", () => {
  it("resolves the same local model across all three tiers (local has no tiers)", () => {
    expect(getModelFor("local", "default", "code")).toBe("qwen2.5-coder:latest");
    expect(getModelFor("local", "quality", "code")).toBe("qwen2.5-coder:latest");
    expect(getModelFor("local", "speed", "code")).toBe("qwen2.5-coder:latest");
  });

  it("resolves distinct models per tier for a provider with real tiers", () => {
    const fast = getModelFor("claude", "speed", "complex");
    const balanced = getModelFor("claude", "default", "complex");
    const best = getModelFor("claude", "quality", "complex");

    expect(fast).toBe("claude-sonnet-4-6");
    expect(balanced).toBe("claude-opus-4-6");
    expect(best).toBe("claude-opus-4-6");
  });

  it("falls back to local's default tier for a genuinely unknown provider", () => {
    // @ts-expect-error deliberately passing an invalid ProviderType to exercise the fallback
    const model = getModelFor("not-a-real-provider", "default", "code");
    expect(model).toBe("qwen2.5-coder:latest");
  });

  it("openai's default tier responds to NVIDIA fallback env vars", () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalNvidia = process.env.NVIDIA_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      process.env.NVIDIA_API_KEY = "test-key";
      expect(getModelFor("openai", "default", "code")).toBe(
        "meta/llama-3.1-8b-instruct",
      );

      process.env.OPENAI_API_KEY = "sk-real-key";
      expect(getModelFor("openai", "default", "code")).toBe("gpt-4o");
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalNvidia === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = originalNvidia;
    }
  });

  it("every provider has an entry for every task category in every tier", () => {
    const providers: Array<Parameters<typeof getModelFor>[0]> = [
      "local",
      "ollama",
      "claude",
      "openai",
      "gemini",
      "groq",
      "openrouter",
      "huggingface",
      "ollama-cloud",
    ];
    const tiers: Array<Parameters<typeof getModelFor>[1]> = [
      "default",
      "quality",
      "speed",
    ];
    const categories: Array<Parameters<typeof getModelFor>[2]> = [
      "simple",
      "code",
      "complex",
      "reasoning",
      "embedding",
    ];

    for (const provider of providers) {
      for (const tier of tiers) {
        for (const category of categories) {
          const model = getModelFor(provider, tier, category);
          expect(typeof model).toBe("string");
          expect(model.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
