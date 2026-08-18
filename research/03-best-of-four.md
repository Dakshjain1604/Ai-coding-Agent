# Best-of-Four

Ten pieces, each pulled from whichever of the four harnesses (Field Guide) handled it best, each deliberately scoped down to what CodingAgent actually needs — not the full machinery the source repo built around it.

**Selection rule.** Curated subset, not architectural parity. Every full-framework option (Cordis's plugin/DI system, opencode's Effect runtime, codex's OS-level sandboxing) was considered and rejected as disproportionate to this project's scale — see the *Not adopting* line on each piece for what was left on the table and why.

---

## Context, Memory & Compaction

### A — Prompt caching at the provider layer
*from deepseek-harness · opencode*

**Design.** Add `cache_control: {type: "ephemeral"}` breakpoints to `ClaudeProvider`'s system/message builder, at the system prompt and the last stable message boundary. OpenAI and Gemini auto-cache repeated prefixes server-side as long as message order stays stable — no code change needed there beyond not reordering.

**Why.** Confirmed via `grep cache_control` across `src/providers/*`: no provider does this today. It's a near-zero-cost change that everything else in this list depends on for its cost/latency payoff — B and C are no-ops without it.

**Not adopting.** deepseek-harness's transactional, checkpointed compaction lifecycle (crash-safe mid-compaction) — real engineering value, but solves a durability problem CodingAgent's single-process session doesn't have yet.

### B — Context Epoch: cache the system prompt as a baseline
*from opencode*

**Design.** New `ContextEpoch` module: build the system prompt once per task as an immutable baseline + a snapshot of its sources (date, git status, project instructions). When a source changes mid-conversation, append a small system message instead of rebuilding the whole prompt.

**Why.** Preserves piece A's cache prefix across turns — the single highest-leverage idea in the opencode research, and directly portable without Effect or any DI framework. Composes cleanly with CodingAgent's existing rule that system messages always survive truncation.

**Not adopting.** opencode's full event-sourced session model (durable inbox, steer/queue/promotion boundaries) — built for a multi-client server serving TUI+web+desktop simultaneously. CodingAgent is single-client, turn-by-turn; that machinery has no consumer here.

### C — Structured, template-driven compaction
*from opencode · codex*

**Design.** New `Compactor` module using a fixed markdown template — Objective / Important Details / Work State (Completed / Active / Blocked) / Next Move / Relevant Files. Later compactions merge into the existing summary rather than regenerating; "recent conversation wins on conflict" is an explicit rule. The compaction LLM call replays the prefix verbatim and appends the summarize instruction last, preserving piece A's cache. Falls back to a hard token-budget trim if summarization itself fails or times out (codex's graceful-fallback pattern).

**Why.** Verified that CodingAgent has **no** LLM-summarization compaction today — both existing truncation paths are pure heuristic eviction. This is genuinely new capability, not a refactor, and a fixed template beats free-form summarization at staying coherent across repeated compactions.

**Not adopting.** codex's three-tier fallback chain (model-summarize → server-side remote-summarize → hard reset) — the middle tier assumes infrastructure CodingAgent doesn't operate. Two tiers (summarize → hard trim) capture the same resilience without it.

### J — Per-fragment token budgets
*from codex*

**Design.** Replace the single global truncation budget with three independent ones — system, tool-result, history — sized as a percentage of the model's real context length. Generalizes the existing ad hoc 16,000-character tool-result cap into the same mechanism rather than a one-off constant.

**Why.** Cheap and mechanical once C exists. Prevents one oversized tool result (a large file read, a verbose test run) from silently evicting conversation history it shouldn't compete with.

**Not adopting.** codex's full schema-enforced `ContextualUserFragment` discipline with manual-review gates on any fragment over 1K tokens — a code-review process control, not an architecture piece; worth adopting as a team practice later, not as code.

---

## Provider & Model Intelligence

### D — models.dev-style capability catalog
*from opencode*

**Design.** New `ModelCatalog`: fetch and cache a model capability/pricing JSON catalog (models.dev publishes one publicly) with a TTL. The existing hardcoded `MODEL_SPECS` table becomes the offline fallback, not the primary source.

**Why.** Eliminates a hand-maintained per-provider table that's exactly the kind of thing this project's own "DRY is important" preference flags — and feeds real context-length numbers into piece C's compaction thresholds and piece J's budgets instead of guesses.

**Not adopting.** Nothing scoped down here — this one ports close to as-is; the catalog format is already minimal.

### E — Capability-seam-lite provider registry
*from deepseek-harness*

**Design.** New `ProviderRegistry` — a small typed map, not a DI framework — replacing the three near-identical per-provider switch statements in `ModelRouter`'s model-selection helpers with one unified selection table.

**Why.** Captures the "Definition / Provider / Consumer" discipline's actual value (no more `if (provider === 'x')` branching sprawl) without the cost that made deepseek-harness's full Cordis system the clearest "overkill" verdict in the Field Guide.

**Not adopting.** Extending the same seam to memory backends speculatively. deepseek-harness needs it because it ships multiple swappable backends today; CodingAgent has one. Add the seam if and when a second backend actually exists — not before.

---

## Safety & Permissions

### G — Persisted "always allow" grants
*from opencode · codex*

**Design.** CodingAgent's permission grants currently live in an in-memory `Set`, gone the moment the process exits. Add a `.claude/permissions.json` file, loaded at startup and written on every "always" grant; keep the in-memory set as a fast-path cache in front of it.

**Why.** Both opencode and codex persist this across runs — re-answering the same permission prompt every session is friction with no safety benefit once a user has already decided.

**Not adopting.** opencode's asymmetric precedence (global permission rules override local, deliberately, so a repo can't silently defeat a user's safety rule) — worth doing eventually, folded into piece I's config work instead of a separate change.

### H — Prefix-rule command gate
*from codex*

**Design.** A second rule table, checked specifically for `shell_exec`, keyed on command prefix rather than tool name — `git status` auto-allowed, `git push` prompts, `rm -rf` denied outright. Checked before the generic tool-level permission rule.

**Why.** codex's actual defense-in-depth stack is four layers deep (static rule → interactive approval → LLM review → OS sandbox); this is layer one alone — the cheapest layer with the best value-to-effort ratio, landed on top of the existing permission system rather than replacing it.

**Not adopting.** OS-level sandboxing (Seatbelt/Landlock/Windows restricted tokens) and the LLM "Guardian" review layer — the Field Guide's clearest overkill verdict for a project this size. A permission-layer-only model, like opencode's, is the accepted tradeoff.

---

## Configuration

### I — Config as an explicit ordered-layer list
*from codex*

**Design.** Refactor `ConfigManager.load()`'s semi-informal global → project-yaml → project-json merge into an explicit `CONFIG_LAYERS` array reduced through one precedence function, matching the pattern (not the 10-tier enterprise scale) of codex's config loader.

**Why.** Mostly a clarity and testability win — the merge order becomes a single reviewable list instead of implicit call-order in `load()`. Low risk, and piece D's catalog needs a config-driven cache path/TTL to hang off of.

**Not adopting.** codex's MDM/enterprise-managed config tiers — a fleet-management feature with no audience in a single-developer or small-team tool.

---

**Piece F — sub-agent as child session** (from opencode) isn't listed separately: it's delivered as part of the Wiring Audit's fix #6, repurposing the existing (currently dead) `ParallelOrchestrator` rather than adding a parallel mechanism. See the Wiring Audit for the design, Landing Sequence for sequencing.

---
*Doc 3 of 4 — see: Field Guide, Wiring Audit, Landing Sequence*
