import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolExecutor,
  normalizeArguments,
  parseArgumentsJson,
  timeFooter,
  validateArguments,
  type Tool,
  type ToolContext,
} from "../../../src/harness/tools/tool.js";
import type { ToolSpec } from "../../../src/harness/types.js";

const echoSpec: ToolSpec = {
  name: "echo",
  description: "echo",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      times: { type: "integer" },
      mode: { type: "string", enum: ["plain", "loud"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["text"],
  },
};

function tool(run: Tool["run"], spec: ToolSpec = echoSpec): Tool {
  return { spec, run };
}

let scratch: string;
let ctx: ToolContext;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "harness-exec-"));
  ctx = { cwd: () => scratch, startedAt: Date.now(), deadline: Date.now() + 60_000, scratchDir: scratch };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const call = (name: string, args: unknown) => ({
  id: "c1",
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

describe("ToolExecutor — every call yields an observation", () => {
  const executor = new ToolExecutor([tool(async (args) => ({ ok: true, output: `said ${args.text}` }))]);

  it("runs a valid call", async () => {
    const result = await executor.execute(call("echo", { text: "hi" }), ctx);
    expect(result.observation.ok).toBe(true);
    expect(result.observation.output).toMatch(/^said hi\n\[time: \d+m elapsed, ~\d+m left\]$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports an unknown tool with the available names", async () => {
    const result = await executor.execute(call("shell_exec", { command: "ls" }), ctx);
    expect(result.observation.ok).toBe(false);
    expect(result.observation.output).toContain('unknown tool "shell_exec"');
    expect(result.observation.output).toContain("Available tools: echo");
  });

  it("reports invalid JSON arguments, echoing what was received", async () => {
    const result = await executor.execute(call("echo", '{"text": "unterminated'), ctx);
    expect(result.observation.ok).toBe(false);
    expect(result.observation.output).toContain("not valid JSON");
    expect(result.observation.output).toContain('{"text": "unterminated');
  });

  it("treats empty arguments as {} and reports the missing required parameter", async () => {
    const result = await executor.execute(call("echo", ""), ctx);
    expect(result.observation.output).toContain('missing required parameter "text"');
  });

  it("rejects non-object JSON arguments", async () => {
    const result = await executor.execute(call("echo", "[1,2]"), ctx);
    expect(result.observation.output).toContain("must be a JSON object");
  });

  it("converts a thrown tool error into a failed observation", async () => {
    const crashing = new ToolExecutor([tool(async () => { throw new Error("disk on fire"); })]);
    const result = await crashing.execute(call("echo", { text: "x" }), ctx);
    expect(result.observation.ok).toBe(false);
    expect(result.observation.output).toContain("Error: echo failed unexpectedly: disk on fire");
  });

  it("scrubs secrets from tool output", async () => {
    const leaky = new ToolExecutor([tool(async () => ({ ok: true, output: "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123" }))]);
    const result = await leaky.execute(call("echo", { text: "x" }), ctx);
    expect(result.observation.output).not.toContain("abcdefghijklmnop");
    expect(result.observation.output).toContain("REDACTED");
  });
});

describe("ToolExecutor — bounded observations", () => {
  it("keeps head and tail, marks the omission, and saves the full output", async () => {
    const big = "H".repeat(500) + "M".repeat(10_000) + "T".repeat(700);
    const executor = new ToolExecutor([tool(async () => ({ ok: true, output: big }))], { maxObservationChars: 1_000 });
    const result = await executor.execute(call("echo", { text: "x" }), ctx);
    const out = result.observation.output;
    expect(out.startsWith("H".repeat(300))).toBe(true);
    expect(out).toContain("T".repeat(700));
    expect(result.omittedChars).toBe(big.length - 1_000);
    expect(out).toContain(`${big.length - 1_000} characters omitted`);
    expect(result.fullOutputPath && existsSync(result.fullOutputPath)).toBe(true);
    expect(readFileSync(result.fullOutputPath!, "utf8")).toBe(big);
  });

  it("leaves output within budget untouched", async () => {
    const executor = new ToolExecutor([tool(async () => ({ ok: true, output: "short" }))], { maxObservationChars: 1_000 });
    const result = await executor.execute(call("echo", { text: "x" }), ctx);
    expect(result.observation.output).toMatch(/^short\n\[time:/);
    expect(result.omittedChars).toBe(0);
    expect(result.fullOutputPath).toBeUndefined();
  });
});

describe("validateArguments", () => {
  it("accepts valid arguments", () => {
    expect(validateArguments({ text: "a", times: 2, mode: "loud", tags: ["x"] }, echoSpec)).toEqual([]);
  });

  it("reports each problem: missing, unknown, wrong type, non-integer, enum", () => {
    const problems = validateArguments({ times: 1.5, mode: "quiet", tags: "x", extra: 1 }, echoSpec);
    expect(problems).toEqual(
      expect.arrayContaining([
        'missing required parameter "text"',
        expect.stringContaining('parameter "times" must be an integer'),
        expect.stringContaining('parameter "mode" must be one of plain, loud'),
        'parameter "tags" must be a array, got string',
        expect.stringContaining('unknown parameter "extra"'),
      ]),
    );
  });

  it("treats null as absent", () => {
    expect(validateArguments({ text: "a", times: null }, echoSpec)).toEqual([]);
    expect(validateArguments({ text: null }, echoSpec)).toEqual(['missing required parameter "text"']);
  });
});

describe("timeFooter — the model can see its remaining budget", () => {
  /**
   * From the cobol-modernization trace: with no sense of time the agent spent
   * its whole budget investigating and never wrote the file the task asked for.
   */
  it("reports elapsed and remaining minutes", () => {
    const now = Date.now();
    const footer = timeFooter({ cwd: () => "/", startedAt: now - 5 * 60_000, deadline: now + 9 * 60_000, scratchDir: "/tmp" });
    expect(footer).toBe("\n[time: 5m elapsed, ~9m left]");
  });

  it("never reports negative time once the deadline has passed", () => {
    const now = Date.now();
    const footer = timeFooter({ cwd: () => "/", startedAt: now - 60_000, deadline: now - 30_000, scratchDir: "/tmp" });
    expect(footer).toBe("\n[time: 1m elapsed, ~0m left]");
  });

  it("is omitted when there is no finite budget", () => {
    expect(timeFooter({ cwd: () => "/", startedAt: Date.now(), deadline: Infinity, scratchDir: "/tmp" })).toBe("");
  });

  it("is appended to every observation, success or failure", async () => {
    const executor = new ToolExecutor([tool(async () => ({ ok: false, output: "nope" }))]);
    const result = await executor.execute(call("echo", { text: "x" }), ctx);
    expect(result.observation.output).toMatch(/\[time: \d+m elapsed, ~\d+m left\]$/);
  });

  it("successfully parses arguments wrapped in markdown code blocks", async () => {
    const executor = new ToolExecutor([tool(async (args) => ({ ok: true, output: `said ${args.text}` }))]);
    const fenced = "```json\n" + JSON.stringify({ text: "inside fence" }) + "\n```";
    const result = await executor.execute(call("echo", fenced), ctx);
    expect(result.observation.ok).toBe(true);
    expect(result.observation.output).toContain("said inside fence");
  });

  it("normalizes and unpacks inlined <arg_key> tags from models", async () => {
    const editorSpec: ToolSpec = {
      name: "editor",
      description: "editor",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: ["view", "create"] },
          path: { type: "string" },
          file_text: { type: "string" },
        },
        required: ["command", "path"],
      },
    };
    const executor = new ToolExecutor([
      tool(async (args) => ({ ok: true, output: `${args.command} ${args.path}: ${args.file_text}` }), editorSpec),
    ]);

    // Live model failure shape from largest-eigenval benchmark:
    const leaked = JSON.stringify({
      command: "create<arg_key>path</arg_key><arg_value>/app/test.py</arg_value>",
      file_text: "content",
    });
    const result = await executor.execute(call("editor", leaked), ctx);
    expect(result.observation.ok).toBe(true);
    expect(result.observation.output).toContain("create /app/test.py: content");
  });
});

describe("parseArgumentsJson", () => {
  it("parses ordinary valid JSON", () => {
    expect(parseArgumentsJson('{"a": 1, "b": "text"}')).toEqual({ a: 1, b: "text" });
  });

  it("handles empty or whitespace string as empty object", () => {
    expect(parseArgumentsJson("")).toEqual({});
    expect(parseArgumentsJson("   \n\t  ")).toEqual({});
  });

  it("strips ```json ... ``` code fences", () => {
    expect(parseArgumentsJson("```json\n{\"command\": \"cat foo\"}\n```")).toEqual({ command: "cat foo" });
    expect(parseArgumentsJson("```\n{\"command\": \"cat foo\"}\n```")).toEqual({ command: "cat foo" });
  });

  it("extracts JSON object when surrounded by model chatter", () => {
    expect(parseArgumentsJson("Here is the call: {\"command\": \"ls\"} hope this helps!")).toEqual({ command: "ls" });
  });

  it("throws on completely invalid syntax", () => {
    expect(() => parseArgumentsJson("definitely not json")).toThrow();
  });
});

describe("normalizeArguments", () => {
  it("passes clean arguments through unmodified", () => {
    const input = { command: "create", path: "/app/main.py", file_text: "hello" };
    expect(normalizeArguments(input)).toEqual(input);
  });

  it("unpacks inlined <arg_key> tags from string values", () => {
    const input = {
      command: "create<arg_key>path</arg_key><arg_value>/app/eigen.py</arg_value>",
      file_text: "import numpy as np",
    };
    expect(normalizeArguments(input)).toEqual({
      command: "create",
      path: "/app/eigen.py",
      file_text: "import numpy as np",
    });
  });

  it("unpacks multiple sequential tags within a single value", () => {
    const input = {
      command: "create<arg_key>path</arg_key><arg_value>/app/a.py</arg_value><arg_key>file_text</arg_key><arg_value>x = 1</arg_value>",
    };
    expect(normalizeArguments(input)).toEqual({
      command: "create",
      path: "/app/a.py",
      file_text: "x = 1",
    });
  });

  it("handles unclosed trailing <arg_value> tag gracefully", () => {
    const input = {
      command: "create<arg_key>path</arg_key><arg_value>/app/b.py",
    };
    expect(normalizeArguments(input)).toEqual({
      command: "create",
      path: "/app/b.py",
    });
  });
});

