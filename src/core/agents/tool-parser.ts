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
 *
 * Also matches the same three pieces (marker/name/JSON) crammed onto one
 * line — `\`\`\`tool file_read {"path": "..."}\`\`\`` — since some models
 * (confirmed live: an NVIDIA-hosted model on a real SWE-bench task) don't
 * reliably put the tool name and JSON body on their own lines even when
 * explicitly instructed to. The original `\n`-only pattern silently
 * dropped every tool call from output in that shape — not a parse
 * failure the model could recover from, since nothing downstream ever
 * saw it as an attempted tool call at all. `\s+` (whitespace, not
 * specifically a newline) between each piece accepts both shapes.
 */
export function parseMarkdownCodeBlock(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const pattern = /```(?:tool)?\s+(\w[\w_]*)\s+([\s\S]*?)```/g;
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
 * Strategy 1b: like Strategy 1, but for when the model never closes the
 * fence at all — confirmed live, on the same real SWE-bench task as
 * Strategy 1's fix above: the same model that sometimes closed its fence
 * (parsed fine) also sometimes just... didn't, for the exact same
 * "```tool <name> {json}" shape, with no closing "```" anywhere in the
 * response. Strategy 1 depends on a literal closing fence to know where
 * the JSON body ends, so that shape silently produced zero tool calls —
 * not a parse failure visible to the model, just the attempted action
 * never happening at all. Uses the balanced-brace JSON scanner instead of
 * a fence to find the parameter object's real extent, so a missing
 * closing fence doesn't matter. Deliberately narrower than Strategy 1: no
 * `{input: rawText}` fallback for a non-JSON body — a real tool name with
 * no JSON object anywhere after it is more likely incidental prose than
 * an actual (malformed) tool call, and guessing wrong here risks new
 * false positives rather than closing a real gap.
 */
export function parseFencedToolCallNoClosingFence(
  output: string,
  knownTools?: Set<string>,
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const headerPattern = /```(?:tool)?\s+(\w[\w_]*)\s*/g;
  let match;
  while ((match = headerPattern.exec(output)) !== null) {
    const name = match[1];
    if (!isKnownTool(name, knownTools)) continue;
    const rest = output.slice(match.index + match[0].length);
    const [firstJsonObject] = extractJsonObjects(rest);
    if (!firstJsonObject) continue;
    try {
      calls.push({ name, params: JSON.parse(firstJsonObject) });
    } catch {
      // A real known tool name immediately followed by something
      // brace-balanced but not valid JSON — skip rather than guess.
    }
  }
  return calls;
}

/**
 * Detects a fenced ```tool block naming a real, known tool, even when its
 * JSON body is malformed or incomplete — used to tell "the model tried to
 * call a tool and the attempt didn't parse" apart from "the model gave a
 * genuine final text answer" when parseToolCalls() returns zero calls.
 *
 * Confirmed live, on a real SWE-bench task: a free-tier OpenRouter model
 * emitted ```tool\nfile_write\n{"path": ..., "content": "...2000+ chars of
 * real file content..." with the JSON string cut off mid-value and no
 * closing brace anywhere in the response — genuinely incomplete, not a
 * format parseFencedToolCallNoClosingFence's balanced-brace scanner could
 * ever resolve (there is no balanced object to find). parseToolCalls()
 * correctly refused to guess at it, but the caller (UniversalAgent's main
 * loop) was treating "zero tool calls" as unconditionally meaning "task is
 * finished," silently discarding an obviously-in-progress, correctly-aimed
 * tool-call attempt instead of asking the model to retry it.
 */
export function hasIncompleteToolCallAttempt(
  output: string,
  knownTools?: Set<string>,
): boolean {
  const headerPattern = /```(?:tool)?\s+(\w[\w_]*)\s*/g;
  let match;
  while ((match = headerPattern.exec(output)) !== null) {
    if (isKnownTool(match[1], knownTools)) return true;
  }
  return false;
}

/**
 * Strategy 2: JSON object with "tool"/"name" + "params"/"arguments" keys
 * {"tool": "file_write", "params": {...}}
 * {"name": "file_write", "arguments": {...}}
 * {"name": "file_write", "parameters": {...}}
 *
 * "parameters" (not just "params") matters on its own — confirmed live: a
 * real NVIDIA-hosted model, on a real SWE-bench task, consistently used
 * `{"name": "file_read", "parameters": {"path": "..."}}` (mirroring the
 * standard OpenAI-style function-calling schema's own "parameters" field
 * name). Without this alias, `obj.params ?? obj.arguments ?? obj.input`
 * all miss, silently falling through to `{}` — not a parse failure the
 * model could see, just the right tool called with an empty/wrong params
 * object every time. That's what actually happened: `file_read` executed
 * 10 times in a row, each failing "Missing required parameter: path",
 * repeatedly triggering the action-cycle-detector's intervention, until
 * the task ran out its full execution budget without ever reading a
 * single file.
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
      const params = obj.params ?? obj.parameters ?? obj.arguments ?? obj.input ?? {};
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

  const s1b = parseFencedToolCallNoClosingFence(output, knownTools);
  if (s1b.length > 0) return s1b;

  const s2 = parseJsonObject(output, knownTools);
  if (s2.length > 0) return s2;

  const s3 = parseXmlStyle(output, knownTools);
  if (s3.length > 0) return s3;

  const s4 = parseToolCallTag(output, knownTools);
  if (s4.length > 0) return s4;

  return [];
}
