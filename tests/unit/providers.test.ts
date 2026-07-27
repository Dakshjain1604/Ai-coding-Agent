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
});
