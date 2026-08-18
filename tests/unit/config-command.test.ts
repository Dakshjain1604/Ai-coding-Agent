/**
 * Tests for cli/commands/config.ts — two real, independently-confirmed
 * bugs.
 *
 * 1. formatProviderLines() (extracted from `config list`'s provider loop,
 *    mirroring the shouldExclude()/formatReviewOutput() precedent for
 *    testable CLI logic): config.providers is an array, not a name-keyed
 *    object, but the loop used `Object.entries(config.providers)`, which
 *    on an array yields ["0", provider], ["1", provider]... So `config
 *    list` printed numeric array indices ("0:", "1:") instead of the
 *    actual provider name ("claude:", "groq:"). Confirmed live before
 *    fixing (`node bin/run.js config list` printed "0:"/"1:"/...).
 *
 * 2. `config init` (ConfigCommand.initializeConfig()) used to just print
 *    "Configuration initialized successfully!" without ever writing a
 *    file — `// Create default config files` documented the intent as a
 *    comment, but nothing after it actually did so, despite
 *    ConfigManager.save() already existing and doing exactly this.
 *    Confirmed live: running `config init` in a fresh temp directory
 *    produced no coding-agent.json at all before the fix. Fixed by
 *    actually calling manager.load() + manager.save(). This test
 *    exercises that exact load()+save() sequence directly against
 *    ConfigManager (the CLI command itself has no existing oclif Command
 *    test harness in this repo to hook into).
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatProviderLines } from "../../src/cli/commands/config.js";
import { createConfigManager } from "../../src/utils/config.js";
import type { ProviderConfig } from "../../src/utils/types.js";

describe("formatProviderLines — the array/Object.entries fix", () => {
  it("labels each provider by its type, not its array index", () => {
    const providers = [
      { type: "claude", enabled: true, models: {} },
      { type: "groq", enabled: false, models: {} },
    ] as ProviderConfig[];
    const lines = formatProviderLines(providers);
    expect(lines[0]).toBe("  claude:");
    expect(lines).not.toContain("  0:");
    expect(lines).not.toContain("  1:");
  });

  it("includes an enabled: line for each provider", () => {
    const providers = [{ type: "openai", enabled: true, models: {} }] as ProviderConfig[];
    const lines = formatProviderLines(providers);
    expect(lines).toContain("    enabled: true");
  });

  it("formats models as key=value pairs joined by commas", () => {
    const providers = [
      { type: "ollama", enabled: true, models: { simple: "a", code: "b" } },
    ] as ProviderConfig[];
    const lines = formatProviderLines(providers);
    expect(lines).toContain("    models: simple=a, code=b");
  });

  it("produces an empty models line when a provider has no models", () => {
    const providers = [{ type: "gemini", enabled: true, models: {} }] as ProviderConfig[];
    const lines = formatProviderLines(providers);
    expect(lines).toContain("    models: ");
  });

  it("never emits an apiKey line, even if the provider has one set", () => {
    const providers = [
      { type: "claude", enabled: true, models: {}, apiKey: "sk-secret-value" } as ProviderConfig,
    ];
    const lines = formatProviderLines(providers);
    expect(lines.join("\n")).not.toContain("sk-secret-value");
    expect(lines.join("\n")).not.toContain("apiKey");
  });

  it("returns an empty array for an empty providers list", () => {
    expect(formatProviderLines([])).toEqual([]);
  });

  it("returns an empty array for undefined providers", () => {
    expect(formatProviderLines(undefined)).toEqual([]);
  });

  it("preserves provider order (does not sort or reorder)", () => {
    const providers = [
      { type: "zzz-last", enabled: true, models: {} },
      { type: "aaa-first", enabled: true, models: {} },
    ] as ProviderConfig[];
    const lines = formatProviderLines(providers);
    expect(lines[0]).toBe("  zzz-last:");
  });
});

describe("ConfigManager load()+save() — the `config init` fix", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("actually writes coding-agent.json to a fresh project directory", () => {
    dir = mkdtempSync(join(tmpdir(), "config-init-"));
    const manager = createConfigManager(dir);
    expect(existsSync(join(dir, "coding-agent.json"))).toBe(false);

    manager.load();
    manager.save();

    expect(existsSync(join(dir, "coding-agent.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, "coding-agent.json"), "utf-8"));
    expect(Array.isArray(written.providers)).toBe(true);
    expect(written.providers.length).toBeGreaterThan(0);
  });

  it("preserves an existing project config's values rather than overwriting them with pure defaults", () => {
    dir = mkdtempSync(join(tmpdir(), "config-init-existing-"));
    const first = createConfigManager(dir);
    first.load();
    first.setConfigValue("defaults.maxParallelAgents", 42);
    first.save();

    const second = createConfigManager(dir);
    second.load();
    second.save();

    const written = JSON.parse(readFileSync(join(dir, "coding-agent.json"), "utf-8"));
    expect(written.defaults.maxParallelAgents).toBe(42);
  });
});
