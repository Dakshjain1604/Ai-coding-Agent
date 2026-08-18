# Wiring Audit

CodingAgent's source, read directly rather than taken from its own CLAUDE.md description. Nine subsystems are built, several are fully implemented — and then never called from the path a real user runs.

**Method.** Every finding below is a file:line reference, re-verified against source twice — once during initial audit, once by a second pass that corrected three inaccuracies (marked with **△** on the relevant finding).

## Summary

| # | Issue | Primary file | Effort |
|---|---|---|---|
| 1 | Streaming built, never enabled | `UniversalAgent.ts:157` | small |
| 2 | Hooks registered, never fire | `BaseAgent.ts`, `executeTool()` | small |
| 3 | Skills matched, never executed | `SkillRegistry.ts` / `interactive.ts` | small |
| 4 | Routing contradicts "local-first" | `ModelRouter.ts:191` | small |
| 5 | No code-search tool wired | `builtin.ts` / `tool-sets.ts` | small |
| 6 | Orchestrator strategy computed, discarded △ | `AgentSpawner.ts:428` | medium |
| 7 | Two competing truncation systems | `BaseAgent.ts` / `ContextWindow.ts` | medium |
| 8 | Memory session-scoping half-true △ | `MemoryManager.ts:292` | small |
| 9 | Embeddings table dead | `SQLiteStore.ts` | deferred |

**△ Corrected on re-verification:** items 6 and 8 were originally scoped more broadly ("orchestrator unreachable," "memory writes bypass batching per-turn"). Direct source re-checks found the real shape is narrower in both cases — see below for the precise, verified claim.

---

## 01 — Streaming is fully implemented and never used

**Evidence.** All 9 providers in `src/providers/*` implement a working `async *stream()`. `BaseAgent.callLLM()` has complete streaming-consumption plumbing, including time-to-first-token telemetry. But `UniversalAgent.execute()` hardcodes `callLLM({ stream: false })` at line 157 — confirmed by direct grep.

**Why it matters.** The user sees a spinner, then one buffered block rendered via `marked-terminal` after the entire response arrives. Every other harness in the comparison streams token-by-token. This is the single most visible gap between CodingAgent and its peers.

