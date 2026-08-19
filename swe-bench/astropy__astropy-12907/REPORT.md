# SWE-bench task: astropy__astropy-12907

## Task selection

Source: `princeton-nlp/SWE-bench_Lite`, test split, **row 0** (fetched live via the
Hugging Face datasets-server API). No searching for an easy or hard instance —
this is simply the first task in the standard dataset ordering. It happens to
have a one-line golden fix, which is why it was picked for a first "simple" run.

## Ground truth

- **Repo**: `astropy/astropy` @ `d16bfe05a744909de4b27f5875fe0d4ed41ce607`
- **Issue** (verbatim, `problem_statement.txt`): `separability_matrix` computes
  the wrong result for a **nested** `CompoundModel` — e.g.
  `m.Pix2Sky_TAN() & (m.Linear1D(10) & m.Linear1D(5))` reports the two inner
  `Linear1D` outputs as non-separable, when they should be independent.
- **`FAIL_TO_PASS`** (must go from failing to passing):
  - `test_separable.py::test_separable[compound_model6-result6]`
  - `test_separable.py::test_separable[compound_model9-result9]`
- **`PASS_TO_PASS`**: 13 other cases in the same file (must stay passing —
  regression check).
- **Golden patch** (`golden_patch.diff`) — one line, in `_cstack()`, the
  function that builds the separability matrix for the `&` (parallel/"and")
  compound operator:
  ```diff
  -        cright[-right.shape[0]:, -right.shape[1]:] = 1
  +        cright[-right.shape[0]:, -right.shape[1]:] = right
  ```
  The old code stamped a block of `1`s into the corner of the matrix instead
  of copying the right-hand submodel's *own* separability matrix in — so a
  nested compound's inner structure got flattened into "everything is
  coupled," regardless of what the inner model actually looked like.

## Environment

Real repo clone, `test_patch` applied (adds the two hidden test cases),
extensions actually built (Python 3.9 + numpy<1.23 + pinned Cython/setuptools
matching the astropy-4.3 era — modern Python 3.12/3.13 can't build this
codebase's C/Cython extensions at all; see harness notes at the bottom).
Verified the baseline reproduces the exact expected failure signature before
running the agent: 2 failed (the FAIL_TO_PASS pair), 13 passed.

## Run 1 — normal path (`node bin/run.js run "<issue text>" --no-confirm`)

No hints given beyond the raw issue text, exactly as pasted above.

- **TaskAnalyzer classification**: `complexity: "simple"`, strategy
  `{mode:"single", agents:["orchestrator"]}` → routed to **one** agent,
  internally mapped to **`plan` mode** (a mode whose tool set has no
  `file_write` — it's meant to produce a plan for a later stage to execute,
  but "single" strategy never spawns that later stage).
- **What it did**: **zero tool calls.** It never opened a single file. It
  answered the issue directly, like a chat assistant, using its own
  pretrained knowledge of astropy:
  > "Nested `CompoundModel`s are treated as a single block by the current
  > implementation... Flatten the model first... No bug-fix is needed in
  > your own code."
  It then suggested the user work around it in *their own* script, and
  optionally file a bug report.
- **This explanation is also factually wrong.** The real bug is in
  `_cstack()`'s handling of the `&` operator (a one-character typo: `1`
  instead of `right`), not a "flattening" limitation. The model produced a
  plausible-sounding but incorrect diagnosis, confidently, without ever
  checking it against the actual source.
- **Result**: `success: true`, 0 files changed, 2 LLM calls, 9 seconds total.

## Run 2 — diagnostic: same task, forced into `debug` mode

To find out whether "answered like a chatbot" was specific to the
misrouted `plan` mode, or would happen regardless of mode, the same exact
task was re-run bypassing `TaskAnalyzer` (`task.metadata.command = "debug"`,
which `AgentSpawner` routes straight to a single `debug`-mode agent — a mode
that *does* have `file_read`/`file_write`/`grep`/`search_content`).

