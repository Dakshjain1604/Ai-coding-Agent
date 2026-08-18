/**
 * Tool Parser - Multi-strategy tool call parser
 * Parses LLM output to extract tool calls using multiple strategies
 */

export interface ParsedToolCall {
  name: string;
  params: Record<string, unknown>;
}

// Fallback used only when no live tool set is provided (e.g. calling the
// parser directly, outside an agent). Kept intentionally small — the real
// gate is always the caller's actual registered tools, passed in via
// `knownTools`, not this hardcoded list (which drifts from the tool
// registry the moment a tool is added/renamed).
const FALLBACK_KNOWN_TOOLS = new Set([
  "file_read",
  "file_write",
  "file_delete",
  "shell_exec",
  "git_status",
  "test_run",
]);

function isKnownTool(name: string, knownTools?: Set<string>): boolean {
  return (knownTools ?? FALLBACK_KNOWN_TOOLS).has(name);
}

/**
 * Strategy 1: Original markdown code block format
 * ```tool
 * file_write
 * { "path": "...", "content": "..." }
 * ```
 */
export function parseMarkdownCodeBlock(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const pattern = /```(?:tool)?\n(\w[\w_]*)\n([\s\S]*?)```/g;
  const calls: ParsedToolCall[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const name = match[1];
    // Without this gate, ANY bare-fenced block whose first line is a
    // single word (a plain code example, a one-word note, a language tag
    // with no adjoining newline quirk) gets treated as a tool call for a
    // nonexistent tool — the most common shape of false positive across
    // all four strategies, since fenced blocks are extremely common in
    // ordinary LLM prose.
    if (!isKnownTool(name, knownTools)) continue;
    try {
      calls.push({ name, params: JSON.parse(match[2]) });
    } catch {
      calls.push({ name, params: { input: match[2].trim() } });
    }
  }
  return calls;
}

/**
 * Scans for top-level, brace-balanced `{...}` substrings — unlike a naive
 * `/\{[\s\S]*?\}/` regex, this tracks nesting depth (and skips over braces
 * inside string literals) so it doesn't truncate at the first inner
 * closing brace. That truncation was a real bug: any tool call whose
 * params/arguments/input value is itself an object (i.e. almost any real
 * tool call) would silently fail to parse under the old regex.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          objects.push(text.slice(start, i + 1));
          i++;
          break;
        }
      }
    }
    if (depth !== 0) break; // unbalanced from here on — stop scanning
  }
  return objects;
}

/**
 * Strategy 2: JSON object with "tool"/"name" + "params"/"arguments" keys
 * {"tool": "file_write", "params": {...}}
 * {"name": "file_write", "arguments": {...}}
 */
export function parseJsonObject(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const candidate of extractJsonObjects(output)) {
    try {
      const obj = JSON.parse(candidate);
      const name = obj.tool ?? obj.name ?? obj.function;
      const params = obj.params ?? obj.arguments ?? obj.input ?? {};
      if (name && typeof name === "string" && isKnownTool(name, knownTools)) {
        calls.push({ name, params });
      }
    } catch {
      // not valid JSON
    }
  }
  return calls;
}

/**
 * Strategy 3: XML-style tool calls (some models prefer this)
 * <tool name="file_write"><params>{"path": "..."}</params></tool>
 */
export function parseXmlStyle(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const pattern = /<tool[^>]*name=["'](\w+)["'][^>]*>([\s\S]*?)<\/tool>/g;
  const calls: ParsedToolCall[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const name = match[1];
    if (!isKnownTool(name, knownTools)) continue;
    try {
      const paramsContent = match[2].replace(/<\/?params>/g, "").trim();
      calls.push({ name, params: JSON.parse(paramsContent) });
    } catch {
      calls.push({ name, params: {} });
    }
  }
  return calls;
}

/**
 * Strategy 4: <tool_call> format used by some models (OpenRouter, etc.)
 * <tool_call>
 * <function=shell_exec>
 * <parameter=command>npm init -y</parameter>
 * </function>
 * </tool_call>
 */
export function parseToolCallTag(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  // Match each <tool_call>...</tool_call> block
  const toolCallPattern = /<tool_call>[\s\S]*?<\/tool_call>/g;
  let toolCallMatch;
  while ((toolCallMatch = toolCallPattern.exec(output)) !== null) {
    const block = toolCallMatch[0];
    // Extract function name from <function=NAME>
    const funcMatch = block.match(/<function=(\w+)>/);
    if (!funcMatch) continue;
    const name = funcMatch[1];

    // Extract all <parameter=KEY>VALUE</parameter> pairs
    const params: Record<string, unknown> = {};
    const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(block)) !== null) {
      const key = paramMatch[1];
      const value = paramMatch[2].trim();
      // Try to parse as JSON, otherwise keep as string
      try {
        params[key] = JSON.parse(value);
      } catch {
        params[key] = value;
      }
    }

    if (isKnownTool(name, knownTools)) {
      calls.push({ name, params });
    }
  }
  return calls;
}

/**
 * Master parser: tries all strategies in order, returns first non-empty
 * result. `knownTools` should be the calling agent's actual registered
 * tool names (e.g. `new Set(this.tools.keys())`) — passing it through is
 * what lets the JSON-object and tool_call-tag strategies recognize any
 * currently-registered tool instead of a hardcoded, driftable list.
 */
export function parseToolCalls(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const s1 = parseMarkdownCodeBlock(output, knownTools);
  if (s1.length > 0) return s1;

  const s2 = parseJsonObject(output, knownTools);
  if (s2.length > 0) return s2;

  const s3 = parseXmlStyle(output, knownTools);
  if (s3.length > 0) return s3;

  const s4 = parseToolCallTag(output, knownTools);
  if (s4.length > 0) return s4;

  return [];
}
