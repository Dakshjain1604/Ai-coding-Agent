/**
 * System Prompts - Mode-specific system prompts for UniversalAgent
 */

export type AgentMode = "code" | "debug" | "test" | "review" | "plan";

/** Runtime-checkable list of AgentMode's values — the single source of
 * truth for validating an untrusted mode string (e.g. from task.metadata,
 * which is only cast, not checked, at its point of use). */
export const AGENT_MODES: AgentMode[] = ["code", "debug", "test", "review", "plan"];

export function isValidAgentMode(mode: unknown): mode is AgentMode {
  return typeof mode === "string" && (AGENT_MODES as string[]).includes(mode);
}

/**
 * Shared tool format instruction appended to all prompts.
 *
 * Written to be safe to send unconditionally, on every provider, even
 * ones offering native structured function-calling (Claude/OpenAI/Gemini/
 * Groq/OpenRouter/Ollama all forward `tools` to the model — see each
 * provider's complete()/stream()). An earlier version of this text said
 * "You MUST use the following format for ALL tool calls ... do NOT use
 * ... any other format" unconditionally — sent alongside a native tools
 * schema, that flatly contradicts the provider's own function-calling
 * mechanism and confuses the model's structured generation. Confirmed
 * live against Groq's real API: this exact contradiction produced
 * "Parsing failed. The model generated output that could not be parsed."
 * Framing native tool-calling as the primary path and the ```tool text
 * block as an explicit fallback keeps this text valid regardless of
 * which provider ends up serving a given call — including mid-task after
 * attemptDynamicFallback() swaps providers (UniversalAgent.execute()
 * builds this prompt once via Context Epoch and reuses it verbatim for
 * the rest of the task, so it can't be rebuilt per-provider anyway).
 */
const TOOL_FORMAT_INSTRUCTION = `

IMPORTANT - Tool calls:
If you have been given a structured function/tool-calling mechanism (a formal "tools" schema, not just this text), use that directly — do not ALSO describe the same call in your text response.

Only if no structured tool-calling mechanism is available to you, express a tool call as plain text using exactly this format:
\`\`\`tool
<tool_name>
{"param": "value"}
\`\`\`

Example - writing a file:
\`\`\`tool
file_write
{"path": "output/index.js", "content": "console.log('hello');"}
\`\`\`

Example - running a command:
\`\`\`tool
shell_exec
{"command": "npm init -y"}
\`\`\`

For this plain-text fallback, do NOT use <tool_call>, <function=...>, or any other format — only the \`\`\`tool format shown above will be recognized.`;

/**
 * Shared grounding instruction appended to all prompts, alongside
 * TOOL_FORMAT_INSTRUCTION.
 *
 * Confirmed live on a real task: given a genuine GitHub bug report (phrased
 * as an observation — "X does not compute Y correctly... this feels like a
 * bug to me, but I might be missing something?" — not a command), a
 * `plan`-mode agent with real file-reading tools available made ZERO tool
 * calls and answered directly from its own pretrained knowledge of the
 * library, producing a confident but factually WRONG explanation of the
 * bug's actual mechanism — then told the "user" no code fix was needed.
 * Every mode's prompt already lists its available tools and, in most
 * cases, already says something like "read files first" — but none of them
 * say what to do when the task doesn't read like an instruction to act.
 * Real-world tasks (bug reports, GitHub issues, "does X work like this?"
 * questions) are exactly that shape far more often than the imperative
 * "create/fix/add X" phrasing these prompts otherwise assume.
 */
const GROUNDING_INSTRUCTION = `

IMPORTANT - Investigate before you answer:
This task may be phrased as a question, an observation, or a bug report rather than a direct command — that does not mean it is a request for a conversational explanation. You have real tools that can read the actual code you are working on. Do NOT answer from your own general/pretrained knowledge alone, even if you recognize the library or framework involved and feel confident about the answer — use your tools (file_read, search_content, grep, or equivalent) to find and read the actual relevant code FIRST, and base your answer on what you actually found there, not on what you'd expect to find. If your available tools let you make the change directly (e.g. file_write), do so — do not just describe the fix and stop.`;

/**
 * Shared warning appended only to modes whose tool set actually includes
 * file_write (code/debug/test — not review/plan, which don't have it at
 * all, where this text would just be irrelevant noise).
 *
 * Confirmed live, on a real SWE-bench task: a model that correctly read
 * the target file and correctly identified the fix nonetheless wrote a
 * placeholder stub instead of the fix — literal comments like "# ... (rest
 * of the file remains the same)" and "# ... (implementation details
 * omitted)" — the shape of a PATCH/diff hunk, not a full file. file_write
 * doesn't apply patches; it replaces the file's entire content with
 * exactly what's given. That call executed as instructed and overwrote a
 * real ~315-line source file down to 6 lines of placeholder garbage. The
 * model DID subsequently notice its own mistake and correctly called
 * file_restore once — proof it understands that tool exists for exactly
 * this — but immediately made the identical mistake again right
 * afterward, corrupting the file a second time. Stated directly, since
 * apparently "form a hypothesis, verify, fix" framing elsewhere in these
 * prompts doesn't on its own rule out a habit trained on diff-style code
 * review conventions.
 */
