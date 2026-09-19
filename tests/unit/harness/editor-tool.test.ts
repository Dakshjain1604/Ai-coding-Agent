import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorTool } from "../../../src/harness/tools/editor.js";
import type { ToolContext } from "../../../src/harness/tools/tool.js";

let dir: string;
let ctx: ToolContext;
const editor = new EditorTool();
const run = (args: Record<string, unknown>) => editor.run(args, ctx);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-editor-"));
  ctx = { cwd: () => dir, startedAt: Date.now(), deadline: Date.now() + 60_000, scratchDir: dir };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("EditorTool — view", () => {
  it("shows a file with right-aligned line numbers", async () => {
    writeFileSync(join(dir, "a.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const obs = await run({ command: "view", path: "a.txt" });
    expect(obs.ok).toBe(true);
    expect(obs.output).toContain(" 1\tline1");
    expect(obs.output).toContain("10\tline10");
  });

  it("shows only the requested range, and -1 means end of file", async () => {
    writeFileSync(join(dir, "a.txt"), "a\nb\nc\nd");
    expect((await run({ command: "view", path: "a.txt", view_range: [2, 3] })).output).toBe("2\tb\n3\tc");
    expect((await run({ command: "view", path: "a.txt", view_range: [3, -1] })).output).toBe("3\tc\n4\td");
  });

  it("rejects an out-of-bounds range with the file length", async () => {
    writeFileSync(join(dir, "a.txt"), "a\nb");
    const obs = await run({ command: "view", path: "a.txt", view_range: [5, 9] });
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("file has 2 lines");
  });

  it("lists a directory two levels deep, skipping hidden entries", async () => {
    mkdirSync(join(dir, "src", "deep", "deeper"), { recursive: true });
    writeFileSync(join(dir, "src", "main.py"), "");
    mkdirSync(join(dir, ".git"));
    const obs = await run({ command: "view", path: "." });
    expect(obs.output).toContain("src/");
    expect(obs.output).toContain("  main.py");
    expect(obs.output).toContain("  deep/");
    expect(obs.output).not.toContain("deeper");
    expect(obs.output).not.toContain(".git");
  });

  it("reports a missing path", async () => {
    const obs = await run({ command: "view", path: "nope.txt" });
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("does not exist");
  });
});

describe("EditorTool — create", () => {
  it("creates parent directories and reports line count", async () => {
    const obs = await run({ command: "create", path: "x/y/z.txt", file_text: "1\n2" });
    expect(obs.ok).toBe(true);
    expect(obs.output).toMatch(/Created .*z\.txt \(2 lines\)/);
    expect(readFileSync(join(dir, "x/y/z.txt"), "utf8")).toBe("1\n2");
  });

  it("says when it overwrote an existing file", async () => {
    writeFileSync(join(dir, "f.txt"), "old");
    expect((await run({ command: "create", path: "f.txt", file_text: "new" })).output).toMatch(/^Overwrote/);
  });

  it("requires file_text", async () => {
    expect((await run({ command: "create", path: "f.txt" })).ok).toBe(false);
    expect(existsSync(join(dir, "f.txt"))).toBe(false);
  });
});

describe("EditorTool — str_replace", () => {
  beforeEach(() => writeFileSync(join(dir, "code.py"), "def a():\n    return 1\n\ndef b():\n    return 1\n"));

  it("replaces a unique match and shows the edited region with line numbers", async () => {
    const obs = await run({ command: "str_replace", path: "code.py", old_str: "def b():\n    return 1", new_str: "def b():\n    return 2" });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(dir, "code.py"), "utf8")).toBe("def a():\n    return 1\n\ndef b():\n    return 2\n");
    expect(obs.output).toContain("5\t    return 2");
  });

  it("refuses an ambiguous match and names the matching lines", async () => {
    const obs = await run({ command: "str_replace", path: "code.py", old_str: "return 1", new_str: "return 3" });
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("matches 2 places");
    expect(obs.output).toContain("lines 2, 5");
    expect(readFileSync(join(dir, "code.py"), "utf8")).toContain("return 1");
  });

  it("explains a non-match (exact whitespace required)", async () => {
    const obs = await run({ command: "str_replace", path: "code.py", old_str: "def a():\n  return 1", new_str: "x" });
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("not found");
  });

  it("allows deleting text with an empty new_str", async () => {
    const obs = await run({ command: "str_replace", path: "code.py", old_str: "\ndef b():\n    return 1\n", new_str: "" });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(dir, "code.py"), "utf8")).toBe("def a():\n    return 1\n");
  });

  it("rejects an empty old_str", async () => {
    expect((await run({ command: "str_replace", path: "code.py", old_str: "", new_str: "x" })).ok).toBe(false);
  });
});

describe("EditorTool — insert", () => {
  beforeEach(() => writeFileSync(join(dir, "f.txt"), "a\nb\nc"));

  it("inserts after the given line", async () => {
    const obs = await run({ command: "insert", path: "f.txt", insert_line: 1, new_str: "x\ny" });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("a\nx\ny\nb\nc");
    expect(obs.output).toContain("2\tx");
  });

  it("inserts at the top with line 0", async () => {
    await run({ command: "insert", path: "f.txt", insert_line: 0, new_str: "top" });
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("top\na\nb\nc");
  });

  it("rejects an out-of-range line", async () => {
    const obs = await run({ command: "insert", path: "f.txt", insert_line: 9, new_str: "x" });
    expect(obs.ok).toBe(false);
    expect(obs.output).toContain("between 0 and 3");
  });
});

describe("EditorTool — paths", () => {
  it("resolves relative paths against the shell's current directory", async () => {
    mkdirSync(join(dir, "moved"));
    ctx = { ...ctx, cwd: () => join(dir, "moved") };
    await run({ command: "create", path: "here.txt", file_text: "x" });
    expect(existsSync(join(dir, "moved", "here.txt"))).toBe(true);
  });

  it("uses absolute paths as given", async () => {
    const target = join(dir, "abs.txt");
    await run({ command: "create", path: target, file_text: "x" });
    expect(existsSync(target)).toBe(true);
  });
});
