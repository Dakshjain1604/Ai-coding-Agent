import { describe, it, expect } from "vitest";
import { getProviderFactory } from "../../src/providers/ProviderFactory.js";
import { ModelRouter } from "../../src/providers/ModelRouter.ts";
import { OpenAIProvider } from "../../src/providers/OpenAIProvider.js";

describe("Provider Factory & Model Router", () => {
  it("ProviderFactory initializes with defaults", () => {
    const factory = getProviderFactory();
    expect(factory).toBeDefined();
  });

  it("ModelRouter resolves default model for category", () => {
    const router = new ModelRouter();
    const model = router.getDefaultModelForCategory("openai", "code");
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  it("OpenAIProvider isAvailable returns boolean without crashing", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const available = await provider.isAvailable();
    expect(typeof available).toBe("boolean");
  });

  // Regression test for the Wiring Audit's "local-first" routing bug:
  // DEFAULT_RULES used to be a static, module-level table that always
  // pointed at openrouter, regardless of the `preferLocal` config passed
  // to the router's constructor. Verifies the fix without needing a real
  // Ollama server — this checks which default rule is *selected*, not
  // whether the provider actually responds.
  it("selects local-first default rules when preferLocal is true", () => {
    const router = new ModelRouter({ preferLocal: true });
    const rules = (router as unknown as { defaultRules: Array<{ taskCategory: string; provider: string }> })
      .defaultRules;
    const codeRule = rules.find((r) => r.taskCategory === "code");
    expect(codeRule?.provider).toBe("local");
  });

  it("selects cloud-first default rules when preferLocal is false", () => {
    const router = new ModelRouter({ preferLocal: false });
    const rules = (router as unknown as { defaultRules: Array<{ taskCategory: string; provider: string }> })
      .defaultRules;
    const codeRule = rules.find((r) => r.taskCategory === "code");
    expect(codeRule?.provider).toBe("openrouter");
  });
});
