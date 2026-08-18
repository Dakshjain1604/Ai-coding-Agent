/**
 * Comprehensive, independently-designed test battery for tool-parser.ts —
 * this module had ZERO test coverage before this pass, despite being the
 * one place that decides whether the agent acts on an LLM's output at all.
 *
 * Cases are written against expected/spec behavior, not retrofitted to
 * whatever the code happened to do — this is what surfaced three real bugs
 * while building it:
 *   1. parseJsonObject/parseToolCallTag gated on a hardcoded, stale
 *      KNOWN_TOOLS list (fixed: threaded the agent's real tool set through).
 *   2. parseMarkdownCodeBlock and parseXmlStyle had NO known-tool gate at
 *      all — an ordinary bare-fenced code block whose first line is a
 *      single word (extremely common in real LLM output) was silently
 *      treated as a tool call for a nonexistent tool. Fixed by gating all
 *      four strategies uniformly.
 *   3. (separate, see tests/e2e/agent-loop.test.ts) a duplicate
 *      startConversation() call orphaned a conversation row per task.
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdownCodeBlock,
  parseJsonObject,
  parseXmlStyle,
  parseToolCallTag,
  parseToolCalls,
} from "../../src/core/agents/tool-parser.js";

const KNOWN = new Set([
  "file_read",
  "file_write",
  "file_delete",
  "shell_exec",
  "git_status",
  "test_run",
  "workspace_verify",
  "search_content",
  "spawn_subagent",
]);

describe("parseMarkdownCodeBlock", () => {
  it("parses a valid ```tool``` block with valid JSON params", () => {
    const calls = parseMarkdownCodeBlock(
      '```tool\nfile_read\n{"path": "x.ts"}\n```',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "x.ts" } }]);
  });

  it("parses a bare fence (no 'tool' tag) with valid JSON params", () => {
    const calls = parseMarkdownCodeBlock(
      '```\nfile_read\n{"path": "x.ts"}\n```',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "x.ts" } }]);
  });

  it("falls back to {input: text} when the body isn't valid JSON", () => {
    const calls = parseMarkdownCodeBlock(
      "```tool\nfile_read\nread this file please\n```",
      KNOWN,
    );
    expect(calls).toEqual([
      { name: "file_read", params: { input: "read this file please" } },
    ]);
  });

  it("filters out an unknown tool name", () => {
    const calls = parseMarkdownCodeBlock(
      '```tool\nnot_a_real_tool\n{"x": 1}\n```',
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("REGRESSION: does not misparse a bare-fenced block whose first line is a plain word as a tool call", () => {
    // This is the exact false-positive shape found while building this
    // suite: a fence with no language tag, first line a single word, next
    // line(s) ordinary text — extremely plausible LLM output (a short
    // note, a one-word heading, pseudo-code) that has nothing to do with
    // tool calling.
    const calls = parseMarkdownCodeBlock(
      "```\nconfig\n{ key: 'value' }\n```",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("REGRESSION: does not misparse a plain pseudo-code snippet in a bare fence", () => {
    const calls = parseMarkdownCodeBlock(
      "```\nretryLogic\nif (x) { return true; }\n```",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("does not match a language-tagged fence glued to the same line (```javascript)", () => {
    // The regex requires a newline between the fence/optional 'tool' tag
    // and the name — a same-line language tag like ```javascript never
    // satisfies that shape, so this never even reaches the known-tool gate.
    const calls = parseMarkdownCodeBlock(
      "```javascript\nfunction foo() { return 1; }\n```",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("returns multiple valid calls from multiple blocks", () => {
    const calls = parseMarkdownCodeBlock(
      '```tool\nfile_read\n{"path": "a.ts"}\n```\nSome text.\n```tool\ngit_status\n{}\n```',
      KNOWN,
    );
    expect(calls).toEqual([
      { name: "file_read", params: { path: "a.ts" } },
      { name: "git_status", params: {} },
    ]);
  });

  it("keeps only the known-tool block when one of two blocks is unknown", () => {
    const calls = parseMarkdownCodeBlock(
      '```tool\nbogus_tool\n{}\n```\n```tool\nfile_read\n{"path": "a.ts"}\n```',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "a.ts" } }]);
  });

  it("returns [] for an output with no code blocks at all", () => {
    expect(parseMarkdownCodeBlock("Just a plain sentence.", KNOWN)).toEqual([]);
  });

  it("handles an empty code block body via the JSON-parse-failure fallback", () => {
    const calls = parseMarkdownCodeBlock("```tool\nfile_read\n\n```", KNOWN);
    expect(calls).toEqual([{ name: "file_read", params: { input: "" } }]);
  });

  it("parses nested JSON structures in params", () => {
    const calls = parseMarkdownCodeBlock(
      '```tool\nfile_write\n{"path": "a.ts", "content": "x", "meta": {"tags": ["a", "b"]}}\n```',
      KNOWN,
    );
    expect(calls[0].params).toEqual({
      path: "a.ts",
      content: "x",
      meta: { tags: ["a", "b"] },
    });
  });

  it("uses the small fallback known-tools list when none is provided", () => {
    // file_read is in FALLBACK_KNOWN_TOOLS; a made-up tool is not.
    expect(
      parseMarkdownCodeBlock('```tool\nfile_read\n{}\n```'),
    ).toEqual([{ name: "file_read", params: {} }]);
    expect(parseMarkdownCodeBlock('```tool\nnot_a_tool\n{}\n```')).toEqual([]);
  });
});

describe("parseJsonObject", () => {
  it('parses {"tool": X, "params": {...}}', () => {
    const calls = parseJsonObject(
      '{"tool": "file_read", "params": {"path": "a.ts"}}',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "a.ts" } }]);
  });

  it('parses the alternate key shape {"name": X, "arguments": {...}}', () => {
    const calls = parseJsonObject(
      '{"name": "git_status", "arguments": {}}',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "git_status", params: {} }]);
  });

  it('parses the alternate key shape {"function": X, "input": {...}}', () => {
    const calls = parseJsonObject(
      '{"function": "test_run", "input": {"coverage": true}}',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "test_run", params: { coverage: true } }]);
  });

  it("filters out an unknown tool name", () => {
    const calls = parseJsonObject('{"tool": "delete_everything", "params": {}}', KNOWN);
    expect(calls).toEqual([]);
  });

  it("does not crash on malformed JSON and returns []", () => {
    expect(() => parseJsonObject('{"tool": "file_read", "params": {', KNOWN)).not.toThrow();
    expect(parseJsonObject('{"tool": "file_read", "params": {', KNOWN)).toEqual([]);
  });

  it("finds the one valid known-tool call among unrelated JSON-shaped prose", () => {
    const calls = parseJsonObject(
      'The config looks like {"env": "prod", "debug": false}. Now calling: {"tool": "file_read", "params": {"path": "x"}}',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "x" } }]);
  });

  it("defaults params to {} when no params/arguments/input key is present", () => {
    const calls = parseJsonObject('{"tool": "git_status"}', KNOWN);
    expect(calls).toEqual([{ name: "git_status", params: {} }]);
  });

  it("rejects a non-string name value", () => {
    const calls = parseJsonObject('{"tool": 123, "params": {}}', KNOWN);
    expect(calls).toEqual([]);
  });

  it("does not false-positive on ordinary prose containing braces", () => {
    const calls = parseJsonObject(
      "Check the {config} setting and the {environment} variable.",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("returns multiple calls when multiple valid JSON tool objects are present", () => {
    const calls = parseJsonObject(
      '{"tool": "file_read", "params": {"path": "a"}} then {"tool": "git_status", "params": {}}',
      KNOWN,
    );
    expect(calls).toEqual([
      { name: "file_read", params: { path: "a" } },
      { name: "git_status", params: {} },
    ]);
  });
});

describe("parseXmlStyle", () => {
  it("parses a valid <tool name=...><params>...</params></tool> block", () => {
    const calls = parseXmlStyle(
      '<tool name="file_read"><params>{"path": "a.ts"}</params></tool>',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "a.ts" } }]);
  });

  it("accepts single-quoted name attributes", () => {
    const calls = parseXmlStyle(
      "<tool name='git_status'><params>{}</params></tool>",
      KNOWN,
    );
    expect(calls).toEqual([{ name: "git_status", params: {} }]);
  });

  it("filters out an unknown tool name", () => {
    const calls = parseXmlStyle(
      '<tool name="rm_everything"><params>{}</params></tool>',
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("falls back to {} when params content isn't valid JSON", () => {
    const calls = parseXmlStyle(
      "<tool name=\"file_read\"><params>not json</params></tool>",
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: {} }]);
  });

  it("tolerates extra attributes on the tag", () => {
    const calls = parseXmlStyle(
      '<tool name="file_read" id="42"><params>{"path": "a"}</params></tool>',
      KNOWN,
    );
    expect(calls).toEqual([{ name: "file_read", params: { path: "a" } }]);
  });

  it("returns multiple calls from multiple tags", () => {
    const calls = parseXmlStyle(
      '<tool name="file_read"><params>{}</params></tool><tool name="git_status"><params>{}</params></tool>',
      KNOWN,
    );
    expect(calls.map((c) => c.name)).toEqual(["file_read", "git_status"]);
  });

  it("returns [] when there are no <tool> tags", () => {
    expect(parseXmlStyle("no xml here at all", KNOWN)).toEqual([]);
  });
});

describe("parseToolCallTag", () => {
  it("parses a valid single function+parameter block", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=shell_exec>\n<parameter=command>npm init -y</parameter>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls).toEqual([
      { name: "shell_exec", params: { command: "npm init -y" } },
    ]);
  });

  it("parses multiple parameters in one function call", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=file_write>\n<parameter=path>a.ts</parameter>\n<parameter=content>hello</parameter>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls).toEqual([
      { name: "file_write", params: { path: "a.ts", content: "hello" } },
    ]);
  });

  it("filters out an unknown function name", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=hack_the_planet>\n<parameter=x>1</parameter>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("skips a block missing the <function=...> tag entirely", () => {
    const calls = parseToolCallTag(
      "<tool_call>\nno function tag here\n</tool_call>",
      KNOWN,
    );
    expect(calls).toEqual([]);
  });

  it("parses a JSON-shaped parameter value as its real type, not a string", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=test_run>\n<parameter=coverage>true</parameter>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls[0].params.coverage).toBe(true);
  });

  it("keeps a non-JSON parameter value as a plain string", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=shell_exec>\n<parameter=command>echo hi</parameter>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls[0].params.command).toBe("echo hi");
  });

  it("returns multiple calls from multiple <tool_call> blocks", () => {
    const calls = parseToolCallTag(
      "<tool_call>\n<function=file_read>\n<parameter=path>a</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=git_status>\n</function>\n</tool_call>",
      KNOWN,
    );
    expect(calls.map((c) => c.name)).toEqual(["file_read", "git_status"]);
  });

  it("returns [] for an empty <tool_call></tool_call> block", () => {
    expect(parseToolCallTag("<tool_call></tool_call>", KNOWN)).toEqual([]);
  });
});

describe("parseToolCalls (master, strategy precedence)", () => {
  it("prefers strategy 1 (markdown block) when it yields a result", () => {
    const output =
      '```tool\nfile_read\n{"path": "a"}\n```\n{"tool": "git_status", "params": {}}';
    const calls = parseToolCalls(output, KNOWN);
    expect(calls).toEqual([{ name: "file_read", params: { path: "a" } }]);
  });

  it("falls through to strategy 2 when strategy 1 finds nothing usable (unknown tool filtered)", () => {
    const output =
      '```tool\nnot_a_real_tool\n{}\n```\n{"tool": "git_status", "params": {}}';
    const calls = parseToolCalls(output, KNOWN);
    expect(calls).toEqual([{ name: "git_status", params: {} }]);
  });

  it("falls through to strategy 3 when 1 and 2 find nothing", () => {
    const output = '<tool name="file_read"><params>{"path": "a"}</params></tool>';
    const calls = parseToolCalls(output, KNOWN);
    expect(calls).toEqual([{ name: "file_read", params: { path: "a" } }]);
  });

  it("falls through to strategy 4 when 1, 2, and 3 find nothing", () => {
    const output =
      "<tool_call>\n<function=git_status>\n</function>\n</tool_call>";
    const calls = parseToolCalls(output, KNOWN);
    expect(calls).toEqual([{ name: "git_status", params: {} }]);
  });

  it("returns [] for plain natural-language prose with no tool-call syntax", () => {
    expect(
      parseToolCalls("I've analyzed the code and it looks good.", KNOWN),
    ).toEqual([]);
  });

  it("returns [] when every strategy's candidate is an unknown tool", () => {
    const output =
      '```tool\nbogus1\n{}\n```\n{"tool": "bogus2", "params": {}}\n<tool name="bogus3"><params>{}</params></tool>';
    expect(parseToolCalls(output, KNOWN)).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseToolCalls("", KNOWN)).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(parseToolCalls("   \n\n  ", KNOWN)).toEqual([]);
  });

  it("handles a very long parameter value without crashing", () => {
    const longContent = "x".repeat(20000);
    const calls = parseToolCalls(
      `{"tool": "file_write", "params": {"path": "a", "content": "${longContent}"}}`,
      KNOWN,
    );
    expect(calls[0].params.content).toBe(longContent);
  });

  it("handles unicode content in params", () => {
    const calls = parseToolCalls(
      '{"tool": "file_write", "params": {"path": "a", "content": "héllo 世界 🎉"}}',
      KNOWN,
    );
    expect(calls[0].params.content).toBe("héllo 世界 🎉");
  });

  it("handles escaped quotes/newlines inside JSON params correctly", () => {
    const calls = parseToolCalls(
      '{"tool": "file_write", "params": {"path": "a", "content": "line1\\nline2 \\"quoted\\""}}',
      KNOWN,
    );
    expect(calls[0].params.content).toBe('line1\nline2 "quoted"');
  });

  it("DOCUMENTED LIMITATION: an illustrative example of tool-call syntax for a real tool is indistinguishable from an actual call", () => {
    // The parser has no semantic understanding of "this is just an
    // example" vs "do this now" — it matches on shape alone. This test
    // documents that limitation explicitly rather than silently relying
    // on unspecified behavior; it is not something a syntax-level parser
    // can fix, only a semantic/model-level concern.
    const output =
      'You could call it like this: ```tool\nfile_read\n{"path": "x"}\n```';
    const calls = parseToolCalls(output, KNOWN);
    expect(calls).toEqual([{ name: "file_read", params: { path: "x" } }]);
  });

  it("respects a caller-supplied knownTools set that differs from the fallback (mode-restricted tool sets)", () => {
    // Simulates a 'plan' mode agent, whose tool set doesn't include
    // shell_exec — a call to it must be filtered out even though it's a
    // perfectly real tool in other modes.
    const planModeTools = new Set(["file_read", "search_content"]);
    const calls = parseToolCalls(
      '{"tool": "shell_exec", "params": {"command": "rm -rf /"}}',
      planModeTools,
    );
    expect(calls).toEqual([]);
  });
});
