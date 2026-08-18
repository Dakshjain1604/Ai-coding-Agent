/**
 * True end-to-end integration tests for the spawn_subagent / ParallelOrchestrator
 * sub-agent-spawning subsystem — driven through UniversalAgent.execute()'s
 * REAL tool-call parsing and provider-routing chain (the FakeProvider
 * harness), not by calling ParallelOrchestrator/subagent-tool directly the
 * way tests/unit/subagent.test.ts and tests/unit/subagent-tool.test.ts do.
 *
 * This is the regression suite for the mode-leak bug (a parent's own
 * task.metadata.mode silently overriding a subtask's intended mode) going
 * through actual LLM-response parsing end to end, plus real depth-limiting
 * and tool-narrowing behavior for a genuinely spawned child agent.
 */
import { describe, it, expect, afterEach } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import {
  pushSubagentContext,
  popSubagentContext,
} from "../../src/core/agents/subagent-context.js";
import { spawnSubagentTool } from "../../src/core/tools/subagent-tool.js";
import type { Task } from "../../src/utils/types.js";
import {
  setupFakeAgentEnv,
  scriptedResult,
  scriptedError,
  type FakeAgentEnv,
} from "../helpers/agent-test-harness.js";

function messagesText(messages: Array<{ content: string | unknown }>): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

function makeTask(description: string, metadata?: Record<string, unknown>): Task {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    description,
    complexity: "simple",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata,
  };
}

describe("spawn_subagent end-to-end (real tool-call parsing + provider chain)", () => {
  let env: FakeAgentEnv;

  afterEach(() => {
    env?.cleanup();
  });

  it("resolves a spawned subtask's own mode, not the parent task's metadata.mode (mode-leak regression)", async () => {
    // Parent task carries metadata.mode: "code" — exactly the shape a CLI
    // --mode flag produces. Before the fix, ParallelOrchestrator spread
    // this into every subtask's metadata verbatim, and UniversalAgent's
    // "task.metadata.mode always wins" rule then silently forced every
    // subtask into "code" mode regardless of what the parent asked for.
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({
          tool: "spawn_subagent",
          params: {
            subtasks: [{ mode: "test", description: "run the test suite" }],
          },
        }),
      ),
      scriptedResult("All tests passed."), // child's turn (test mode)
      scriptedResult("Done — tests were run by the sub-agent."), // parent's final turn
    ]);

    const agent = new UniversalAgent();
    const result = await agent.execute(
      makeTask("delegate: run the tests", { mode: "code" }),
    );

    expect(result.success).toBe(true);

    // Proves a real "test"-mode agent actually ran: SYSTEM_PROMPTS.test's
    // distinguishing text appears in one of the calls' system message.
    // (The parent itself legitimately runs in "code" mode per its own
    // metadata, so "expert coding assistant" is expected to appear too —
    // the regression this guards is the CHILD silently also running in
    // "code" instead of the "test" mode its subtask plan specified.)
    const allCallsText = env.provider.calls.map(messagesText).join("\n---\n");
    expect(allCallsText).toContain("expert test engineer");
  });

  it("narrows a real spawned child's tools — a tool call for a restricted tool never executes", async () => {
    // The child runs in "code" mode, which normally DOES include
    // shell_exec — but CHILD_RESTRICTED_TOOLS always strips shell_exec
    // (and spawn_subagent) from any spawned child regardless of its mode.
    // If the model still asks for it, the parser's own known-tool gate
    // (built from the child's actual registered tools) must silently drop
    // the call rather than executing it.
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({
          tool: "spawn_subagent",
          params: {
            subtasks: [{ mode: "code", description: "try to run a shell command" }],
          },
        }),
      ),
      scriptedResult(
        JSON.stringify({ tool: "shell_exec", params: { command: "echo hi" } }),
      ), // child's turn: asks for a restricted tool
      scriptedResult("Never mind, done."), // child's next turn (no tool calls filtered out)
      scriptedResult("Sub-agent finished."), // parent's final turn
    ]);

    const agent = new UniversalAgent();
    const result = await agent.execute(makeTask("delegate: run a shell command"));

    expect(result.success).toBe(true);
    // The shell_exec call must never have reached executeTool() — no
    // "```result" block naming shell_exec anywhere in the whole exchange.
    const allCallsText = env.provider.calls.map(messagesText).join("\n---\n");
    expect(allCallsText).not.toMatch(/```result\nshell_exec/);
  });

  it("stops a multi-subtask pipeline at the first failure — later subtasks never run", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({
          tool: "spawn_subagent",
          params: {
            subtasks: [
              { mode: "code", description: "first subtask" },
              { mode: "code", description: "second subtask" },
            ],
          },
        }),
      ),
      // Non-retryable, no-fallback-configured error — the first child
      // fails immediately and definitively.
      scriptedError("413 Request too large for model"),
      scriptedResult("Stopping since the first subtask failed."), // parent's next turn
    ]);

    const agent = new UniversalAgent();
    const result = await agent.execute(makeTask("delegate: do two things"));

    // Exactly 3 provider calls total: parent's spawn decision, the first
    // (failing) child's one and only call, parent's follow-up turn. A
    // fourth call would mean the second subtask ran anyway.
    expect(env.provider.calls.length).toBe(3);

    const allCallsText = env.provider.calls.map(messagesText).join("\n---\n");
    expect(allCallsText).toContain("Subtask 1 FAILED");
    expect(allCallsText).not.toContain("Subtask 2");
    expect(result.success).toBe(true);
  });

  it("executes a full two-subtask pipeline sequentially when both succeed", async () => {
    env = setupFakeAgentEnv([
      scriptedResult(
        JSON.stringify({
          tool: "spawn_subagent",
          params: {
            subtasks: [
              { mode: "code", description: "first subtask" },
              { mode: "test", description: "second subtask" },
            ],
          },
        }),
      ),
      scriptedResult("First subtask done."), // child 1 (code mode)
      scriptedResult("Second subtask done."), // child 2 (test mode)
      scriptedResult("Both subtasks complete."), // parent's final turn
    ]);

    const agent = new UniversalAgent();
    const result = await agent.execute(makeTask("delegate: do two things"));

    expect(result.success).toBe(true);
    const allCallsText = env.provider.calls.map(messagesText).join("\n---\n");
    expect(allCallsText).toContain("Subtask 1 PASSED");
    expect(allCallsText).toContain("Subtask 2 PASSED");
  });

  it("real depth-limit guard refuses a spawn attempt already at max nesting depth", async () => {
    // Realistic model behavior can never actually reach this via the tool-
    // call path (children never have spawn_subagent registered at all —
    // see the tool-narrowing test above), so this exercises the guard
    // directly through the real handler as the defense-in-depth check it
    // is: simulate two agents already being on the call stack (as if a
    // grandchild were somehow asking to spawn a great-grandchild) and
    // confirm the real spawn_subagent handler — not ParallelOrchestrator
    // called directly — refuses rather than proceeding.
    const outerTask = makeTask("outer");
    const innerTask = makeTask("inner");
    pushSubagentContext({ parentTask: outerTask, parentToolNames: [] });
    pushSubagentContext({ parentTask: innerTask, parentToolNames: [] });
    try {
      const result = (await spawnSubagentTool.handler({
        subtasks: [{ mode: "code", description: "one more level" }],
      })) as { success: boolean; output: string };

      expect(result.success).toBe(false);
      expect(result.output).toContain("depth limit");
    } finally {
      popSubagentContext();
      popSubagentContext();
    }
  });
});
