# Agent Harness Field Guide

A side-by-side architecture map of four coding-agent harnesses — **deepseek-harness**, **opencode**, **codex**, and **Claude Code** — across the eight dimensions that determine how an agent actually behaves.

**Source basis.** deepseek-harness, opencode, and codex were cloned in full and read directly from source. `anthropics/claude-code` ships no agent source publicly (docs/plugins only) — its entries are drawn from documented and observed behavior, marked *(inferred)* where source-level certainty isn't available.

---

## 01 — Agent Loop & Orchestration

How a user turn becomes model calls, tool calls, and a stopping condition.

| System | Loop shape | Unit of work | Concurrency model |
|---|---|---|---|
| deepseek-harness | Single class, phase-driven (idle/maintenance/running) | Turn → steps | Event-dispatched via Cordis waterfall/parallel/serial events |
| opencode | Outer `run()` loop calling `runTurn()` repeatedly | Turn → one `llm.stream()` call per turn | Effect `FiberSet`; parallel tool calls within a turn |
| codex | Task trait (`RegularTask`) wrapping a turn loop | Task → turns → steps | tokio async; `CancellationToken` + graceful-abort `Notify` |
| Claude Code *(inferred)* | Single conversational loop with explicit stop-reason handling | Turn → tool-use blocks | Sequential tool execution by default; parallel only via explicit sub-agent (Task tool) dispatch |

**deepseek-harness (Cordis).** The loop is a single `ReactLoopAgent` class, but every extension point (pre-step, request-building, tool pipeline, turn-stopping) is a typed Cordis event other plugins hook into — no loop code changes for new behavior. Enforced invariant: "model-visible ⟺ logged" — anything the model sees must be reconstructable from the session event log.

**opencode (Effect).** Architectural rule enforced in code comments: exactly one `llm.stream(request)` call per provider turn. Tool calls from that turn execute concurrently in a `FiberSet`; the outer loop re-enters only if tool calls occurred. Two live generations coexist in the same repo (V1 shipping, V2 event-sourced rewrite) — a real cost of iterating on loop architecture.

**codex (tokio).** Explicit state machine: `SessionTask` trait (`RegularTask`, `CompactTask`, `ReviewTask`) spawned on `tokio::spawn`, each turn re-captures a `StepContext` snapshot as the single source of truth for that model call. 100ms graceful-interruption grace window before hard-aborting a task.

**Claude Code (inferred).** No plugin/event framework exposed — extension happens above the loop (hooks, skills, MCP tools) rather than inside it. Mode changes (plan mode, output styles) alter what the loop is allowed to do, not the loop's structure. Sub-agents (Task tool) are the only concurrency primitive — no in-turn parallel tool fan-out is user-visible.

---

## 02 — Context Management

How the per-call context window is assembled, budgeted, and compacted.

| System | Token counting | Compaction trigger | Compaction method |
|---|---|---|---|
| deepseek-harness | Exact — priced by `ctx.tokenMeter` per logged envelope | Ratio of model's real context capacity (default 0.8) | LLM summarization; prefix replayed verbatim, instruction appended last (cache-preserving) |
| opencode | Heuristic, `chars/4` | Request size vs. model limit − buffer (20k tokens) | Structured markdown template summary, merged on re-compaction |
| codex | Heuristic, `bytes/4`; real usage from provider response | Pre-sampling check + reactive on provider overflow error | Model-summarize → remote-summarize → hard token-budget reset (fallback chain) |
| Claude Code *(inferred)* | Real tokenizer via API usage reporting | Auto at high context usage, or manual `/compact` | LLM summarization of older turns; recent turns kept verbatim |

**deepseek-harness — cache-aware.** System prompt is a separately-cached "Baseline System Context," rendered once per epoch. Tool-result pruning (model-free) runs before falling back to full LLM summarization. Compaction is a durable, transactional, checkpointed lifecycle — a crash mid-compaction can't corrupt the log.

**opencode — Context Epoch.** System prompt rendered once as an immutable baseline; environment drift (date, git status) becomes small appended "system update" messages instead of a full re-render — explicitly to preserve provider prompt-cache prefixes. Fixed summary template: Objective / Details / Work State / Next Move / Relevant Files — later compactions merge into it, not regenerate.

**codex — schema-budgeted.** Every context fragment is a typed struct implementing `ContextualUserFragment`, hard-capped at 10K tokens, >1K requiring manual review — context assembly is schema-driven, not string concatenation. Three independent compaction strategies with graceful fallback between them.

