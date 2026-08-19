# SWE-bench task: astropy__astropy-14182

## Task selection

Source: same `princeton-nlp/SWE-bench_Lite` dataset used for
`astropy__astropy-12907`. Picked as the second, unbiased task to continue the
same no-hints, run-live, fix-root-causes methodology — not cherry-picked for
difficulty either way.

## Ground truth

- **Repo**: `astropy/astropy` @ `a5917978be39d13cd90b517e1de4e7a539ffaa48`
- **Issue** (verbatim, `problem_statement.txt`): `RST.write()` doesn't accept
  a `header_rows` kwarg, so `tbl.write(..., format="ascii.rst",
  header_rows=["name", "unit"])` raises `TypeError: RST.__init__() got an
  unexpected keyword argument 'header_rows'`, even though the sibling
  `ascii.fixed_width` format already supports it.
- **`FAIL_TO_PASS`**: `astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows`
- **`PASS_TO_PASS`**: 9 other cases in the same file.
- **Golden patch** (`golden_patch.diff`): `RST.__init__` gains a `header_rows`
  parameter forwarded to `FixedWidth.__init__`; `RST.write()`/`RST.read()`
  compute the separator-line index from `len(self.header.header_rows)`
  instead of a hardcoded `1`/`3`, since a multi-row header shifts where the
  RST `====` separator actually falls.

## Environment

Cloned from the task-1 repo's local copy, re-pointed at the real
`astropy/astropy` remote, checked out at the exact base commit. Same Python
3.9 + pinned numpy/Cython/setuptools build as task 1, plus one new build
workaround: vendored `cfitsio`/`zlib` C code in `astropy/io/fits` redefines
`fdopen` as a macro that conflicts with the modern macOS SDK's real
declaration (`astropy/io/fits/setup_package.py` temporarily renamed to
`.disabled` during `build_ext`, restored after — that extension has zero
dependency on the RST writer this task touches).

## Summary

**7 live agent runs** against this task this session, each run's failure
traced to a real root cause and fixed in the coding agent itself (not the
astropy target repo), verified via `tsc --noEmit`, the full `vitest` suite,
and a fresh live re-run — the same discipline applied to every fix in task 1.
**5 real bugs found and fixed.** The task has not yet completed successfully
end-to-end, but the last run got substantially further than any before it —
the agent (running on NVIDIA's `z-ai/glm-5.2`, reached via provider fallback)
correctly read `rst.py`, `test_rst.py`, and `fixedwidth.py`, and correctly
noticed the hidden `test_rst_with_header_rows` test already exists — before
being blocked by simultaneous real quota exhaustion across all 3 configured
network providers (see "Current blocker" below).

## Bugs found and fixed, in the order they were hit

### 1. Context-budget/output-length conflation (`agent_run_1.log`)

`BaseAgent.getDefaultConfig()` sized `maxTokens` — used for BOTH context/
history truncation AND the provider's output-length reservation — from
`SystemAnalyzer`'s **local machine load** (8000 tokens on this session's
"critical"-status dev machine), regardless of whether the actual serving
provider was a local Ollama model or a cloud API with a 128K+ context
window. Live symptom: `WARN Context usage reached 114-115% (.../8000
tokens)`, alongside 17 unproductive `search_files`/`search_content` calls
that never reached `file_read`/`file_write`.

**Fix**: split `AgentConfig.maxTokens` (context budget) from a new
`outputMaxTokens` (generation length, fixed default 4096).
`BaseAgent.initializeContext()` now re-derives `maxTokens` from the
resolved provider's real `getCapabilities().maxContextLength` once routing
is known, for any non-`"local"` provider. Verified: no context-usage
warnings in any of the 6 subsequent live runs.
(`src/utils/types.ts`, `src/core/agents/BaseAgent.ts`,
`tests/unit/base-agent-context-budget.test.ts`, 3 tests)

### 2. Incomplete tool-call attempts silently discarded as "task done" (`agent_run_2.log`)

A free-tier OpenRouter model's response was cut off mid-generation inside a
` ```tool\nfile_write\n{...} ` block — the JSON's `content` string value (and
the outer object) never closed. `parseToolCalls()` correctly refused to
guess at the incomplete JSON, but `UniversalAgent`'s main loop treated
"zero parsed tool calls" as unconditionally meaning "the model is
finished," silently ending the task without ever writing the fix — no
error, no retry, no indication anything had gone wrong.

**Fix**: new `hasIncompleteToolCallAttempt()` in `tool-parser.ts` detects a
` ```tool ` fence naming a real, known tool even when the JSON body didn't
parse. `UniversalAgent` now nudges the model to retry (bounded, sharing the
existing blank-response retry budget) instead of silently finishing.
(`src/core/agents/tool-parser.ts`, `src/core/agents/BaseAgent.ts`,
`src/core/agents/UniversalAgent.ts`, `tests/unit/tool-parser.test.ts` +6,
`tests/unit/incomplete-tool-call-retry.test.ts`, 3 tests)

