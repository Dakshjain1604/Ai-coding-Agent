# Headless harness (`coding-agent exec`)

`src/harness/` is the agent runtime used for automation and benchmarks (Terminal-Bench 2.0 via
Harbor). It exists alongside the interactive CLI agent (`src/core/agents/UniversalAgent.ts`) and
shares only the failure classifier, the secret scrubber and the streamed tool-call accumulator with it.

```
exec (CLI) ─► runHarness (index.ts) ─► runAgent (agent-loop.ts)
                                         ├─ OpenRouterClient   one model, one retry policy
                                         ├─ ToolExecutor       bash + editor, bounded observations
                                         ├─ context.ts         window budgeting and compaction
                                         └─ JsonlTrajectory    every event, one JSON line
```

## Why it was built instead of patching the old agent

Traces from real Terminal-Bench runs of the old agent (bench/README.md, experiment 1) showed
symptoms with five root causes. Each part of the harness removes one of those causes:

| Root cause in the old agent | Symptom seen in traces | Harness design |
|---|---|---|
| Text-only transcript: tool calls, ids and reasoning dropped | same file rewritten 3× (257s), commands re-run | `types.ts`: assistant turns keep `toolCalls` (raw arguments) and `reasoningDetails`; every tool result carries its call id |
| Heuristics steered the work: regex modes, an automatic plan→code→test pipeline, per-mode tool lists and iteration caps | 140s of planning with empty handoffs; run cut off mid-verification | one loop, one tool set; ends when the model replies without a tool call, or on global turn/time budgets checked between turns |
| No contract for tool results | stdout lost on failed commands; `/` searched until the process was killed | `ToolExecutor`: every call returns exactly one bounded, secret-scrubbed observation, never throws |
| Runtime mixed with the environment | `.claude/memory.db` written into the task repo; exit 0 on failure | all harness state under `--logs-dir`; the model's API key is hidden from commands; exit code reflects the outcome |
| Retries in three layers (SDK, agent, provider fallback) | 290s of hidden 429 sleeps; daily quota retried 9×; silent model swaps | `OpenRouterClient` owns the only retry policy, and every retry is logged |

## Key decisions and trade-offs

**OpenRouter only.** One backend keeps error handling specific. OpenRouter hides upstream failures
behind "Provider returned error" with the cause in `error.metadata.raw`; the client folds that detail
into the error before classifying it. Requests set `provider.require_parameters` so they never reach
an upstream that silently ignores tools, and never send a `models` fallback list, so results are
attributable to the requested model.

**Failures are handled where they can be fixed** (`openrouter-client.ts`, `agent-loop.ts`):
- *Transport* (rate limit, 5xx, network, a stream with no data for 180s): resend with backoff,
  honoring Retry-After, bounded by attempts and the run deadline.
- *Conversation* (the provider rejected the model's output; the prompt exceeds the window): never
  resend the same request. A rejected generation is fed back to the model, with what it produced when
  the provider returns it; on context overflow the loop learns a smaller window from the failed
  request and compacts. Found in practice: 5 identical resends of a rejected tool call all failed,
  while one feedback turn fixed it.
- *Everything else* (auth, exhausted quota, bad request): stop immediately with the category.
- Replies without usable output (empty, cut off by the token limit, rejected) get feedback;
  3 in a row end the run.

**Shell model: a fresh process per command, with persisted session state** (`tools/bash.ts`),
not a persistent PTY/tmux session. Each command can be killed without losing the session. cwd and
exported variables are saved by an EXIT trap and restored on the next call. Output goes to a file,
so stdout+stderr stay in order, background jobs never hit SIGPIPE, and huge output is read head+tail
only. stdin is closed. When state could not be saved (the command used `exec`, or was SIGKILLed
after ignoring SIGTERM), the observation says so and names the directory the session is still in.
Verified in containers under bash, dash and busybox `sh`. Evidence for this choice: the
Terminal-Bench 2.0 paper (arXiv 2601.11868, Table 2) shows one-shot command harnesses such as
mini-swe-agent scoring on par with the tmux-based Terminus 2. Trade-off: truly interactive programs
(REPLs, VM consoles, ncurses) are not supported; see open questions.

**Context** (`context.ts`): output is capped where it is produced (bash 8KB head + 20KB tail;
executor 30K chars, with the full text saved to a file the agent can read). Budgets scale with the
window: at most 25% reserved for output, summaries at most 10%. Compaction starts at 80% of the
window, keeps the most recent 30% verbatim, never separates a tool result from its call, and is
refused when it would free under 10% of the window, so it can never thrash.

**Deadline and time budget**: the Harbor adapter derives the harness deadline from the task's agent
timeout (including job multipliers) minus 45s, so the harness ends its own run and writes
`result.json` before Harbor cancels it. A model call in flight is bounded by that same deadline,
checked against the wall clock on every chunk — a timer alone is defeated by a suspended host
(confirmed live: a sleeping laptop turned one call into 92 minutes). The model is told the budget
twice over: every observation ends with elapsed/remaining minutes, and the loop interrupts at 50%,
25% and 10% remaining with an explicit time check. The interrupt is what changed behavior: with the
passive figure alone an agent read "~3m left" and kept exploring, never writing the file the task
asked for; with the interrupt it produced and verified the deliverable in the next two turns.

## Observability

`--logs-dir` contains:
- `trajectory.jsonl`: run start (model, limits, tools, instruction), every model request/response
  (latency, first chunk, attempts, tokens, cost, upstream provider, content, tool calls), retries
  with category and wait, model errors (including rejected generations), tool results (arguments,
  output, exit code, duration, truncation), notices, compactions, run end.
- `result.json`: status, final message, turns, tool calls, usage, duration.

`bench/analyze.py` summarizes Harbor jobs from these files.

## Known limitations

- The linux bundle's Node is glibc-only, so it cannot run on musl images (Alpine). All 89
  Terminal-Bench 2.0 images are Debian/Ubuntu (checked), so this affects none of them.
- A per-command timeout kills that command's whole process group, including anything it started in
  the background without `setsid`. Servers started by a command that exits normally keep running
  (verified).
- No image input: tasks that need to look at images or video cannot be solved.

## Open questions to settle with traces (candidates, not commitments)

From a survey of published Terminal-Bench 2.0 harnesses (Codex CLI, Terminus 2/KIRA, LangChain Deep
Agents, ForgeCode, Droid). Each should be adopted only if our own traces show the failure it addresses.
1. **Enforced completion check.** Premature finishes and weak verification are a documented failure
   class; LangChain and ForgeCode credit enforced (not prompted) verification. Watch for runs that
   end "completed" with failing tests. One prompted rule already came from our own traces
   (experiment 2, openssl): work is checked in a fresh shell, so it must not depend on session state.
2. **Reasoning effort.** The strongest published evidence (Opus 4.6 system card: 55.1% at low vs.
   65.4% at max; LangChain: xhigh everywhere was worse because of timeouts). Plumbing exists:
   `--reasoning-effort` / `--ak reasoning_effort=...`.
3. **Non-blocking long commands** (Codex-style yield + poll). Watch for bash timeouts on builds and servers.
4. **Environment snapshot in the first prompt.** Watch for early turns spent on discovery and for
   "command not found" (24.1% of command failures in the Terminal-Bench paper).
5. **A plan/todo tool.** Watch for lost track of requirements on long tasks. (Time-budget warnings are
   no longer a candidate — they are implemented, and earned their place on the cobol-modernization trace.)
