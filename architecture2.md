# CodingAgent — Architecture v3.0 (Target)
> Post-research revision · Supersedes the aspirational claims in `Architecture.md` v2.0 · Companion docs: *Agent Harness Field Guide*, *Wiring Audit*, *Best-of-Four*, *Landing Sequence* (published artifacts, this session)

---

## Why this file exists

`Architecture.md` (v2.0) describes CodingAgent as it was *intended* to work after the "Council Review" — streaming wired, session-scoped memory, dynamic local-first fallback. A source-level audit this session found several of those claims don't hold in the current codebase (streaming implemented but never invoked, routing defaulting to a cloud provider instead of local, hooks and skills registered but never executed — full list in the *Wiring Audit* doc). Separately, a deep architecture comparison against deepseek-harness, opencode, and codex surfaced ten patterns worth adopting (the *Best-of-Four* doc).

This file describes the **target state**: v2.0's design with the wiring gaps closed and the curated external patterns layered in. It does not describe what exists in the repo today — for that, read the code or the *Wiring Audit*. Build order and dependencies are in the *Landing Sequence* doc.

### Design Principles (revised)

1. **Local-first, actually.** Ollama preferred whenever available — enforced by construction (routing rules built from config), not by a static table that happens to default elsewhere.
2. **Free-tier optimized.** Unchanged from v2.0.
3. **Single agent, mode switching** — modes now compose both a tool set *and* injected instructions (skills), not just a system-prompt string.
4. **Session-scoped I/O, honestly documented.** Where a write is intentionally immediate (e.g. execution log), it's documented as such rather than implied to be batched.
5. **System-aware.** Unchanged, now also aware of real per-model context limits via a fetched capability catalog instead of a hardcoded table.
6. **Sandbox-safe.** Unchanged — output-directory isolation, explicit `apply`.
7. **One context, honestly built.** A single, unified truncation/compaction path — not two systems that disagree about what the model saw.
8. **Cache-aware.** Every context-assembly decision is made with provider prompt-caching in mind: don't rebuild what didn't change.
9. **Defense in depth, sized to fit.** Layer a cheap static rule check in front of the existing permission prompts, rather than reaching for OS-level sandboxing this project doesn't need yet.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLI Layer                                        │
│  Interactive Mode (REPL, real streaming) · oclif Commands · Permission System │
│  Hooks now actually fire here: pre-tool-use / post-tool-use / on-error        │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Orchestration Layer (slimmed)                         │
│  TaskAnalyzer → complexity score + system-prompt hint only (no longer a       │
│  controller). PlanManager / ResultSynthesizer: RETIRED (dead code removed).   │
│  AgentSpawner: single-agent spawn only — multi-agent decomposition moved      │
│  into the agent loop itself as a callable tool (see Sub-Agent below).         │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Universal Agent                                      │
│                                                                                │
│  Mode Detection → System Prompt (per mode) + Tool Set (per mode)              │
│                  + injected Skill instructions (when matched)                 │
│                                                                                │
│  Context Epoch (NEW)                                                          │
│    baseline system prompt, built once per task, cached                        │
│    source drift (date/git status/instructions) → small appended message      │
│    never a full rebuild mid-task                                              │
│                                                                                │
│  Agent Loop:                                                                   │
│  1. initSession() — load memory ONCE                                          │
│  2. Build Context Epoch (baseline + skill instructions if matched)            │
│  3. callLLM() — REAL streaming, tokens to terminal as they arrive             │
│  4. parseToolCalls() — multi-strategy parser (unchanged)                      │
│  5. Hooks fire: pre-tool-use → permission check → execute → post-tool-use     │
│  6. spawn_subagent tool available (plan/code modes) — child session,          │
│     depth-limited, permission-narrowed, text-only return                      │
│  7. Compactor (NEW) — structured template summary when budget crossed,        │
│     replaying prefix verbatim to preserve provider cache; falls back to       │
│     hard-trim on failure                                                       │
│  8. Early exit if 3 consecutive idle iterations                               │
│  9. flushSession() — write memory ONCE                                        │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                             Tool Layer                                        │
│  File System · Shell · Git · Test & Coverage · Code Search (NEW — wired)      │
│  spawn_subagent (NEW) — plan/code modes only                                  │
│  shell_exec now gated by a prefix-rule table (NEW) ahead of the generic       │
│  permission check: git status → allow, git push → prompt, rm -rf → deny       │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Provider Layer                                      │
│  ModelRouter — routing rules built from config.preferLocal at construction    │
│  (no more static table defaulting away from local)                            │
│  ProviderRegistry (NEW) — typed capability map, replaces three near-identical │
│  per-provider switch statements                                               │
│  ModelCatalog (NEW) — fetched + cached capability/pricing data (models.dev-   │
│  style); hardcoded MODEL_SPECS becomes the offline fallback only              │
│  Prompt caching (NEW) — cache_control breakpoints on system/message           │
│  boundaries for providers that support it                                     │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Memory Layer                                       │
│  SessionCache (unchanged) · ProjectMemory (unchanged)                         │
│  ContextWindowManager: RETIRED — truncation unified into one path             │
│  logExecution(): documented as intentional write-once-per-task, not batched   │
│  Permission grants (NEW): persisted to .claude/permissions.json,              │
│  in-memory Set is now a cache in front of the file, not the only copy         │
│  Config (NEW): explicit CONFIG_LAYERS list + single precedence function       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## What changed from v2.0, and why

