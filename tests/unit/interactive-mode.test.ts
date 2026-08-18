/**
 * Tests for InteractiveMode (cli/modes/interactive.ts) — the REPL loop,
 * previously ZERO test coverage despite being the largest, most complex
 * user-facing surface in the CLI (929 lines). Auditing it surfaced three
 * real bugs, all fixed this phase:
 *
 *   1. configGet() (the /config get <key> command) never masked API keys
 *      — a completely separate implementation from cli/commands/config.ts's
 *      get(), which WAS fixed for this in an earlier phase (Phase 2, C1).
 *      Confirmed live: `/config get providers.0.apiKey` printed a real,
 *      unmasked key straight to the terminal.
 *   2. `/config set <key>` with no value argument silently proceeded with
 *      value="" (args.slice(2).join(" ") on nothing is "", not undefined,
 *      so the `value === undefined` guard never caught it) — and
 *      configSet()'s own numeric coercion turns "" into the NUMBER 0
 *      (Number("") === 0), silently corrupting the config key instead of
 *      showing a usage message.
 *   3. start() called initializeSystems() unguarded — an invalid
 *      coding-agent.json/config.yaml (fails Zod validation in
 *      ConfigManager.load()) crashed interactive mode with a raw,
 *      unhandled stack trace before the user ever saw the prompt.
 *
 * Private methods are accessed via bracket-index casts, matching the
 * pattern already established elsewhere in this test suite (e.g.
 * tests/unit/agents.test.ts's access to UniversalAgent's private state).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InteractiveMode } from "../../src/cli/modes/interactive.js";
import { createConfigManager, getConfigManager } from "../../src/utils/config.js";
import {
  getMemoryManager,
  resetMemoryManager,
} from "../../src/memory/MemoryManager.js";
import {
  getRollbackManager,
  resetRollbackManager,
} from "../../src/utils/git-rollback.js";
import type { AgentType } from "../../src/utils/types.js";

// Cast wrapper so private-method access reads cleanly at each call site.
function priv(mode: InteractiveMode): any {
  return mode as unknown as Record<string, any>;
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = original;
    },
  };
}

describe("InteractiveMode — configGet() API key masking (security fix)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    writeFileSync(
      join(dir, "coding-agent.json"),
      JSON.stringify({
        providers: [
          { type: "openai", apiKey: "sk-REALSECRETKEY1234567890", models: {}, enabled: true },
        ],
      }),
    );
    createConfigManager(dir);
  });

  it("masks a real API key instead of printing it raw", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).configGet("providers.0.apiKey");
    restore();

    const joined = logs.join("\n");
    expect(joined).not.toContain("REALSECRETKEY1234567890");
    // maskApiKey() only produces literal "***" for keys <= 8 chars; a
    // longer key like this one masks as "sk-...7890" — the security
    // property that matters is the raw secret never appearing, not one
    // specific mask format (see the short-key test below for "***").
    expect(joined).toContain("...");
  });

  it("does not mask a non-apiKey config value", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).configGet("providers.0.type");
    restore();

    expect(logs.join("\n")).toContain("openai");
  });

  it("does not mask a key merely ending near, but not exactly at, 'apiKey'", () => {
    // getConfigValue for a nonexistent path returns undefined — this just
    // confirms the endsWith("apiKey") check doesn't accidentally fire on
    // a totally unrelated missing key.
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).configGet("providers.0.apiKeyBackupNote");
    restore();

    expect(logs.join("\n")).toContain("not found");
  });

  it("shows 'not found' for a nonexistent key, not a masked empty value", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).configGet("does.not.exist");
    restore();

    expect(logs.join("\n")).toContain("not found");
  });

  it("handles masking a short key gracefully (maskApiKey's own short-key path)", () => {
    createConfigManager(dir);
    getConfigManager().setConfigValue("providers.0.apiKey", "sk1");
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).configGet("providers.0.apiKey");
    restore();

    expect(logs.join("\n")).not.toContain("sk1");
  });
});

describe("InteractiveMode — showConfig() never leaks apiKey", () => {
  it("does not print the raw apiKey anywhere in the full config listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      writeFileSync(
        join(dir, "coding-agent.json"),
        JSON.stringify({
          providers: [
            { type: "openai", apiKey: "sk-SHOULD-NEVER-APPEAR", models: {}, enabled: true },
          ],
        }),
      );
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { logs, restore } = captureConsole();
      priv(mode).showConfig();
      restore();

      expect(logs.join("\n")).not.toContain("SHOULD-NEVER-APPEAR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("InteractiveMode — /config set empty-value bug", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    writeFileSync(
      join(dir, "coding-agent.json"),
      JSON.stringify({ defaults: { preferLocal: true } }),
    );
    createConfigManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a usage error instead of corrupting the value when no value is given", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).handleConfigCommand(["set", "defaults.preferLocal"]);
    restore();

    expect(logs.join("\n")).toContain("Usage: /config set");
    expect(getConfigManager().getConfigValue("defaults.preferLocal")).toBe(true);
  });

  it("shows a usage error when neither key nor value is given", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).handleConfigCommand(["set"]);
    restore();
    expect(logs.join("\n")).toContain("Usage: /config set");
  });

  it("does not corrupt an unrelated key when the target value is missing", () => {
    const mode = new InteractiveMode();
    priv(mode).handleConfigCommand(["set", "defaults.preferLocal"]);
    expect(getConfigManager().getConfigValue("defaults.preferLocal")).not.toBe(0);
  });

  it("still correctly sets a real boolean value", () => {
    const mode = new InteractiveMode();
    priv(mode).handleConfigCommand(["set", "defaults.preferLocal", "false"]);
    expect(getConfigManager().getConfigValue("defaults.preferLocal")).toBe(false);
  });

  it("still correctly sets a real numeric value, including the literal '0'", () => {
    const mode = new InteractiveMode();
    priv(mode).handleConfigCommand(["set", "defaults.maxParallelAgents", "0"]);
    expect(getConfigManager().getConfigValue("defaults.maxParallelAgents")).toBe(0);
  });

  it("still correctly sets a real string value", () => {
    const mode = new InteractiveMode();
    priv(mode).handleConfigCommand(["set", "defaults.someTextField", "hello"]);
    expect(getConfigManager().getConfigValue("defaults.someTextField")).toBe("hello");
  });

  it("still correctly joins a multi-word value into a single string", () => {
    const mode = new InteractiveMode();
    priv(mode).handleConfigCommand(["set", "defaults.someTextField", "hello", "world"]);
    expect(getConfigManager().getConfigValue("defaults.someTextField")).toBe("hello world");
  });
});

describe("InteractiveMode — start() resilience to a bad config (crash fix)", () => {
  it("does not throw when ConfigManager.load() fails validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      writeFileSync(
        join(dir, "coding-agent.json"),
        JSON.stringify({ providers: "this-should-be-an-array-not-a-string" }),
      );
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { restore } = captureConsole();
      await expect(mode.start()).resolves.not.toThrow();
      restore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a clean, specific error message rather than a raw stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      writeFileSync(
        join(dir, "coding-agent.json"),
        JSON.stringify({ providers: "not-an-array" }),
      );
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { logs, restore } = captureConsole();
      await mode.start();
      restore();

      expect(logs.join("\n")).toContain("Failed to start interactive mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never enters the input loop after a failed initialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      writeFileSync(
        join(dir, "coding-agent.json"),
        JSON.stringify({ providers: "not-an-array" }),
      );
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { restore } = captureConsole();
      await mode.start();
      restore();

      // running must not have been left true (would spin the REPL loop
      // forever waiting on stdin in a non-interactive test process).
      expect(priv(mode).running).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("InteractiveMode — autoDetectMode()", () => {
  const mode = new InteractiveMode();

  const cases: Array<[string, AgentType]> = [
    ["fix this broken exception", "debug"],
    ["the API returns 500 on login", "debug"],
    ["this is null and I don't know why", "debug"],
    ["write unit tests for the parser", "test"],
    ["add jest coverage for this module", "test"],
    ["audit this module for best practices", "review"],
    ["refactor this for readability", "review"],
    ["plan the architecture for this feature", "plan"],
    ["break down this roadmap into steps", "plan"],
    ["create a simple hello world function", "code"],
  ];

  for (const [input, expected] of cases) {
    it(`classifies "${input}" as ${expected}`, () => {
      expect(priv(mode).autoDetectMode(input)).toBe(expected);
    });
  }

  it("is case-insensitive", () => {
    expect(priv(mode).autoDetectMode("FIX THIS BROKEN EXCEPTION")).toBe("debug");
  });

  it("prioritizes debug keywords over test keywords when both are present", () => {
    // Debug is checked first in autoDetectMode's if-chain.
    expect(priv(mode).autoDetectMode("the test is broken and failing")).toBe("debug");
  });

  it("prioritizes test keywords over review keywords when both are present", () => {
    expect(priv(mode).autoDetectMode("write a test to check for quality")).toBe("test");
  });

  // Documents existing behavior, not a regression: debugKeywords includes
  // very generic words ("issue", "problem", "wrong") that are also normal
  // vocabulary for a review request ("security issues", "performance
  // problems"). Because debug is checked first, natural review-phrasing
  // that happens to use these words gets classified as debug instead.
  // Redesigning the keyword-priority heuristic to disambiguate this is a
  // separate, much larger change than this phase's bug-fix scope — this
  // test exists so a future change to the priority order does so
  // deliberately, not by accident.
  it("known limitation: 'security issues'/'performance problems' phrasing loses to debug's generic keywords", () => {
    expect(priv(mode).autoDetectMode("review this code for security issues")).toBe("debug");
    expect(priv(mode).autoDetectMode("audit this for performance problems")).toBe("debug");
  });

  it("falls back to 'code' for an unrelated description", () => {
    expect(priv(mode).autoDetectMode("hello there")).toBe("code");
  });

  it("falls back to 'code' for an empty string", () => {
    expect(priv(mode).autoDetectMode("")).toBe("code");
  });
});

describe("InteractiveMode — getAgentType() / setMode()", () => {
  it("maps each CLIMode to the correct AgentType", () => {
    const mode = new InteractiveMode();
    const expectations: Array<["auto" | "plan" | "debug" | "test" | "review" | "code", AgentType]> = [
      ["plan", "plan"],
      ["debug", "debug"],
      ["test", "test"],
      ["review", "review"],
      ["code", "code"],
    ];
    for (const [cliMode, expected] of expectations) {
      priv(mode).currentMode = cliMode;
      expect(priv(mode).getAgentType()).toBe(expected);
    }
  });

  it("'auto' maps to 'code' as getAgentType()'s literal fallback (not actually used when currentMode is auto)", () => {
    const mode = new InteractiveMode();
    priv(mode).currentMode = "auto";
    expect(priv(mode).getAgentType()).toBe("code");
  });

  it("setMode() updates currentMode", () => {
    const mode = new InteractiveMode();
    priv(mode).setMode("debug");
    expect(priv(mode).currentMode).toBe("debug");
  });

  it("getModeDisplay() shows 'Auto-detect' for auto mode", () => {
    const mode = new InteractiveMode();
    priv(mode).currentMode = "auto";
    expect(priv(mode).getModeDisplay()).toBe("Auto-detect");
  });

  it("getModeDisplay() shows the uppercased mode name otherwise", () => {
    const mode = new InteractiveMode();
    priv(mode).currentMode = "debug";
    expect(priv(mode).getModeDisplay()).toBe("DEBUG");
  });
});

describe("InteractiveMode — handleCommand() dispatch and aliases", () => {
  it("recognizes each mode command and its alias identically", async () => {
    const pairs: Array<[string, string, "code" | "plan" | "debug" | "test" | "review"]> = [
      ["/run", "/r", "code"],
      ["/plan", "/p", "plan"],
      ["/debug", "/d", "debug"],
      ["/test", "/t", "test"],
    ];
    for (const [full, alias, expected] of pairs) {
      const modeA = new InteractiveMode();
      const modeB = new InteractiveMode();
      const capA = captureConsole();
      await priv(modeA).handleCommand(full);
      capA.restore();
      const capB = captureConsole();
      await priv(modeB).handleCommand(alias);
      capB.restore();

      expect(priv(modeA).currentMode).toBe(expected);
      expect(priv(modeB).currentMode).toBe(expected);
    }
  });

  it("is case-insensitive for command names", async () => {
    const mode = new InteractiveMode();
    const { restore } = captureConsole();
    await priv(mode).handleCommand("/DEBUG");
    restore();
    expect(priv(mode).currentMode).toBe("debug");
  });

  it("shows an 'unknown command' message for an unrecognized command", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleCommand("/totallynotarealcommand");
    restore();
    expect(logs.join("\n")).toContain("Unknown command");
  });

  it("/exit throws the sentinel EXIT error and sets running to false", async () => {
    const mode = new InteractiveMode();
    priv(mode).running = true;
    await expect(priv(mode).handleCommand("/exit")).rejects.toThrow("EXIT");
    expect(priv(mode).running).toBe(false);
  });

  it("/quit and /q behave identically to /exit", async () => {
    for (const cmd of ["/quit", "/q"]) {
      const mode = new InteractiveMode();
      priv(mode).running = true;
      await expect(priv(mode).handleCommand(cmd)).rejects.toThrow("EXIT");
      expect(priv(mode).running).toBe(false);
    }
  });

  it("/auto switches currentMode to 'auto'", async () => {
    const mode = new InteractiveMode();
    priv(mode).currentMode = "debug";
    const { restore } = captureConsole();
    await priv(mode).handleCommand("/auto");
    restore();
    expect(priv(mode).currentMode).toBe("auto");
  });
});

describe("InteractiveMode — /remember and /forget", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    resetMemoryManager();
    getMemoryManager({
      project: { rootDir: dir },
      sqlite: { path: join(dir, ".claude", "memory.db") },
    });
  });

  afterEach(() => {
    resetMemoryManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a usage message for /remember with no fact", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleRemember([]);
    restore();
    expect(logs.join("\n")).toContain("Usage: /remember");
  });

  it("remembers a real fact and confirms it", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleRemember(["I", "prefer", "tabs"]);
    restore();
    expect(logs.join("\n")).toContain("Remembered");

    const stored = await getMemoryManager().query({ scope: "user" });
    expect(stored.some((s) => s.entry.content.includes("I prefer tabs"))).toBe(true);
  });

  it("shows a usage message for /forget with no fact", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleForget([]);
    restore();
    expect(logs.join("\n")).toContain("Usage: /forget");
  });

  it("forgets a previously-remembered fact", async () => {
    const mode = new InteractiveMode();
    await getMemoryManager().remember("I prefer spaces");
    const { logs, restore } = captureConsole();
    await priv(mode).handleForget(["I", "prefer", "spaces"]);
    restore();
    expect(logs.join("\n")).toContain("Forgot");
  });

  it("reports no match for forgetting a fact that was never remembered", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleForget(["never", "said", "this"]);
    restore();
    expect(logs.join("\n")).toContain("No matching memory found");
  });
});

describe("InteractiveMode — /undo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    resetRollbackManager();
    getRollbackManager(dir);
  });

  afterEach(() => {
    resetRollbackManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows 'no recoverable backups' when nothing has been backed up", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleUndo([]);
    restore();
    expect(logs.join("\n")).toContain("No recoverable backups");
  });

  it("lists a backed-up file when no path argument is given", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "v1");
    getRollbackManager().snapshot(target);
    writeFileSync(target, "v2");

    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleUndo([]);
    restore();
    expect(logs.join("\n")).toContain(target);
  });

  it("reports no backup found for a path that was never touched", async () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleUndo([join(dir, "never.txt")]);
    restore();
    expect(logs.join("\n")).toContain("No backup found");
  });

  it("restores a real file from its backup", async () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "original");
    getRollbackManager().snapshot(target);
    writeFileSync(target, "corrupted");

    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    await priv(mode).handleUndo([target]);
    restore();

    expect(logs.join("\n")).toContain("Restored");
    expect(existsSync(target)).toBe(true);
  });
});

describe("InteractiveMode — misc", () => {
  it("constructor assigns a unique sessionId per instance", () => {
    const a = new InteractiveMode();
    const b = new InteractiveMode();
    expect(priv(a).sessionId).not.toBe(priv(b).sessionId);
  });

  it("stop() sets running to false", () => {
    const mode = new InteractiveMode();
    priv(mode).running = true;
    mode.stop();
    expect(priv(mode).running).toBe(false);
  });

  it("showHistory() reports 'no commands yet' for a fresh session", () => {
    const mode = new InteractiveMode();
    const { logs, restore } = captureConsole();
    priv(mode).showHistory();
    restore();
    expect(logs.join("\n")).toContain("No commands yet");
  });

  it("handleConfigCommand() defaults to showConfig() for an unrecognized subcommand", () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { logs, restore } = captureConsole();
      priv(mode).handleConfigCommand(["bogus-subcommand"]);
      restore();
      expect(logs.join("\n")).toContain("Unknown config command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handleConfigCommand() with no subcommand shows the full config", () => {
    const dir = mkdtempSync(join(tmpdir(), "interactive-test-"));
    try {
      createConfigManager(dir);
      const mode = new InteractiveMode();
      const { logs, restore } = captureConsole();
      priv(mode).handleConfigCommand([]);
      restore();
      expect(logs.join("\n")).toContain("Current Configuration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
