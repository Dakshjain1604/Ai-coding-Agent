# Terminal-Bench harness

Runs CodingAgent on Terminal-Bench 2.0 tasks via [Harbor](https://harborframework.com),
with per-call HTTP tracing so every run reports latency, rate limiting, errors and tool use.

## Setup (once)
```bash
uv tool install harbor
colima start --cpu 4 --memory 5 --disk 80 --vm-type vz --vz-rosetta   # Docker; TB images are amd64
cd bench && harbor datasets download terminal-bench@2.0 && mv terminal-bench tasks
```
Colima only syncs bind mounts under `$HOME`, so jobs must live under `$HOME`; a jobs dir in
`/tmp` fails every trial with `RewardFileNotFoundError`.

## Run
```bash
bench/harbor_agent/build_bundle.sh amd64          # rebuild after any harness/tracer change
cd bench && PYTHONPATH=. harbor run -p tasks -i fix-git -i openssl-selfsigned-cert \
  -a harbor_agent.coding_agent:CodingAgent -m openrouter/nvidia/nemotron-3-ultra-550b-a55b:free \
  -o jobs --job-name <name> -n 1 -y --env-file ../.env
python3 analyze.py jobs/<name>
```
The agent is the headless harness (`coding-agent exec`, design in `docs/harness.md`). It uses
OpenRouter only, so only `OPENROUTER_API_KEY` is forwarded into the container. Optional:
`--ak reasoning_effort=high`, `--ak timeout_sec=600` (by default the timeout comes from the task's
agent timeout, minus a 45s margin).

Per trial, `jobs/<name>/<trial>/agent/` contains:
- `trajectory.jsonl`: every model call, retry, tool result and compaction
- `result.json`: status, usage, turns
- `agent.log`: timestamped progress
- `http.jsonl`: an independent HTTP-level trace
- `run.json`: process timing and exit code

`harbor run -a oracle` runs the reference solutions, which checks the setup separately from the agent.

Free OpenRouter models are capped at **50 requests/day** on accounts with under $5 of purchased
credit (1000/day otherwise). The cap resets at 00:00 UTC; a run that hits it ends immediately with
`quota_exhausted`.

Tests for the adapter: `~/.local/share/uv/tools/harbor/bin/python -m unittest bench/harbor_agent/test_coding_agent.py`

## Baseline — 2026-09-17, commit df02b17, Groq free tier (only key available)
| task | reward | agent s | rate-limit wait s | LLM s | ends because |
|---|---|---|---|---|---|
| fix-git (easy) | 0 | 332 | 305 | 11 | 300s internal agent timeout |
| cobol-modernization (easy) | 0 | 310 | 271 | 14 | 413 request > 8K TPM |
| log-summary-date-ranges | 0 | 249 | 220 | 17 | 413 request > 8K TPM |
| nginx-request-logging | 0 | 236 | 44 | 11 | SIGKILL during `search_content` on `/` |
| openssl-selfsigned-cert | 0 (3/6 tests) | 395 | 352 | 21 | 413 request > 8K TPM |

0/5 solved. 78% of agent time was rate-limit waiting, and none of the runs ended because of model quality.
Oracle solves fix-git in 36s.

## Experiment 1 — 2026-09-17, pinned `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`
1/5 solved (log-summary-date-ranges). fix-git and cobol-modernization **never got a model call**:
the account's free-model quota (50 requests/day without $5 of purchased credit) ran out partway
through nginx. Only 3 tasks are valid evidence.

| task | reward | agent s | calls | notes |
|---|---|---|---|---|
| log-summary-date-ranges | 1 | 376 | 16 | wrote the same file 3× in a row (257s of the 376s) |
| openssl-selfsigned-cert | 0 (5/6 tests) | 253 | 25 | step limit ended the run just as it verified its script |
| nginx-request-logging | 0 | 195 | 9 + 18×429 | 140s of plan → plan → spawn_subagent before any real work |

Issues found in the traces (evidence → fix):
1. **The model never sees its own tool calls.** Every assistant turn is stored as `''`, so the model
   gets "File written" without what it wrote, and re-writes and re-checks → carry `tool_calls` and
   `tool_call_id` through `ChatMessage` and the providers.
2. **Automatic plan/test pipeline.** Plan steps (40–140s) hand nothing to the code step
   ("Context from previous steps:" is empty). The planner lacks `shell_exec` but calls it anyway,
   nesting `spawn_subagent` fans out to 7 more subtasks, and the test step starts over in a fresh
   context → one agent with the full tool set on the run path.
3. **Iteration limits (code 12, test 10)** end the loop right after a tool call and discard its
   result → a step budget sized for terminal tasks, and never end with an unseen tool result.
4. **`shell_exec` hides the output of failed commands.** On a non-zero exit it returns
   `stderr || err.message`, so a script that prints its error to stdout shows the model only
   "Command failed" → always return the exit code, stdout and stderr.
5. **Bloated tool results.** Output appears twice (`output` + `metadata.stdout`), JSON-escaped →
   render tool results as plain text.
6. **Agent state written into the task workspace** (`.claude/memory.db`, `models-catalog.json` in
   `/app`), where the planner took them for project files → keep agent state out of cwd.
7. **Failures still exit 0.** The process exits 0 after "Task failed", so the harness can't tell a
   failure from a finish → non-zero exit on failure.
8. **Daily-quota 429s are retried** 9× (SDK plus agent) → fail fast on `free-models-per-day`.

## Harness rebuild — 2026-09-17 (no score yet)
The legacy agent was replaced by `coding-agent exec` (`docs/harness.md`), which fixes the root causes
behind all 8 issues above. Verified so far:
- 1,516 unit tests
- the shell tool in Terminal-Bench containers under bash, dash and busybox
- a local end-to-end task that completed with passing tests
- the Harbor path in-container: timeout derivation, trajectory, rejected-generation recovery
- the OpenRouter error path: the exhausted daily quota was classified in 1 attempt (1.1s),
  where the legacy agent retried it 9×

## Experiment 2 — 2026-09-18, harness, `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`
Same model as experiment 1, 20-turn cap per task (the free tier allows 50 requests/day).

| task | legacy agent (exp 1) | harness (exp 2) | agent s | turns | model s | tools |
|---|---|---|---|---|---|---|
| fix-git | 0 — never got a model call (quota), 0/2 tests on Groq | **1.0 — solved, 2/2 tests** | 116 | 15 | 105 | 13 bash, 1 editor |
| openssl-selfsigned-cert | 0 — 3/6 tests (Groq), 5/6 (exp 1) | 0 — **5/6 tests** | 103 | 17 | 81 | 13 bash, 3 editor |

No retries, no rate-limit waits, no truncation, no tool failures in either run; model time was 79–90% of
agent time (i.e. the harness itself adds almost nothing).

fix-git shows the transcript fix working: investigate (status → log → branch → stash → reflog), find the
dangling commit, cherry-pick, resolve the conflict with an exact-match edit, continue, verify both files.
No repeated work in 15 turns. The legacy agent ran `search_files` 7× and never called `git reflog`.

openssl's remaining failure is an agent-behavior finding, not a harness defect: the agent wrote
`check_cert.py` against the `cryptography` package, `pip install`ed it, and verified with
`python3 check_cert.py` — but the grader runs `python check_cert.py` from its own isolated pytest
environment, where that package is absent. Generic lesson (not task-specific): verifying a script with one
interpreter does not verify it; prefer the standard library over new dependencies, and check the artifact
with the interpreters/commands already present in the environment.

That lesson is now in the system prompt (`src/harness/prompt.ts`, step 5, with tests): the work is
checked in a fresh shell that inherits nothing from the session, so prefer what the environment already
provides and check a script with the command it will actually be launched with.

## Experiment 3 — 2026-09-19, harness, `openrouter/~z-ai/glm-flash-latest` (GLM 5.3 Flash, paid, ~$0.01/task)

**5/5 solved**, after two harness fixes that the traces forced (see below). Cost of the whole suite: ~$0.12.

| task | legacy agent (exp 1) | harness, final | turns | agent s | cost |
|---|---|---|---|---|---|
| fix-git | 0 | **1.0** (2/2 tests) | 13 | 323 | $0.014 |
| openssl-selfsigned-cert | 0 (5/6 tests) | **1.0** (6/6 tests) | 13 | 555 | $0.009 |
| log-summary-date-ranges | 1.0 | **1.0** (2/2 tests) | 11 | 158 | $0.007 |
| nginx-request-logging | 0 (0/8 tests) | **1.0** (8/8 tests) | 12 | 273 | $0.008 |
| cobol-modernization | 0 (1/3 tests) | **1.0** (3/3 tests) | 14 | 844 | $0.031 |

openssl passed on the first attempt of this experiment — the `python` vs `python3` prompt rule from
experiment 2 held (the model wrote a stdlib-only script and checked it the way the grader would).

### Two defects the traces exposed, and the fixes

**1. A model call could outlive the whole run.** fix-git and cobol each burned 92 minutes on a single
call: the laptop suspended mid-stream, so no timer fired and the idle detector (which measures gaps
between chunks) never saw a gap. The HTTP trace shows headers at 2.7s, then `closed_before_end` 92
minutes later.
→ A call is now bounded by the run deadline, compared against the wall clock on every chunk (a timer
is exactly what a suspended host defeats). The run ends cleanly as `timeout`. Benchmark runs are also
launched under `caffeinate -i -s`.

**2. The agent had no sense of its time budget, and it cost a task.** In two cobol runs it spent the
entire budget reverse-engineering COBOL byte-level semantics with probe programs — for edge cases the
grader never exercises — and never created `/app/program.py`, the whole deliverable.
→ Two steps, in order of what the evidence demanded:
  - every observation now ends with `[time: 5m elapsed, ~9m left]`, and the prompt says to get a
    working version in place before refining. **Not sufficient**: the next run read "~3m left" and
    kept probing.
  - the loop now *interrupts* at 50%, 25% and 10% of the budget remaining with an explicit time check
    ("is every artifact the task asked for actually in place and working?"). **This worked**: turns
    1–8 were the same exploration, the 50% check fired, and the very next turn wrote the 142-line
    `program.py`, then verified it against the COBOL output. 3/3 tests passed.

Both fixes are general (no task-specific rules) and each is pinned by tests that cite the trace behind it.

## Experiment 6 — 2026-09-19, 8 fresh medium tasks, GLM 5.3 Flash

First tasks not hand-iterated on, so this is honest coverage. **4/7 scored solved** (1 excluded — verifier
could not run):

| task | result | note |
|---|---|---|
| kv-store-grpc | **1.0** (7/7) | built a gRPC KV server from a .proto |
| pypi-server | **1.0** | built + served a package index |
| sqlite-db-truncate | **1.0** | recovered a header-truncated SQLite db from the raw b-tree page |
| regex-log | **1.0** | IPv4-gated date regex (needed a re-run; first verifier failed) |
| build-cython-ext | 0 | genuine miss: 10/11 tests, timed out on the last |
| crack-7z-hash | 0 | genuine miss: timed out (CPU-bound cracking, slow under QEMU) |
| polyglot-c-py | 0 | genuine miss — see finding below |
| git-multibranch | excluded | verifier's Python segfaulted under QEMU (SIGSEGV), never ran |

### Measurement defect fixed (mattered as much as any harness fix)
On this ARM Mac, the tasks' verifiers download and run a standalone x86 CPython via `uv` under QEMU
emulation. That fails three ways, none of them the agent's fault: (1) the 33 MB download exceeds uv's 30s
timeout on the slow emulated network; (2) the downloaded binary segfaults when run under emulation;
(3) the uv installer misreads the platform. 5 of 12 verifier runs failed this way. `analyze.py` now
detects all three signatures and reports them as `verifier did not run`, excluded from the solved/scored
denominator — so a broken verifier is never counted as an agent failure. Reliable local scoring really
needs native x86 (a cloud runner or the official leaderboard infra); this laptop is only good for
per-trajectory debugging.

### Agent finding → fix (polyglot-c-py)
The agent's polyglot was correct, but during verification it compiled with `gcc … -o /app/polyglot/cmain`,
and the test requires `/app/polyglot` to contain exactly `main.py.c`; the leftover `cmain` failed it.
Generic lesson: verification must not pollute the deliverable directory. The prompt now says to build and
test in a scratch location and confirm the deliverable holds only what was asked for (step 4, with a test
pinned to this trace). Not yet re-measured.

Genuine remaining failures to study when a reliable x86 verifier is available: build-cython-ext (1 heavy
test), crack-7z-hash (CPU-bound), and a re-verify of polyglot-c-py with the cleanup rule in place.

## Local verifier fix for python:3.13-slim tasks (2026-09-19)
`bench/fix_verifier_python.sh` injects `UV_PYTHON_PREFERENCE=only-system` into the `[environment]` of the
41 `python:3.13-slim` task copies (gitignored-local). Their verifiers then use the image's working system
Python 3.13 instead of the uv-downloaded standalone x86 build that segfaults/times out under QEMU. Same
Python version, same pytest, same tests — only the interpreter source changes. Proven with `harbor -a oracle`
on count-dataset-tokens (reward 1.0, verifier clean, no download, no SIGSEGV). ubuntu:24.04 tasks remain
unscoreable locally (system Python 3.12 ≠ the verifier's required 3.13).

## Experiment 7 — 2026-09-19, 7 fresh python:3.13-slim medium tasks, reliable verifier, GLM 5.3 Flash

**4/7 solved, all 7 verifiers ran (0 excluded).** First fully-clean medium measurement.

| task | result | note |
|---|---|---|
| count-dataset-tokens | **1.0** | read a HF dataset README, used the right subset, counted tokens |
| large-scale-text-editing | **1.0** (5/5) | vim-macro-only edit under command restrictions |
| largest-eigenval | **1.0** (27/27) | called LAPACK dgeev directly for speed |
| modernize-scientific-stack | **1.0** | Python 2→3 rewrite, 4 turns |
| filter-js-from-html | 0 (1/2) | genuine: filter too aggressive, modified 5/12 clean files |
| gcode-to-text | 0 (1/2) | genuine: decoded toolpath geometry but not the hidden message |
| break-filter-js-from-html | 0 (0/1) | genuine: mutation-XSS bypass not found |

The three failures are the model's capability limits on hard tasks, correctly graded by working verifiers —
not harness defects. Deliberately not patching the harness for these (that would overfit to tasks).

### Honestly-measured tally on python:3.13-slim medium tasks (reliable verifier)
exp6 (4/5: build-cython-ext 10/11 miss; kv-store-grpc, pypi-server, sqlite-db-truncate, regex-log solved)
plus exp7 (4/7) → **8/12 solved (~67%)** across 12 distinct fresh medium tasks. This is the real signal;
the earlier 5 easy tasks were hand-iterated and are not a fair sample.