| Area | v2.0 claim | v3.0 target | Why (source) |
|---|---|---|---|
| Streaming | "Real-time to terminal" | Actually true — `stream: true` on the live call path | Wiring Audit #1 |
| Hooks | Implied active safety layer | Actually fire on every tool call | Wiring Audit #2 |
| Skills | Not mentioned in v2.0 | Matched instructions injected into system prompt | Wiring Audit #3 |
| Local-first routing | "if preferLocal && isOllamaRunning()" | Same intent, now actually the code path taken | Wiring Audit #4 |
| Code search | Not a distinct tool | First-class tool, wired into `code`/`debug`/`review` modes | Wiring Audit #5 |
| Multi-agent | TaskAnalyzer + AgentSpawner + PlanManager (3 layers) | TaskAnalyzer (hint only) + `spawn_subagent` tool (child session) | Wiring Audit #6, Best-of-Four piece F |
| Context/truncation | `ContextWindow.ts` listed "UNCHANGED" | Single unified path; `ContextWindowManager` retired | Wiring Audit #7 |
| Compaction | Didn't exist | Structured, cache-preserving, template-based | Best-of-Four piece C |
| System prompt cost | Rebuilt implicitly per call | Context Epoch — cached baseline, append-only drift | Best-of-Four piece B |
| Model capability data | Hardcoded `MODEL_SPECS` | Fetched catalog, hardcoded table as fallback | Best-of-Four piece D |
| Permission grants | Session-only ("Yes (Always for session)") | Persisted across runs | Best-of-Four piece G |
| Shell command gating | Single permission rule table | + prefix-rule table ahead of it | Best-of-Four piece H |
| Config merge | Informal call-order in `load()` | Explicit ordered layer list + precedence function | Best-of-Four piece I |

---

## Core Components (deltas only — see `Architecture.md` for anything not listed here)

### Context Epoch (`src/core/agents/ContextEpoch.ts` — new)
One baseline system prompt per task, built from the current mode's prompt + any matched skill instructions + environment sources (date, git status, project instructions). Cached for the task's lifetime. A source changing mid-task appends a small system message instead of triggering a rebuild — this is what makes provider-side prompt caching (see Provider Layer) actually pay off.

### Compactor (`src/core/agents/Compactor.ts` — new)
Triggered when `truncateMessages()`'s unified budget check crosses threshold. Produces a fixed-template summary (Objective / Important Details / Work State / Next Move / Relevant Files); re-compaction merges into the existing summary rather than regenerating. The summarization call itself replays the conversation prefix verbatim and appends the compaction instruction last, so it doesn't invalidate the provider's cached prefix. Falls back to the existing hard-trim truncation if the summarization call fails or times out.