- **What it did**: correctly went and read `astropy/modeling/separable.py`
  — the right file, first try, no exploration needed. Then, on the very
  next turn (after seeing the file's contents), **it returned an empty
  response** — `0` completion tokens, no text, no further tool calls.
- **The execution loop treated that empty response as "nothing more to
  do" and returned `success: true` with a blank output.** No error, no
  retry, no signal anything went wrong — just a silent no-op reported as a
  success.
- **Result**: `success: true`, 0 files changed, empty output, 2 LLM calls,
  <5 seconds.

## Verification

Neither run touched the repo (confirmed via `git status`/`git diff` before
and after each run — zero files modified in both cases). Re-running the
actual `FAIL_TO_PASS` tests afterward reproduces the exact original failure:

```
FAILED test_separable.py::test_separable[compound_model6-result6]
FAILED test_separable.py::test_separable[compound_model9-result9]
2 failed, 13 passed
```

**Neither attempt resolved the issue.** Both were reported as `success: true`
by the agent's own accounting.

## Root causes (not just "the model isn't smart enough")

### 1. `TaskAnalyzer`'s complexity classifier is tuned for synthetic,
   imperative task text, not real bug reports

It scores complexity almost entirely from `String.includes()` checks against
a small vocabulary — `"create"`, `"add"`, `"fix"`, `"file"`, `"module"`,
`"test"`, etc. (`src/core/orchestrator/TaskAnalyzer.ts`). A real GitHub issue
is usually phrased as an *observation* ("X does not compute Y correctly...
this feels like a bug to me, but I might be missing something?"), not a
command. None of those trigger words appear anywhere in this issue's text —
confirmed: zero matches for the entire keyword set. Every factor
(`scope`, `implementation`, `testing`) fell through to its lowest-complexity
default, producing a complexity score of 0.19 (well under the 0.3 "simple"
cutoff) for a task that requires real cross-file investigation in an
unfamiliar codebase — objectively *harder* than the "create a file called
hello.txt" task from earlier this session, which scored "medium" and got a
3-stage pipeline.

**Worse, it isn't just miscalibrated — it has a live false-positive bug.**
`analyzeScope()` matched `"line"` as a substring and classified this as
**"Line-level scope"** (the *lowest* complexity tier, meant for one-line
typo fixes) — not because the issue mentions anything about a single line,
but because the issue's example code repeatedly references astropy's
`Linear1D` model class, and `"linear1d".includes("line")` is `true`. A
domain-specific class name silently corrupted the classification. This isn't
a one-off: any of ~40 short trigger substrings (`"line"`, `"add"`, `"file"`,
`"test"`, `"api"`, ...) can collide with an identifier that happens to
contain them, in any real codebase's vocabulary, with no word-boundary
check to prevent it.

**Consequence**: this task got a single, unsupervised, unverified shot with
an agent mode (`plan`) that structurally cannot make code changes even if it
tried — not because the task was actually simple, but because of a
scoring artifact.

### 2. The execution loop can't tell "a real final answer" from "the model
   said nothing," and treats both as success

`UniversalAgent.execute()`'s turn loop (`src/core/agents/UniversalAgent.ts`,
~line 448-462): whenever a turn produces zero tool calls, it's treated as
"the agent is done" and the loop breaks — then unconditionally returns
`this.complete(true, lastOutput)`. There is no check anywhere for whether
`lastOutput` is actually a substantive answer versus a blank string. A model
that returns nothing (Groq's `gpt-oss-20b` did exactly this on the very next
turn after a tool result — plausibly its "reasoning" channel absorbed the
turn and nothing surfaced in the regular content field) is indistinguishable,
to this code, from a model that correctly decided "I'm finished, here's my
conclusion." Both produce `success: true`.

This is strictly worse than a visible failure: a crash or an exception at
least surfaces as an error the retry/fallback machinery can react to. A
silent empty "success" doesn't — it looks, from the outside, exactly like
the task being trivially already-done.

### Why these two compound each other

Bug #1 (misrouting) put this task on a single unverified attempt with no
safety net. Bug #2 (empty-response-is-success) means that even when routed
somewhere with the right tools (`debug` mode did find the correct file),
a single bad turn from the model — with no retry, no distinguishing signal —
silently ends the task as a reported success. Fixing only one of these
would still leave real SWE-bench-style tasks exposed to the other.

## Follow-up: fixes applied, re-verified live (same task, same repo, same key)

Per feedback ("update the model, enhance the prompt when needed"), fixed the
two root causes above plus several more found in the process of trying to
actually fix them — each confirmed against the real, previously-observed
failure before the fix, then re-run live afterward:

1. **`AgentSpawner`'s `agentKeywords`: `"complex"` as an `orchestrator`
   trigger.** The issue's own prose ("If I make the model more complex...")
   matched it, routing to `plan` mode via an early-return that runs BEFORE
   the complexity-score switch even executes — this was the direct,
   proximate cause of the original misrouting, independent of the raw
   complexity score. Removed `"complex"`; `"coordinate"/"orchestrate"/
   "multi-step"` are specific enough on their own.
2. **`TaskAnalyzer`: raw `.includes()` substring matching everywhere**, not
   just the one `"line"`/`Linear1D` collision already found — replaced with
   word-boundary matching throughout the file (`analyzeScope`,
   `countDomains`, `analyzeImplementation`, `analyzeTesting`,
   `estimateDependencies`, `estimateFileCount`, `determineStrategy`,
   `identifyParallelAgents`, `analyzeRiskFactors`). Also found `"one"` as an
   unguarded substring (matches "someone", "done", "phone", ...).
3. **`analyzeImplementation`: added a code-block-presence signal.** A real
   bug report matches none of the imperative-verb keywords (they're
   observations, not commands) — but usually contains runnable code
   demonstrating the problem. That combination now scores as real
   investigative work instead of "assumed simple".
4. **`agentKeywords.debug` didn't include the bare word `"bug"`** — only
   `"fix bug"`/`"debug"`/`"issue"`/`"problem"`/`"diagnose"`. A report that
   literally says "this feels like a bug to me" matched none of them and
   fell through to `code` mode's switch-statement default, which meant it
   never got `debug`'s task category ("reasoning") — and so never got fix
   #6 below either. Added `"bug"` (safe from the word-boundary fix — it
   doesn't match inside "debug"/"debugging").
5. **`UniversalAgent.execute()`'s empty-response handling** (already
   described above) — implemented: a blank turn (no text, no tool calls)
   now gets nudged up to twice before the task honestly fails, instead of
   silently reporting success. Confirmed BOTH directions live: one real run
   nudged twice and then correctly gave up with `success:false` and a clear
   message; a later run nudged twice and successfully recovered on the
   third attempt with real output.