**Claude Code (inferred).** CLAUDE.md memory files are re-read at session start, not re-summarized — they sit outside the compaction boundary entirely as stable instructions. Mid-session context compression is visible to the user as an explicit event, not silent.

---

## 03 — Memory & Session Persistence

What survives a turn, a session, and a process restart — and in what shape.

| System | Session store | Cross-session memory | Retrieval |
|---|---|---|---|
| deepseek-harness | Append-only `.jsonl.zstd` (default) or SQLite, pluggable provider seam | Session fork/branch; durable resumable sub-agent children | None semantic — event log replay only |
| opencode | SQLite via Drizzle ORM, event-sourced messages by monotonic `seq` | AGENTS.md + project config, re-read every turn (not learned) | None semantic — filesystem is the "memory" |
| codex | JSONL rollout (source of truth) + SQLite secondary index | AGENTS.md (static) + a distinct generated "Memories" subsystem | Memories subsystem supports citation back to source rollout |
| Claude Code *(inferred)* | Session transcript, resumable via `--resume`/`--continue` | CLAUDE.md (project + user-global), layered | None semantic — files are read, not searched |

**deepseek-harness — pluggable.** Persistence backend is a capability seam (Definition/Provider/Consumer) — JSONL and SQLite providers are interchangeable behind one interface. Checkpoint policy decides *when* to flush, decoupled from *how*. Crash recovery synthesizes closing events for an incomplete trailing frame rather than dropping or blind-retrying.

**opencode — event-sourced.** A `session_input` table separates admission (durably recorded) from execution (a provider call), so a prompt survives a crash before the model ever sees it. Opaque cursor-based pagination (no offset semantics) for session listing.

**codex — dual-store.** JSONL is authoritative; SQLite is a queryable secondary index rebuilt via startup backfill — solves "list thousands of past sessions fast" without making the index the source of truth. "Memories" is a genuinely separate, LLM-generated long-term store distinct from both rollout history and AGENTS.md.

**Claude Code (inferred).** Memory is deliberately simple: layered markdown files a human (or the agent, on request) edits directly — no automatic fact extraction, no embeddings. Memory precedence is explicit and legible: enterprise → user-global → project → local overrides.

---

## 04 — Codebase Indexing & Search

How the agent finds relevant code without a human pointing at it.

| System | Text search | Structural search | Embeddings / vector index |
|---|---|---|---|
| deepseek-harness | Packaged ripgrep, spawned via subprocess seam, no shell | 4-op LSP seam (definition/references/implementation/hover) | None |
| opencode | Vendored ripgrep, JSON-line streamed + schema-validated | LSP integration (optional, TODO in V2) | None |
| codex | Arbitrary shell command (grep/rg) via the same sandboxed exec tool | None built-in beyond shell-outs | None |
| Claude Code *(inferred)* | Purpose-built Grep/Glob tools (ripgrep-backed) | None built-in; relies on LSP/IDE integration when present | None |

Unanimous finding across all four systems: **none** maintain a persistent AST, symbol, or embedding index. Search is ripgrep-class textual search, occasionally paired with an LSP for structural queries. This is a deliberate, repeated choice, not an oversight.

---

## 05 — Configuration & User Preferences

Where settings live, and which layer wins when they conflict.

| System | Format | Precedence (low → high) | Secrets |
|---|---|---|---|
| deepseek-harness | YAML (`cordis.yml` + `cordis.patch.yml`) | Bundle defaults → profile patch → home patch → CLI `--patch` | env (read-only, wins) → `.credentials.yaml` → cwd `.env` → home `.env` |
| opencode | JSONC (`opencode.jsonc`) | Global (XDG) → project files → `.opencode/` dirs (closest wins) | Flat JSON `auth.json` (shipping) or SQLite rows (V2) |
| codex | TOML (`config.toml` + profile overlays) | 10-tier numeric precedence: packaged defaults → MDM → system → enterprise → user → user+profile → project → CLI flags → legacy-managed layers | `$CODEX_HOME`-scoped, profile-aware |
| Claude Code *(inferred)* | JSON (`settings.json`) | Enterprise-managed → CLI flags → local project → shared project → user-global | OS keychain / credential helper, not plaintext config |

**opencode — asymmetric precedence.** General config: closer-to-cwd wins. Permission rules deliberately invert this — global overrides local, so a user's safety rule can't be silently defeated by a repo's local config.

**codex — explicit precedence function.** Precedence isn't ad hoc branching — it's a numerically-ordered list merged by a single reducer function, making the merge order auditable and testable in isolation.