### 3. Blank-response retry counter never reset on progress (`agent_run_3.log`)

The bounded blank-response retry budget (`blankResponseRetries`,
max 2) only ever incremented — it was never reset after a genuinely
productive turn. Live sequence: blank → successful `file_read` → blank →
blank → task failed with **"3 consecutive empty responses"**, but only 2 of
those 3 blanks were actually consecutive; a real, productive tool call sat
between the first blank and the other two. The error message's own claim
was false.

**Fix**: reset the counter to 0 whenever a turn produces a real, parsed
tool call. Verified live afterward: the exact same failure message now only
fires after genuinely 3 consecutive blanks post-reset.
(`src/core/agents/UniversalAgent.ts`,
`tests/unit/incomplete-tool-call-retry.test.ts`, 1 test reproducing the
non-consecutive-blanks scenario verbatim)

### 4. Unreliable free model set as the OpenRouter default (`agent_run_4.log`, `agent_run_5.log`)

`openai/gpt-oss-20b:free` was the `"default"` tier's model for every task
category on OpenRouter. Live evidence across **6+ separate runs spanning
both SWE-bench tasks**: this specific free model reliably returned a
completely empty completion on real tool-heavy conversations, every single
time real traffic landed on it — while `google/gemma-4-31b-it:free`
(already used for the `"quality"` tier) produced real, valid content every
time it was reached in the same runs, via OpenRouter's own server-side
`models` fallback list.

**Fix**: swapped the `"default"` tier (and `OPENROUTER_FREE_TOOL_MODELS`'s
ordering, which drives `OpenRouterProvider`'s constructor default) to
`google/gemma-4-31b-it:free`. Verified live in `agent_run_6.log`: OpenRouter
fallback correctly switched to gemma and produced real content, until it
hit its own separate rate limit unrelated to model choice.
(`src/providers/ProviderRegistry.ts`, `src/providers/OpenRouterProvider.ts`,
`tests/unit/openrouter-provider.test.ts`)

### 5. Dynamic fallback only tried ONE alternate provider per LLM call (`agent_run_6.log`)

`attemptDynamicFallback()`'s `hasFallenBack` boolean permanently blocked a
second fallback attempt within the same LLM-call iteration, no matter how
many providers were actually configured. Live sequence: groq hit its daily
quota, fell back to OpenRouter, OpenRouter **also** hit its own separate
daily quota within the same iteration — and the task failed outright
without ever trying NVIDIA, a third, distinctly-quota'd provider that was
fully configured and available.

**Fix**: replaced the boolean with an accumulating `Set<ProviderType>` of
providers excluded so far this iteration, so a second (or third) fallback
failure can still reach an untried provider. **Verified live in
`agent_run_7.log`**: the chain correctly went groq → openrouter → **NVIDIA
(`openai/z-ai/glm-5.2`)**, which then made real, correct progress — reading
`rst.py`, `test_rst.py`, `fixedwidth.py`, and correctly noticing the hidden
`test_rst_with_header_rows` test already exists in the test file — before
NVIDIA itself hit a rate limit on a later call, and a second full pass
through all 4 providers (local unavailable, groq/openrouter/NVIDIA all
genuinely exhausted this time) correctly exhausted before failing.
(`src/core/agents/UniversalAgent.ts`,
`tests/e2e/retry-loop.test.ts`, 1 test chaining a 3rd provider)

## Current blocker (not a code bug)

`agent_run_7.log` ends with all three real network providers simultaneously
rate-limited/quota-exhausted from this session's own heavy live-testing
volume today (7 runs against this task alone, plus the full task-1 session
earlier): Groq's daily token quota, OpenRouter's daily free-model-request
quota (`429 Rate limit exceeded: free-models-per-day`), and NVIDIA's
per-minute rate limit all hit within the same run. This is external,
real-account capacity, not something further code changes fix — the system
is now doing exactly the right thing (chain through every configured
provider, only fail once all are genuinely exhausted) rather than masking
or mis-attributing the failure.

## Next steps

- Re-run live once quotas reset (Groq/OpenRouter reset daily; NVIDIA's
  window is shorter) to get an end-to-end pass/fail verdict against the
  real `test_rst_with_header_rows` + 9 `PASS_TO_PASS` tests.
- Everything upstream of the quota wall is now verified working: context
  budgeting, tool-call parsing robustness, retry-budget accuracy, model
  selection, and multi-provider fallback chaining all held up under real,
  adversarial live conditions this session surfaced.
