# Landing Sequence

The order to build the Wiring Audit's fixes and Best-of-Four's pieces in, what blocks what, and how to know each one actually works — not just compiles.

**One hard rule governs this whole sequence:** fix #7 (unifying CodingAgent's two competing truncation systems) must land before any of the context-epoch, compaction, or token-budget work. Building new context logic on top of two old, disagreeing systems means picking a winner twice.

---

## Phase 1 — Fix the wiring

Nine independent items from the Wiring Audit. Only #7 has downstream consequences — land it first.

```
#7 Unify truncation → #1 Enable streaming → #2 Wire hooks → #4 Fix routing →
#5 Wire search tool → #8 Memory cleanup → #6 Sub-agent + fix autonomous → #3 Wire skills
```

#9 (dead embeddings table) is deferred — no Phase 1 slot. Items #1–#6, #8 have no cross-dependencies and can run in parallel across engineers; the chain above is the suggested order for a single engineer working sequentially. #3 is placed last because it's cleanest to design alongside Phase 2's context-composition work.

**Gate before Phase 2:** #7 must be done. Everything else in Phase 1 can lag behind Phase 2's start if needed — only #7 blocks.

---

## Phase 2 — Land the curated pieces

Ten pieces from Best-of-Four (letters A–J; F was delivered inside Phase 1 #6).

```
I Config layers → A Prompt caching → B Context epoch → D Model catalog →
C Structured compaction → J Fragment budgets → E Provider registry →
G Persist grants → H Prefix command gate
```

**Why this order:**
- **I before D** — the model catalog needs a config-driven cache path and TTL to hang off.
- **A before B/C** — caching only pays off once context-epoch and compaction stop needlessly rebuilding prefixes.
- **D feeds C's thresholds and J's budgets** with real context-length numbers instead of guesses.
- **H lands after Phase 1's #2 (hooks)** since both police `shell_exec` — build them together to avoid two overlapping "is this dangerous" code paths.

---

## Verification strategy

Per this project's own "well-tested code is non-negotiable" standard: unit tests catch logic errors, but several of these fixes are specifically about runtime wiring — a passing unit test doesn't prove the wire is connected. Items marked **Required** need an actual CLI run, not just green tests.

| Item | Unit coverage | Manual verification |
|---|---|---|
| #1 Streaming | Mock provider stream, assert correct accumulation + tool-call parse | **Required** — real terminal run, confirm token-by-token output |
| #2 Hooks | Extend existing `hook-manager.test.ts`; assert `executeTool` calls hooks | **Required** — trigger `rm -rf`, confirm the hook (not just the permission prompt) blocks it |
| #4 Routing | Router resolves to local first when `preferLocal: true` + available | **Required** — run with Ollama up, no cloud keys, confirm no cloud fallback attempted |
| #6 Sub-agent | Depth limit enforced; child tool set ⊆ parent's; result contract shape | **Required** — multi-part task triggers `spawn_subagent`; verify autonomous mode no longer fails every iteration |
| #3 Skills | Instructions reach `systemPrompt` when metadata is present | Recommended — trigger a skill, confirm it visibly changes behavior |
| #5 Search tool | Tool registration count; each tool against a fixture dir | Recommended — ask agent to find usages, confirm it uses the tool not shell_exec |
| #7 Unified truncation | Single code path fires; old path no longer called | — internal refactor, unit coverage sufficient |
| B Context epoch | Epoch built once per task; source-change appends, never mutates baseline | Recommended — long session, confirm system prompt isn't resent verbatim each turn |
| C Compaction | Template fields populate; merge favors recent; fallback triggers on failure | **Required** — long session past threshold, read the summary for coherence, not just shape |
| A Prompt caching | `cache_control` present in constructed payload | Recommended — two consecutive Anthropic turns, check `usage.cache_read_input_tokens > 0` |
| D Model catalog | Fetch mocked; TTL expiry; fallback to hardcoded table on error | Recommended — run once with network disabled, confirm graceful fallback |
| G Persisted grants | Grant persists to file; reload picks it up | Recommended — grant "always," restart process, confirm no re-prompt |
| H Prefix gate | Table of example commands → expected allow/prompt/deny | Recommended — `git status` silent, `git push` prompts |
| I / E / J | Precedence order; provider-selection snapshot vs. old switch tables; fragment isolation | — internal refactors, unit coverage sufficient |

---

## Two milestones worth marking

**End of Phase 1.** CodingAgent's behavior matches its own CLAUDE.md description for the first time — streaming works, hooks enforce, skills influence behavior, local-first routing is actually local-first, and the multi-agent path is one live mechanism instead of one dead one plus a working duplicate.

**End of Phase 2.** CodingAgent has the ten highest-leverage patterns from four production coding-agent harnesses, each scoped to what a project this size actually needs — no DI framework, no OS sandbox, no client-server split, all deliberately deferred per Best-of-Four's "not adopting" notes.

---
*Doc 4 of 4 — see: Field Guide, Wiring Audit, Best-of-Four*
