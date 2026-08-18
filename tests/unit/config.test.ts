/**
 * Tests for API key masking (architecture-optimal.md Phase 2, item C1).
 * ConfigManager.save() and the internal config object must keep the real
 * key (providers depend on it for routing) — masking is display-only, at
 * the CLI command layer.
 */
import { describe, it, expect } from "vitest";
import { maskApiKey, createConfigManager } from "../../src/utils/config.js";

describe("maskApiKey", () => {
  it("fully masks short values", () => {
    expect(maskApiKey("short")).toBe("***");
  });

  it("keeps a short prefix and last 4 chars of longer values", () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-...mnop");
  });

  it("returns an empty string for undefined", () => {
    expect(maskApiKey(undefined)).toBe("");
  });
});

describe("getDefaultConfig — provider list completeness", () => {
  it("includes a default entry for huggingface (previously missing entirely, despite being a first-class ProviderType with its own documented env var)", () => {
    const manager = createConfigManager(process.cwd());
    const config = manager.get();
    expect(config.providers.some((p) => p.type === "huggingface")).toBe(true);
  });

  it("deliberately omits ollama-cloud (no sensible default baseUrl — it points at a user-provided endpoint)", () => {
    const manager = createConfigManager(process.cwd());
    const config = manager.get();
    expect(config.providers.some((p) => p.type === "ollama-cloud")).toBe(false);
  });
});

describe("Config get masks apiKey, storage stays real", () => {
  it("keeps the real apiKey in the internal config object used for provider routing", () => {
    const manager = createConfigManager(process.cwd());
    const config = manager.get();
    const groqIndex = config.providers.findIndex((p) => p.type === "groq");
    expect(groqIndex).toBeGreaterThanOrEqual(0);

    manager.setConfigValue(`providers.${groqIndex}.apiKey`, "gsk_realkeyvalue1234");
    expect(manager.getConfigValue(`providers.${groqIndex}.apiKey`)).toBe(
      "gsk_realkeyvalue1234",
    );
  });
});