6. **Wired up `ModelRouter`'s already-implemented but never-called
   `preferQuality` option** (-> `ProviderRegistry`'s "quality" tier, e.g.
   Groq's `openai/gpt-oss-120b` instead of the default `-20b`) for
   `BaseAgent.initializeContext()`'s "reasoning"/"complex" task categories,
   and for `attemptDynamicFallback()`'s mid-task provider switch.
7. **`routeToFallback()` never read `preferQuality` at all** — found only
   by testing fix #6 live: Groq's real daily quota (200,000 TPD) was
   exhausted from this whole session's testing, forcing a genuine fallback
   to OpenRouter on every live run, and the fallback path silently dropped
   back to the default-tier model regardless of what the primary routing
   decision had asked for. Fixed by threading `preferQuality` through
   `routeToFallback`/`routeToBest` too.
8. **OpenRouter's own "quality"/"speed" tier model IDs in
   `ProviderRegistry.ts` were themselves PAID models** (no `:free` suffix)
   — unreachable on a free-tier-only key, same mistake as the earlier dead
   default-model bug, just in a different tier. Replaced with the largest
   of the three confirmed-live-working free models
   (`google/gemma-4-31b-it:free`) for "quality", and the confirmed-free
   `nvidia/nemotron-nano-9b-v2:free` for "speed" (previously
   `meta-llama/llama-3.1-8b-instruct`, also paid).
9. **`AgentSpawner`'s spawn timeout is purely system-load-derived** (as low
   as 120s under "critical" status — this dev machine's actual live status,
   from memory pressure) with no awareness that reasoning-category tasks
   now deliberately use a slower, larger model. A real investigative run's
   LLM calls alone took ~4 minutes, comfortably inside 5 minutes but past
   120s, and got cut off mid-investigation. Added a 5-minute floor for
   `debug`/`plan`/`orchestrator` agent types.
10. **System prompts**: added a shared "investigate before you answer"
    instruction to all five modes, directly targeting the original failure
    (answering a question-phrased bug report from pretrained knowledge
    instead of reading the actual code) — confirmed the model DOES now
    read the relevant file and search the codebase before answering, in
    every live re-run after this fix.

**Live re-verification results** (5 more real runs against the same task,
same repo, same key, interspersed with each fix): routing now correctly
reaches `debug` mode with real file-editing tools; the model now genuinely
investigates (reads `separable.py`, searches for relevant code) before
answering, every time; the quality-tier model upgrade is now reachable even
through a mid-task fallback. The agent's own diagnosis of the bug's
mechanism has visibly improved between runs (from a fully hallucinated,
zero-investigation, factually wrong explanation in the very first run, to a
grounded but still slightly-off explanation after routing/prompt fixes, to
a specific, plausible, code-referencing proposed fix — citing the actual
`_coord_matrix`/`Mapping` logic in the real file it read — in the latest
run) but **still stopped short of calling `file_write` to actually apply
it**, describing the fix rather than making it. The task has not yet been
fully resolved (`FAIL_TO_PASS` tests still fail) — this remains open.

Two further constraints surfaced only by testing live, not fixable in code:
Groq's real per-key daily quota (200,000 tokens/day) is now exhausted from
this whole session's cumulative testing, and OpenRouter's genuinely free
model tier tops out around 20-31B parameters — there is currently no
larger free option reachable with this project's keys to test whether a
meaningfully bigger model would close the remaining "describes but doesn't
apply the fix" gap.

## Harness notes (not agent bugs — my own test-setup friction)

Building astropy 4.3-era C/Cython extensions required Python 3.9 specifically
(Python 3.12/3.13's setuptools no longer support the `distutils`/
`setuptools.dep_util` APIs this build system uses, and modern clang rejects
some of the old C code's implicit pointer casts by default). Installed via
`brew install python@3.9` and pinned `numpy<1.23`, `setuptools<60`,
`cython==0.29.22`, `extension-helpers<1` to match the era. This is exactly
the kind of environment-pinning problem SWE-bench's own Docker-based harness
exists to avoid — noted here for transparency, not as something the coding
agent was ever asked to solve itself.
