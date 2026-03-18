/**
 * Tool Parser - Multi-strategy tool call parser
 * Parses LLM output to extract tool calls using multiple strategies
 */

export interface ParsedToolCall {
  name: string;
  params: Record<string, unknown>;
}

const KNOWN_TOOLS = new Set([
  "file_read",
  "file_write",
  "file_delete",
  "directory_create",
  "shell_exec",
  "git_status",
  "git_add",
  "git_commit",
  "git_diff",
  "git_push",
  "test_run",
  "coverage_report",
  "planning",
  "memory",
]);

function isKnownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

/**
 * Strategy 1: Original markdown code block format
 * ```tool
 * file_write
 * { "path": "...", "content": "..." }
 * ```
 */
export function parseMarkdownCodeBlock(output: string): ParsedToolCall[] {
  const pattern = /```(?:tool)?\n(\w[\w_]*)\n([\s\S]*?)```/g;
  const calls: ParsedToolCall[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    try {
      calls.push({ name: match[1], params: JSON.parse(match[2]) });
    } catch {
      calls.push({ name: match[1], params: { input: match[2].trim() } });
    }
  }
  return calls;
}

/**
 * Strategy 2: JSON object with "tool"/"name" + "params"/"arguments" keys
 * {"tool": "file_write", "params": {...}}
 * {"name": "file_write", "arguments": {...}}
 */
export function parseJsonObject(output: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const jsonPattern = /\{[\s\S]*?\}/g;
  let match;
  while ((match = jsonPattern.exec(output)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      const name = obj.tool ?? obj.name ?? obj.function;
      const params = obj.params ?? obj.arguments ?? obj.input ?? {};
      if (name && typeof name === "string" && isKnownTool(name)) {
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
export function parseXmlStyle(output: string): ParsedToolCall[] {
  const pattern = /<tool[^>]*name=["'](\w+)["'][^>]*>([\s\S]*?)<\/tool>/g;
  const calls: ParsedToolCall[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    try {
      const paramsContent = match[2].replace(/<\/?params>/g, "").trim();
      calls.push({ name: match[1], params: JSON.parse(paramsContent) });
    } catch {
      calls.push({ name: match[1], params: {} });
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
export function parseToolCallTag(output: string): ParsedToolCall[] {
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

    if (isKnownTool(name)) {
      calls.push({ name, params });
    }
  }
  return calls;
}

/**
 * Master parser: tries all strategies in order, returns first non-empty result
 */
export function parseToolCalls(output: string): ParsedToolCall[] {
  const s1 = parseMarkdownCodeBlock(output);
  if (s1.length > 0) return s1;

  const s2 = parseJsonObject(output);
  if (s2.length > 0) return s2;

  const s3 = parseXmlStyle(output);
  if (s3.length > 0) return s3;

  const s4 = parseToolCallTag(output);
  if (s4.length > 0) return s4;

  return [];
}
