# Fixes Log

## Live-testing session (Groq end-to-end)

- **`.env` never loaded.** `bin/run.js` uses oclif's dynamic command discovery, bypassing `src/cli/index.ts`'s `dotenv/config` import entirely. Fixed by loading dotenv directly in `bin/run.js`.
- **Groq model names were stale.** `llama-3.3-70b-versatile` etc. are deprecated. Updated `ProviderRegistry`, `GroqProvider`, `ModelRouter` to live models (`openai/gpt-oss-20b` default, fits free-tier TPM limits).
- **Cost showed milliseconds as dollars.** `BaseAgent.safeRecordLLMCall()` passed `durationMs`/`cost` to `TelemetryCollector.recordLLMCall()` in swapped order. Fixed argument order.
- **`LOG_LEVEL` was documented but dead.** Wired into `Logger` — needed to trace the retry loop's swallowed errors.

## Complexity/tracing/harness audit

- Deleted `core/tools/built-in.ts` (near-duplicate-named shim of `builtin.ts`) and `memory/ContextWindow.ts` (a second, never-wired context-truncation implementation, plus its duplicate `ContextWindow` type and orphaned test).
- Converted 7 of 8 `await import(...)` calls to static imports after confirming no real circular-dependency risk; kept the one genuine cycle-breaker (`subagent-tool.ts` → `ParallelOrchestrator.ts`).
- Fixed dynamic provider fallback: `ProviderFactory.isAvailable()` caches forever, so a provider that fails mid-task was being re-selected instead of avoided. Added an `exclude` list to `ModelRouter.route()`.
- Fixed `--no-confirm` being a no-op on `test`/`debug`/`review`/`simplify` (only `run` actually applied it).
- Added debug/warn logging to previously-silent catch blocks (LLM retries, cost estimation, telemetry, corrupt permissions file, provider fallback skips) so failures are traceable via `LOG_LEVEL=debug` instead of invisible.

## Phase 2: Memory + Security (architecture-optimal.md)

- **Security bug fixes.** API keys now masked in `config get` output (dead `toYaml()`, which leaked them in full, deleted). Consolidated two competing `shell_exec` implementations — ported the stronger dangerous-command guards (`chmod -R`/`chown -R`/`mkfs`/`dd`) into the live permission-system rule table, deleted the dead file (including a `shell_env` tool that would have dumped every env var into LLM context). New `secret-scrubber.ts` — tool *results*, not just args, now get scrubbed of secret-shaped values before re-entering the conversation.
- **Memory: SQLite as sole store.** Deleted `ProjectMemory.ts` — its markdown round-trip silently dropped `expiresAt` and most metadata on every reload. Added a `scope: "user"|"project"` column with a real `PRAGMA table_info` + `ALTER TABLE` migration (this project's own `.claude/memory.db` already existed on disk). Added `remember`/`forget`/`memory` commands (interactive + CLI).
- **Fixed the live 26-conversations/0-turns bug.** `BaseAgent.initializeContext()` computed a `conversationId` via `startConversation()` and discarded it, so the fully-implemented `storeTurn()` path was never called. Verified fixed against the real `.claude/memory.db`.
- **Two more bugs caught by writing real round-trip tests.** `SQLiteStore.storeMemory()` always minted its own fresh ID, discarding whatever ID the caller already had — entries were unretrievable by the ID `store()` returned. `cleanup()` compared ISO-8601 timestamps against SQLite's differently-formatted `CURRENT_TIMESTAMP`, so expired entries were never actually purged.
- **Task risk scoring.** Added `task.risk`, scored independently from complexity (a one-line destructive task and a large harmless refactor land on opposite ends — conflating them would misfire on exactly the cases that matter). Permission prompts now show why a task was flagged risky; `workspace_verify` runs lint for high-risk tasks (also fixed a shared-flag bug where one failing check could misreport unrelated passing checks).

## Known limitation (not fixed, flagged)

Retry loop does 3 blind exponential-backoff retries even on non-retryable errors (e.g. 413 payload-too-large), which can never succeed without a smaller request. Proper fix needs structured status codes threaded through each provider's error wrapping — separate work, not done here.