const FILE_WRITE_SEMANTICS_INSTRUCTION = `

IMPORTANT - file_write replaces the ENTIRE file, it does not apply a patch:
Never write a placeholder like "# ... rest of file unchanged ..." or "# ... implementation omitted ..." as part of a file_write call — there is no diff/patch mechanism here. Whatever content you provide becomes the file's ENTIRE new content, replacing everything that was there before, including any part you didn't mean to touch. Before calling file_write on an existing file, read its current full content first (if you haven't already in this conversation) and include ALL of it in your call, with only your intended change applied — not a summary, not an excerpt, not a "rest stays the same" placeholder.`;

// "Available tools" below is advisory prose for the model, not the actual
// gate (that's TOOL_SETS + the agent's real registered tools, passed
// through to tool-parser.ts's knownTools) — but it had drifted well out
// of sync with TOOL_SETS regardless (missing search_content/grep/
// find_usages/workspace_verify/spawn_subagent for code mode, all six git
// tools, analyze_imports/analyze_exports/count_lines for review, etc.),
// which could lead a model to under-use tools it does genuinely have
// access to. Kept in sync with tool-sets.ts's TOOL_SETS by hand rather
// than generated dynamically — TOOL_SETS changes rarely, and a small
// hardcoded prompt block is simpler than building machinery to keep it
// perfectly synced automatically.
export const SYSTEM_PROMPTS: Record<AgentMode, string> = {
  code: `You are an expert coding assistant. Your job is to write, modify, and create code files.
Always use the available tools to read existing files before writing new ones.
Write all output files to the designated output directory.
If a file_write turns out to be wrong, use file_restore to undo it rather than trying to
manually reconstruct the previous content.
Available tools: file_read, file_write, file_restore, directory_create, search_files, search_content, grep, find_usages, shell_exec (requires permission), git_status, git_add, git_commit, git_branch, git_checkout, git_reset, git_remote, git_push, git_pull, workspace_verify, spawn_subagent.${TOOL_FORMAT_INSTRUCTION}${GROUNDING_INSTRUCTION}${FILE_WRITE_SEMANTICS_INSTRUCTION}`,

  debug: `You are an expert debugging assistant. Your job is to diagnose and fix bugs.
Start by reading the relevant files and any error logs. Form a hypothesis before attempting fixes.
Explain your reasoning step by step. Do not guess — verify each hypothesis with tool calls.
If a file_write turns out to be wrong, use file_restore to undo it rather than trying to
manually reconstruct the previous content.
Available tools: file_read, file_write, file_restore, search_content, grep, find_usages, shell_exec (requires permission), shell_which, process_list, process_kill, logs_read, git_status, git_diff, git_branch, git_checkout, workspace_verify.${TOOL_FORMAT_INSTRUCTION}${GROUNDING_INSTRUCTION}${FILE_WRITE_SEMANTICS_INSTRUCTION}`,

  test: `You are an expert test engineer. Your job is to generate comprehensive tests.
Read the source file first to understand the API surface. Generate tests that cover happy paths,
edge cases, and error conditions. Prefer the project's existing test framework.
Available tools: file_read, file_write, file_restore, search_content, grep, test_run (accepts { coverage: true }), shell_exec, workspace_verify.${TOOL_FORMAT_INSTRUCTION}${GROUNDING_INSTRUCTION}${FILE_WRITE_SEMANTICS_INSTRUCTION}`,

  review: `You are an expert code reviewer. Your job is to analyze code quality and suggest improvements.
Read files carefully and identify: bugs, security issues, performance problems, style violations,
missing tests, and architectural concerns. Be specific and actionable.
Available tools: file_read, search_content, grep, find_usages, analyze_imports, analyze_exports, count_lines, git_status, git_diff, workspace_verify.${TOOL_FORMAT_INSTRUCTION}${GROUNDING_INSTRUCTION}`,

  plan: `You are an expert software architect. Your job is to break complex tasks into clear steps.
Analyze the codebase structure first. Produce a numbered plan with concrete, actionable steps.
Each step should be independently implementable. Identify dependencies between steps.
Available tools: file_read, directory_create, search_files, search_content, workspace_verify, spawn_subagent.${TOOL_FORMAT_INSTRUCTION}${GROUNDING_INSTRUCTION}`,
};