### Sub-agent as child session (repurposed `ParallelOrchestrator`)
Exposed to the top-level agent as a `spawn_subagent` tool (available in `plan`/`code` modes only). Spawns a fresh `UniversalAgent` in the requested mode, with a tool set that is a strict subset of the parent's, depth-limited (default max depth 2), and returns only `{ success, output }` — no shared mutable state with the parent. Replaces the discarded `TaskAnalyzer`-computed pipeline/parallel strategies from v2.0 with a decision the agent itself makes mid-conversation.

### ModelCatalog (`src/providers/ModelCatalog.ts` — new)
Fetches and caches a model capability/pricing catalog (context length, cost) with a TTL, config-driven cache path. `ModelRouter`'s existing `MODEL_SPECS` table becomes the offline fallback when the catalog is unreachable. Feeds real context-length numbers into the Compactor's thresholds instead of the fixed `maxTokens` estimate.

### ProviderRegistry (`src/providers/ProviderRegistry.ts` — new)
A typed capability map replacing three near-identical per-provider switch statements inside `ModelRouter` (`getBetterModel`, `getFasterModel`, `getDefaultModelForCategory`). Not a dependency-injection framework — a lookup table.

### Permission persistence (`permission-system.ts` — extended)
`.claude/permissions.json` backs the existing in-memory `allowedTools` Set. Loaded at construction, written on every "always" grant. A second table, keyed on `shell_exec` command prefix rather than tool name, is checked first (`git status` → allow, `git push` → prompt, `rm -rf` → deny) — layered in front of, not instead of, the existing tool-level rule table.

### Config layering (`config.ts` — refactored)
`load()`/`mergeConfigs()` become an explicit `CONFIG_LAYERS` array (defaults → global → project-yaml → project-json → env overrides) reduced through one precedence function. Behavior-equivalent to v2.0's informal merge order — this is a clarity/testability refactor, not new behavior.

---

## File:Module Mapping (deltas from v2.0's table)

| File | v2.0 status | v3.0 status |
|---|---|---|
| `src/core/agents/UniversalAgent.ts` | NEW (v2.0) | Modified — real streaming, Context Epoch, skill injection |
| `src/core/agents/ContextEpoch.ts` | — | **NEW** |
| `src/core/agents/Compactor.ts` | — | **NEW** |
| `src/memory/ContextWindow.ts` | Unchanged | **RETIRED** from the memory hot path |
| `src/core/orchestrator/PlanManager.ts` | Unchanged | **RETIRED** |
| `src/core/orchestrator/ParallelOrchestrator.ts` | Existed, unreferenced | Repurposed — backs `spawn_subagent` |
| `src/core/orchestrator/ResultSynthesizer.ts` | Existed, unreferenced | **RETIRED** |
| `src/providers/ModelCatalog.ts` | — | **NEW** |
| `src/providers/ProviderRegistry.ts` | — | **NEW** |
| `src/hooks/HookManager.ts` | Existed, inert | Wired into `executeTool()` |
| `src/skills/SkillRegistry.ts` | Existed, inert | Instructions reach the system prompt |
| `src/core/tools/code-search.ts` | Existed, unreferenced | Registered + wired into `TOOL_SETS` |
| `src/utils/permission-system.ts` | Session-only grants | Persisted grants + prefix-rule table |
| `src/utils/config.ts` | Informal merge | Explicit layered precedence |

---

## Verification

Per-item required vs. recommended manual checks are in the *Landing Sequence* doc's verification table. The short version: streaming, hooks, local-first routing, and sub-agent spawning all need an actual terminal run to confirm — none of them can be fully verified by unit tests alone, since the defect class this revision addresses is "correct code, never called."

---

## Explicitly out of scope for v3.0

Carried over from the *Best-of-Four* "not adopting" notes — revisit only if the project's scale changes:
- A full plugin/DI framework (à la Cordis) for provider/tool/memory swapping.
- OS-level sandboxing (Seatbelt/Landlock/Windows restricted tokens) or an LLM-based action-review layer.
- A client-server split with SSE/WebSocket transport for multi-client access.
- Embedding-based memory retrieval (the SQLite embeddings table stays dormant).