**Fix.** Flip the flag to `true`; accumulate `StreamChunk`s into a synthetic `CompletionResult` (the collection pattern already exists inside `callLLM`'s internal closure — reuse it); write raw tokens to stdout as they arrive; keep a config flag for buffered+rendered mode as a fallback.

## 02 — Hooks are enabled but never fire

**Evidence.** `HookManager` supports 10 lifecycle events with priority ordering and timeouts; a built-in hook already blocks dangerous shell commands like `rm -rf`. `interactive.ts` and `autonomous.ts` call `.enable()` but never `.register()` anything, and `BaseAgent.executeTool()` never calls `hookManager.execute()` — only the separate permission system runs.

**Why it matters.** The dangerous-command guard is unit-tested in isolation and passes — but never runs in the actual tool-execution path. A user relying on it as a safety net has none.

**Fix.** Call `pre-tool-use` / `post-tool-use` / `on-error` at the right points inside `executeTool()`, honoring the existing `skip`/`modifiedData` contract. Register built-ins once via a new shared helper instead of duplicating the call in two CLI modes.

## 03 — Skills are matched but never executed

**Evidence.** `SkillRegistry.executeSkill()` just formats instructions into a numbered string; it doesn't run anything. `interactive.ts`'s `handleRequest()` only prints "Executing skill: X" to the console — the skill's instructions never reach the LLM or influence tool choice.

**Why it matters.** Custom skills (commit, debug, refactor, release, review, testgen) are effectively decorative. Matching happens correctly; the payload is discarded.

**Fix.** Lightest viable fix: treat matched skill instructions as a system-prompt injection, not an autonomous executor. Pass them through `Task.metadata.skillInstructions`; have `UniversalAgent.execute()` append them to the system prompt alongside the existing output-dir append.

## 04 — Provider routing contradicts the stated "local-first" design

**Evidence.** Root cause verified precisely: `getModelRouter()` is called with no arguments from `BaseAgent.initializeContext()`, so `ModelRouter`'s own constructor default — `preferLocal: false`, confirmed at line 191 — always wins. `ConfigManager`'s `preferLocal: true` default is never threaded through. `routeToBest()` additionally contains an explicit comment skipping local/Ollama.

**Why it matters.** CLAUDE.md states "local-first: Ollama runs on device, no API keys required to start" as a core design principle. As shipped, normal execution prefers a free OpenRouter model and only falls back to local if OpenRouter is unreachable — the opposite of the documented behavior.

**Fix.** Build routing rules dynamically from `config.preferLocal` in the constructor instead of a static table; thread `ConfigManager`'s defaults into the `getModelRouter()` call site; remove the explicit local-skip in `routeToBest()`.

## 05 — No first-class code-search tool is wired up

**Evidence.** `code-search.ts` defines `search_files`, `search_content`, `grep`, `find_usages`, and more — confirmed never imported anywhere in the codebase. The live tool set (`builtin.ts`) has no search tool, and no mode's `TOOL_SETS` entry includes one.

**Why it matters.** Every peer harness in the comparison treats ripgrep-class search as a first-class, purpose-built tool. CodingAgent's only path today is the LLM improvising a shell command via `shell_exec` — slower, less consistent, and harder to gate with permissions.

**Fix.** Register `createCodeSearchTools()`'s output in `registerBuiltinTools()`; add the relevant tool names to the `code`/`debug`/`review` mode tool sets. Check the separate, also-unused `file-system.ts` factory for anything not already covered before wiring or deleting it.

## 06 — Orchestrator computes a multi-agent strategy, then discards it △

**Evidence.** Corrected finding: the CLI *does* call `AgentSpawner.executeTask()`, which *does* call `TaskAnalyzer.analyze()` — but `executeTask()` only ever consumes `agents[0]`, throwing away any pipeline/parallel strategy the analyzer recommended. `spawnWithStrategy()`, `executeParallel()`, `executePipeline()`, `ParallelOrchestrator.ts`, `ResultSynthesizer.ts`, and `PlanManager.ts` are confirmed unreferenced from any live call path. A related bug: `autonomous.ts` calls `spawner.spawn()` but never `spawner.execute()`, so autonomous mode fails every iteration with "No result from agent."

**Why it matters.** A meaningful chunk of orchestration code exists, is exercised by nothing, and duplicates functionality that the target design (see *Best-of-Four*) covers more simply — keeping both would violate this project's own DRY-aggressive engineering preference.

**Fix.** Retire `PlanManager.ts` and `ResultSynthesizer.ts`. Repurpose `ParallelOrchestrator.executePipeline()` into the sub-agent-as-child-session mechanism described in *Best-of-Four*. Fix the missing `spawner.execute()` call in the same change.

## 07 — Two competing, unheeded truncation systems

**Evidence.** `BaseAgent.truncateMessages()` (runs on every `callLLM`) and `ContextWindowManager.compact()` (a separate priority+recency eviction algorithm, fed via `MemoryManager`, read by nothing that reaches the model) overlap in purpose. Neither performs LLM-based summarization — both are pure heuristic truncation today.

**Why it matters.** This is the single blocking prerequisite for the target design's context-epoch and structured-compaction items — building new context logic on top of two competing old systems means picking a winner twice.

**Fix.** Unify on `truncateMessages()`. Delete `ContextWindowManager` from the `MemoryManager` hot path entirely — nothing reads its output for a decision that matters.

## 08 — Memory "session-scoped I/O" claim is half true △

**Evidence.** Corrected finding: `addConversationTurn()` is confirmed dead code (never called), not a per-turn batching bypass as first scoped. The real gap is narrower: `logExecution()` writes directly to SQLite once, at the end of each task — bypassing session batching for that one record type only.

**Why it matters.** A smaller inconsistency than originally thought, but still contradicts CLAUDE.md's "writes once at session end" claim for this one write path.

**Fix.** Delete the unused `addConversationTurn()` path. Keep `logExecution()` as-is, documented explicitly as "intentionally write-once-per-task," rather than implying it's part of the batched flow.

## 09 — SQLite embeddings table is dead — deferred, not fixed

**Evidence.** `SQLiteStore.findSimilar()`/`storeEmbedding()` are reachable but nothing on the live path ever calls `storeEmbedding()`. The actual mid-session retrieval mechanism is `SessionCache`'s word-overlap substring search.

**Why it matters.** Not a regression — an unfinished nice-to-have. Building embedding generation now would be premature: no clear consumer yet, and the target design's model-catalog work will make embedding-model selection easier later.

**Fix.** No Phase 1 action. Revisit only after the capability catalog lands.

---
*Doc 2 of 4 — see: Field Guide, Best-of-Four, Landing Sequence*
