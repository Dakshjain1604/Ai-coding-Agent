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
