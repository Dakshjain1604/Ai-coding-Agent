/**
 * File editor tool: view, create, exact-match replace, and insert.
 *
 * Edits are anchored on exact text (str_replace) or a line number
 * (insert), never on "write the whole file again" — whole-file rewrites
 * are how models truncate or corrupt files they only partly remember.
 * Every edit returns the edited region with line numbers, so the model's
 * picture of the file stays accurate without re-reading it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Observation, Tool, ToolContext } from "./tool.js";

const SNIPPET_CONTEXT_LINES = 4;
const MAX_VIEW_LINES = 2_000;
const MAX_DIRECTORY_ENTRIES = 300;

export class EditorTool implements Tool {
  readonly spec = {
    name: "editor",
    description:
      "View and edit files. Commands: " +
      "`view` shows a file with line numbers (optionally a [start, end] line range) or lists a directory; " +
      "`create` writes a new file (or fully replaces one) with `file_text`; " +
      "`str_replace` replaces `old_str` with `new_str` — `old_str` must match exactly once, including whitespace; " +
      "`insert` inserts `new_str` after line `insert_line` (0 inserts at the top). " +
      "Relative paths resolve against the shell's current directory.",
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, enum: ["view", "create", "str_replace", "insert"] as const },
        path: { type: "string" as const, description: "File or directory path." },
        view_range: {
          type: "array" as const,
          items: { type: "integer" as const },
          description: "For view: [start_line, end_line], 1-based and inclusive; end_line -1 means end of file.",
        },
        file_text: { type: "string" as const, description: "For create: the full file content." },
        old_str: { type: "string" as const, description: "For str_replace: exact text to replace." },
        new_str: { type: "string" as const, description: "For str_replace and insert: the new text." },
        insert_line: { type: "integer" as const, description: "For insert: line number to insert after." },
      },
      required: ["command", "path"],
    },
  };

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<Observation> {
    const rawPath = args.path as string;
    const path = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd(), rawPath);
    switch (args.command) {
      case "view":
        return view(path, args.view_range as number[] | undefined);
      case "create":
        return create(path, args.file_text as string | undefined);
      case "str_replace":
        return strReplace(path, args.old_str as string | undefined, (args.new_str as string | undefined) ?? "");
      case "insert":
        return insert(path, args.insert_line as number | undefined, args.new_str as string | undefined);
      default:
        return { ok: false, output: `Error: unknown command ${JSON.stringify(args.command)}` };
    }
  }
}

function numbered(lines: string[], firstLineNumber: number): string {
  const width = String(firstLineNumber + lines.length - 1).length;
  return lines.map((line, i) => `${String(firstLineNumber + i).padStart(width)}\t${line}`).join("\n");
}

function snippet(content: string, focusStartLine: number, focusLineCount: number): string {
  const lines = content.split("\n");
  const start = Math.max(1, focusStartLine - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, focusStartLine + focusLineCount - 1 + SNIPPET_CONTEXT_LINES);
  return numbered(lines.slice(start - 1, end), start);
}

function view(path: string, range: number[] | undefined): Observation {
  if (!existsSync(path)) return { ok: false, output: `Error: ${path} does not exist.` };
  if (statSync(path).isDirectory()) return { ok: true, output: listDirectory(path) };

  const lines = readFileSync(path, "utf8").split("\n");
  let start = 1;
  let end = lines.length;
  if (range) {
    if (range.length !== 2) return { ok: false, output: "Error: view_range must be [start_line, end_line]." };
    start = range[0];
    end = range[1] === -1 ? lines.length : range[1];
    if (start < 1 || start > lines.length || end < start) {
      return { ok: false, output: `Error: invalid view_range ${JSON.stringify(range)}; file has ${lines.length} lines.` };
    }
    end = Math.min(end, lines.length);
  }
  const clippedEnd = Math.min(end, start + MAX_VIEW_LINES - 1);
  const note =
    clippedEnd < end
      ? `\n[showing lines ${start}-${clippedEnd} of ${lines.length}; use view_range to see more]`
      : "";
  return { ok: true, output: numbered(lines.slice(start - 1, clippedEnd), start) + note };
}

function listDirectory(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) return;
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const isDir = (() => {
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      })();
      entries.push(`${"  ".repeat(depth)}${name}${isDir ? "/" : ""}`);
      if (isDir && depth < 1) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  const more = entries.length >= MAX_DIRECTORY_ENTRIES ? `\n[listing truncated at ${MAX_DIRECTORY_ENTRIES} entries]` : "";
  return `${root}/ (2 levels, hidden entries skipped)\n${entries.join("\n")}${more}`;
}

function create(path: string, fileText: string | undefined): Observation {
  if (fileText === undefined) return { ok: false, output: "Error: create requires file_text." };
  const existed = existsSync(path);
  if (existed && statSync(path).isDirectory()) return { ok: false, output: `Error: ${path} is a directory.` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fileText);
  const lineCount = fileText.split("\n").length;
  return { ok: true, output: `${existed ? "Overwrote" : "Created"} ${path} (${lineCount} lines).` };
}

function strReplace(path: string, oldStr: string | undefined, newStr: string): Observation {
  if (oldStr === undefined || oldStr === "") return { ok: false, output: "Error: str_replace requires a non-empty old_str." };
  if (!existsSync(path)) return { ok: false, output: `Error: ${path} does not exist.` };
  const content = readFileSync(path, "utf8");

  const occurrences: number[] = [];
  for (let i = content.indexOf(oldStr); i !== -1; i = content.indexOf(oldStr, i + 1)) occurrences.push(i);

  if (occurrences.length === 0) {
    return {
      ok: false,
      output: `Error: old_str was not found in ${path}. It must match exactly, including whitespace and indentation. View the file to copy the exact text.`,
    };
  }
  if (occurrences.length > 1) {
    const lineNumbers = occurrences.map((offset) => content.slice(0, offset).split("\n").length);
    return {
      ok: false,
      output: `Error: old_str matches ${occurrences.length} places in ${path} (lines ${lineNumbers.join(", ")}). Include more surrounding text so it matches exactly once.`,
    };
  }

  const offset = occurrences[0];
  const updated = content.slice(0, offset) + newStr + content.slice(offset + oldStr.length);
  writeFileSync(path, updated);
  const startLine = content.slice(0, offset).split("\n").length;
  return {
    ok: true,
    output: `Edited ${path}. Updated region:\n${snippet(updated, startLine, newStr.split("\n").length)}`,
  };
}

function insert(path: string, insertLine: number | undefined, newStr: string | undefined): Observation {
  if (insertLine === undefined || newStr === undefined) {
    return { ok: false, output: "Error: insert requires insert_line and new_str." };
  }
  if (!existsSync(path)) return { ok: false, output: `Error: ${path} does not exist.` };
  const lines = readFileSync(path, "utf8").split("\n");
  if (insertLine < 0 || insertLine > lines.length) {
    return { ok: false, output: `Error: insert_line must be between 0 and ${lines.length}.` };
  }
  const inserted = newStr.split("\n");
  lines.splice(insertLine, 0, ...inserted);
  const updated = lines.join("\n");
  writeFileSync(path, updated);
  return {
    ok: true,
    output: `Inserted ${inserted.length} line(s) into ${path}. Updated region:\n${snippet(updated, insertLine + 1, inserted.length)}`,
  };
}