---

## 06 — Tools, Permissions & Safety

What an agent is allowed to do, who decides, and what enforces it.

| System | Tool schema | Permission model | OS-level sandbox |
|---|---|---|---|
| deepseek-harness | Custom typed JSON-Schema DSL, mandatory output/render declarations | One-shot approval only (no persisted "always") | `bwrap`/Landlock (Linux), Seatbelt (macOS), ACL tokens (Windows) |
| opencode | Effect `Schema`, opaque capability tokens | Ordered wildcard rule list, findLast semantics, project-persisted "always" | None — permission layer only, no OS confinement |
| codex | Rust structs, spec+handler pairs, dynamically advertised per turn | 4 approval modes + a separate prefix-rule engine (execpolicy) + optional LLM "Guardian" review | Seatbelt / Landlock+seccomp / Windows restricted tokens — 4 layers deep with sandbox |
| Claude Code *(inferred)* | JSON Schema per tool | 4 permission modes (plan / default / acceptEdits / bypassPermissions) + per-tool allow/deny/ask rules | None by default; opt-in via devcontainer/sandboxed execution |

**codex — defense in depth.** A shell command passes through up to four independent gates before running: static prefix rule (execpolicy) → interactive approval → optional LLM review (Guardian) → OS sandbox enforcement. No single point of failure.

**opencode — no OS sandbox.** A meaningfully different tradeoff: once a tool call is permitted, it runs unconfined on the host. All protection is at the permission-decision layer, not enforcement layer.

---

## 07 — Streaming & Transport

How model output and events reach whatever is watching.

| System | Local/terminal transport | Remote/UI transport | Reconnect semantics |
|---|---|---|---|
| deepseek-harness | In-process (headless profile) | 2 dedicated downlink WebSockets + typed RPC (Typert) for unary calls | Requires both sockets + a host-describe handshake |
| opencode | In-process (embedded host) | SSE — two streams: instance-wide live feed, per-session durable+replayable feed | Client resubscribes explicitly from last durable `seq` |
| codex | In-process (TUI is a client of the same protocol) | SSE from provider; app-server protocol (JSON-RPC-like) over stdio/socket/WebSocket | Protocol-level, transport-agnostic `EventMsg` |
| Claude Code *(inferred)* | Direct token stream to terminal renderer | SSE from Anthropic API | N/A — single client, single process |

---

## 08 — Sub-Agent / Multi-Agent Orchestration

How an agent delegates part of a task to another agent.

| System | Delegation unit | Depth control | Coordination |
|---|---|---|---|
| deepseek-harness | One-shot or "continuable" durable child session; can even shell out to Claude Code / Codex as a backend | Monotone, persisted depth counter | Interrupt / follow-up / async report-back to parent |
| opencode | Child **session** — literally reuses the parent's session/runner machinery recursively | `subagent_depth` config, default 1 | Foreground (blocking) by default; experimental background mode injects a synthetic message on completion |
| codex | "Multi-agent" crates present in workspace (enterprise-tier feature) | n/a in this checkout's public docs | n/a |
| Claude Code *(inferred)* | Task tool spawns a fresh-context sub-agent; forks inherit context and share cache | No explicit recursive sub-agent spawning exposed | Sub-agent returns a final report; parent context stays clean |

**opencode — child = session.** The cleanest pattern found: a sub-agent is not a separate concept requiring its own orchestration framework — it is a child session with a derived, narrower permission set, using 100% of the existing session/storage/runner code. Permission narrowing explicitly denies the child re-delegation (`task`) and shared-state tools (`todowrite`) unless the child's own agent config allows them.

---

## Verdict, per system

| System | Worth stealing | Overkill here |
|---|---|---|
| deepseek-harness | Cache-preserving compaction order; capability-seam discipline; sub-agent depth/permission model | Vendoring & patching an entire DI framework (Cordis) for a single-team project |
| opencode | Context Epoch caching; structured compaction template; models.dev capability catalog; sub-agent-as-child-session | Full Effect ecosystem (Context.Service/Layer DI) as a prerequisite for the rest |
| codex | Defense-in-depth layering pattern; explicit config precedence function; per-fragment token budgets | OS-level sandboxing infrastructure; the 140-crate enterprise workspace surface |
| Claude Code | Layered CLAUDE.md memory; permission-mode spectrum (plan → autonomous); skills as progressive-disclosure instructions | — (source unavailable; scope was already the most conservative of the four) |

---
*Doc 1 of 4 — see: Wiring Audit, Best-of-Four, Landing Sequence*
