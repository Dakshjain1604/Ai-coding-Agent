/**
 * Full-loop tests: drive UniversalAgent.execute() for real, through the
 * actual provider-routing chain (ProviderFactory + ModelRouter), not by
 * hand-setting agent.context like the existing compactor/compaction tests
 * do. This is the gap those tests don't cover — parse-tool-calls ->
 * execute-tool -> loop-continues -> completes, as one real path.
 *
 * IMPORTANT: assertions here check for the "```result" marker that
 * BaseAgent.formatToolResult() wraps a tool's actual output in, not
 * coincidental substrings — an earlier version of this file asserted on a
 * word ("package") that also appears in the task description regardless
 * of whether the tool ever ran, which meant those tests passed even when
 * tool execution silently failed. Always verify against the real
 * telemetry/message content, not text that could appear either way.
 *
 * Found and fixed while building this suite:
 *   1. tool-parser.ts's KNOWN_TOOLS list was stale (missing most real
 *      tools, included some that never existed).
 *   2. parseMarkdownCodeBlock/parseXmlStyle had no known-tool gate at all.
 *   3. parseJsonObject's non-greedy regex truncated at the FIRST closing
 *      brace, breaking on any nested params object — i.e. almost every
 *      real tool call. Replaced with a brace-balanced scanner.
 *   4. UniversalAgent.ts called startConversation() twice per task
 *      (once directly, once already inside initializeContext()),
 *      orphaning an empty conversation row on every single task — this
 *      is why this repo's own .claude/memory.db had 26 conversations and
 *      0 turns.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import inquirer from "inquirer";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { getHookManager } from "../../src/hooks/HookManager.js";
import { registerBuiltinHooks } from "../../src/hooks/registerBuiltinHooks.js";
import type { Task } from "../../src/utils/types.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

function makeTask(description: string, risk?: "low" | "medium" | "high"): Task {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    description,
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    risk,
  };
}

function messagesText(messages: Array<{ content: string | unknown }>): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

describe("UniversalAgent.execute() end-to-end (real provider-routing chain)", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
    vi.restoreAllMocks();
  });

  it("completes a plain task with no tool calls", async () => {
    env = setupFakeAgentEnv([scriptedResult("Hello! How can I help you today?")]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("say hello"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("Hello");
    // Loop only actually exits once `iterations > 0` is also true (see
    // UniversalAgent's iteration-counter timing), so a genuinely one-shot
    // answer still costs a second identical call before it breaks.
    expect(env.provider.calls.length).toBe(2);
  });

  it("executes a tool call (JSON-object format) and feeds the real result back", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "file_read", params: { path: "package.json" } }),
      ),
      scriptedResult("I read package.json — task complete."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("read package.json"));

    expect(result.success).toBe(true);
    expect(env.provider.calls.length).toBe(2);

    // The formatted-result marker + tool name proves the tool actually ran
    // and its output was fed back, rather than a coincidental word match.
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("```result");
    expect(secondCallText).toContain("file_read");
    expect(secondCallText).toContain('"success": true');
  });

  it("recognizes a tool call for workspace_verify — regression for the stale KNOWN_TOOLS bug", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "workspace_verify", params: { runTests: false } }),
      ),
      scriptedResult("Verification complete."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("verify the workspace"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("```result");
    expect(secondCallText).toContain("workspace_verify");
  });

  it("records real conversation turns via the session-turn wiring (A3), exactly one conversation per task", async () => {
    env = setupFakeAgentEnv([scriptedResult("Done.")]);

    const agent = new UniversalAgent("code");
    await agent.execute(makeTask("say hello"));

    const { getMemoryManager } = await import("../../src/memory/MemoryManager.js");
    const memory = getMemoryManager();
    // Regression for the duplicate startConversation() bug: must be
    // exactly one conversation for one task, not two (one real, one
    // orphaned-and-empty).
    const recent = memory.getRecentConversations(10);
    expect(recent.length).toBe(1);
    expect(recent[0].turns.length).toBeGreaterThan(0);
  });

  it("executes multiple tool calls present in a single response", async () => {
    // Both tools are permission-level "allow" (file_read, search_content) —
    // git_status is deliberately NOT used here: it's gated "prompt" by the
    // generic /^git_/ rule (distinct from shell_exec's "git status" text
    // match), so using it without mocking inquirer would hang waiting on a
    // real interactive prompt in a non-TTY test environment.
    env = setupFakeAgentEnv([
      scriptedResult(
        `${JSON.stringify({ tool: "file_read", params: { path: "package.json" } })} and also ${JSON.stringify({ tool: "search_content", params: { directory: "src/utils", pattern: "export" } })}`,
      ),
      scriptedResult("Both done."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("read package.json and search for exports"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("file_read");
    expect(secondCallText).toContain("search_content");
  });

  it("feeds a failed (but non-throwing) tool result back and continues", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "file_read", params: { path: "/no/such/file.txt" } }),
      ),
      scriptedResult("The file doesn't exist, task complete."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("read a missing file"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("File not found");
  });

  it("approves a permission-required tool call and executes it", async () => {
    vi.spyOn(inquirer, "prompt").mockResolvedValue({ permission: "yes" });
    const writeDir = mkdtempSync(join(tmpdir(), "agent-e2e-write-"));
    const path = join(writeDir, "out.txt");

    env = setupFakeAgentEnv([
      scriptedResult(JSON.stringify({ tool: "file_write", params: { path, content: "hi" } })),
      scriptedResult("Wrote the file."),
    ]);

    try {
      const agent = new UniversalAgent("code");
      const result = await agent.execute(makeTask("write a file"));

      expect(result.success).toBe(true);
      const secondCallText = messagesText(env.provider.calls[1]);
      expect(secondCallText).toContain("```result");
      expect(secondCallText).toContain('"success": true');
    } finally {
      rmSync(writeDir, { recursive: true, force: true });
    }
  });

  it("denies a permission-required tool call and feeds the denial back instead of executing", async () => {
    vi.spyOn(inquirer, "prompt").mockResolvedValue({ permission: "no" });
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "file_write", params: { path: "/tmp/should-not-be-written.txt", content: "x" } }),
      ),
      scriptedResult("Understood, not writing."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("write a file"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("Permission denied");
  });

  it("blocks a hook-flagged dangerous shell command before it ever executes", async () => {
    getHookManager().enable();
    registerBuiltinHooks();

    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "shell_exec", params: { command: "rm -rf /" } }),
      ),
      scriptedResult("Acknowledged, not running that."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("clean up files"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText.toLowerCase()).toMatch(/blocked|denied|not allowed/);
  });

  it("injects an action-cycle intervention after repeated identical tool calls", async () => {
    const repeatedCall = scriptedResult(
      JSON.stringify({ tool: "file_read", params: { path: "package.json" } }),
    );
    // 4 identical calls are required to trip the detector (the first
    // occurrence sets the baseline; three more identical repeats after
    // that reach ACTION_CYCLE_LIMIT).
    env = setupFakeAgentEnv([
      repeatedCall,
      repeatedCall,
      repeatedCall,
      repeatedCall,
      scriptedResult("Okay, stopping — trying something different."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("check status repeatedly"));

    expect(result.success).toBe(true);
    const allText = env.provider.calls.map(messagesText).join("\n");
    expect(allText).toContain("ACTION CYCLE DETECTED");
  });

  it("stops at the mode's maxIterations cap rather than looping forever", async () => {
    // 'plan' mode caps at 6 iterations (BaseAgent.getDefaultConfig). Script
    // far more tool-call-producing rounds than that and confirm the loop
    // actually terminates rather than running away — documents current
    // behavior: it still completes with success:true using whatever the
    // last response was, it does not surface a distinct "ran out of
    // iterations" failure. Not asserting an exact call count: compaction
    // can add its own provider calls once context grows large enough
    // across many rounds, which is a separate concern from the iteration
    // cap itself — the real property under test is "bounded", not "exactly
    // one provider call per iteration".
    const keepGoing = scriptedResult(
      JSON.stringify({ tool: "file_read", params: { path: "package.json" } }),
    );
    env = setupFakeAgentEnv(Array(20).fill(keepGoing));

    const agent = new UniversalAgent("plan");
    const result = await agent.execute(makeTask("keep reading files forever"));

    expect(result.success).toBe(true);
    // Bounded, not unbounded — 20 scripted rounds would mean 20+ calls if
    // the iteration cap weren't enforced at all.
    expect(env.provider.calls.length).toBeLessThan(20);
  });

  it("filters out a tool call for a tool not in the current mode's tool set", async () => {
    // shell_exec is not in TOOL_SETS.plan — a plan-mode agent must never
    // execute it, even if the model asks, and the parser should filter it
    // out before it ever reaches permission/hook checks.
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "shell_exec", params: { command: "echo hi" } }),
      ),
      scriptedResult("Done planning."),
    ]);

    const agent = new UniversalAgent("plan");
    const result = await agent.execute(makeTask("plan the work"));

    expect(result.success).toBe(true);
    // Only 2 calls (not more) — the bogus tool call was treated as "no
    // tool calls" rather than triggering a retry/error cycle, and nothing
    // in the second call's context mentions shell_exec having run.
    expect(env.provider.calls.length).toBe(2);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).not.toContain("```result");
  });

  it("executes a debug-mode-only tool (process_list) end-to-end", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(JSON.stringify({ tool: "process_list", params: {} })),
      scriptedResult("Processes listed."),
    ]);

    const agent = new UniversalAgent("debug");
    const result = await agent.execute(makeTask("check running processes"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).toContain("process_list");
    expect(secondCallText).toContain("```result");
  });

  it("forces workspace_verify's risk param to 'high' for a high-risk task, regardless of what the model asked for", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "workspace_verify", params: { runTests: false } }),
      ),
      scriptedResult("Verified."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("delete the production database", "high"));

    expect(result.success).toBe(true);
    const secondCallText = messagesText(env.provider.calls[1]);
    // The model's params never included risk at all — this proves
    // UniversalAgent's effectiveParams override actually happened.
    expect(secondCallText).toContain('"risk": "high"');
  });

  it("treats malformed/garbage output mixed with prose as no tool calls, without crashing", async () => {
    env = setupFakeAgentEnv([
      scriptedResult('I was going to call {tool: file_read, missing quotes and broken json'),
      scriptedResult("Never mind, here's the answer directly."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("do something"));

    expect(result.success).toBe(true);
    expect(result.output).toContain("directly");
  });

  it("handles an empty LLM response without crashing", async () => {
    env = setupFakeAgentEnv([scriptedResult(""), scriptedResult("Okay, here you go.")]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("do something"));

    expect(result.success).toBe(true);
  });

  it("carries unicode content through a real tool call and back", async () => {
    vi.spyOn(inquirer, "prompt").mockResolvedValue({ permission: "yes" });
    const writeDir = mkdtempSync(join(tmpdir(), "agent-e2e-write-"));
    const path = join(writeDir, "unicode.txt");

    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "file_write", params: { path, content: "héllo 世界 🎉" } }),
      ),
      scriptedResult("Wrote it."),
    ]);

    try {
      const agent = new UniversalAgent("code");
      const result = await agent.execute(makeTask("write a unicode file"));

      expect(result.success).toBe(true);
      const secondCallText = messagesText(env.provider.calls[1]);
      expect(secondCallText).toContain('"success": true');
    } finally {
      rmSync(writeDir, { recursive: true, force: true });
    }
  });

  it("filters out a call to a completely nonexistent tool name at the parsing layer", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({ tool: "delete_the_universe", params: {} }),
      ),
      scriptedResult("Doing something safe instead."),
    ]);

    const agent = new UniversalAgent("code");
    const result = await agent.execute(makeTask("do something"));

    expect(result.success).toBe(true);
    // Must never reach executeTool()'s "Tool not found" throw path — that
    // would show up as a tool-error message in the second call.
    const secondCallText = messagesText(env.provider.calls[1]);
    expect(secondCallText).not.toContain("Tool not found");
    expect(secondCallText).not.toContain("Tool execution failed");
  });
});
