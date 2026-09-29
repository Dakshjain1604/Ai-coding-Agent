# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodingAgent is a CLI coding assistant that helps developers with code generation, debugging, testing, and review. It uses a multi-provider LLM system with fallback chain (Ollama, Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, HuggingFace), a universal AI agent with mode-switching, session-scoped memory, and a permission-guarded tool layer.

## Common Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format

# Run the CLI (full version - requires LLM provider config)
node bin/run.js run "your task here"

# Run the lightweight version (template-based, no API keys needed)
node bin/run.light.js run "create a nodejs login backend" --output-dir ./project --force

# Start interactive mode
node bin/run.js
# or
node bin/run.js -i
```

## Architecture

```
CLI Layer → Orchestration Layer → Universal Agent → Tool Layer
```

### Core Components

- **CLI Layer** (`src/cli/`): Interactive mode (REPL), oclif commands (run/debug/test/review/apply), permission system
- **Orchestration** (`src/core/orchestrator/`): TaskAnalyzer, AgentSpawner, PlanManager
- **Universal Agent** (`src/core/agents/UniversalAgent.ts`): Single agent with mode switching (code/debug/test/review/plan)
- **Providers** (`src/providers/`): Multi-provider fallback chain (Ollama, Claude, OpenAI, Gemini, Groq, OpenRouter, HuggingFace, Local)
- **Tools** (`src/core/tools/`): File system, shell execution, git operations, test runner, code search
- **Memory** (`src/memory/`): SQLiteStore, SessionCache, MemoryManager, ProjectMemory
- **Hooks** (`src/hooks/`): pre-tool-use, post-tool-use, on-error hooks
- **Skills** (`src/skills/`): Custom skill system with registry and loader

### Key Design Principles

1. **Local-first**: Ollama runs on device, no API keys required to start
2. **Free-tier optimized**: Works with free providers (Ollama + Groq + OpenRouter)
3. **Single agent, mode switching**: One model instance with role switching via system prompt
4. **Session-scoped I/O**: Memory loads once at session start, writes once at session end
5. **Sandbox-safe**: Agent writes to isolated output directory, applied via `apply` command

### LLM Provider Configuration

Set environment variables to enable providers:
- **Ollama**: `ollama serve` + `ollama pull qwen2.5-coder:latest`
- **Anthropic**: `ANTHROPIC_API_KEY`
- **OpenAI**: `OPENAI_API_KEY`
- **Google**: `GOOGLE_API_KEY`
- **Groq**: `GROQ_API_KEY`
- **OpenRouter**: `OPENROUTER_API_KEY`
- **HuggingFace**: `HF_TOKEN`

## Engineering Preferences

From the project owner:

- **DRY is important** — flag repetition aggressively
- **Well-tested code is non-negotiable** — prefer too many tests over too few
- Code should be "engineered enough": not under-engineered (fragile) or over-engineered (premature abstraction)
- Bias toward handling more edge cases, not fewer — thoroughness > speed
- Bias toward explicit over clever

## Agent Engineering Guidelines

These guidelines apply to all work performed in this repository.

### Think Before You Build

- Understand the problem, its constraints, existing architecture, and the intended user outcome before changing code.
- Inspect the relevant code and tests before proposing an implementation. Do not make assumptions where the repository can provide the answer.
- Prefer a clear, small design that fully solves the stated problem. Do not add abstractions, dependencies, configuration, or complexity without a concrete need.
- Consider correctness, maintainability, security, performance, failure modes, and backwards compatibility in proportion to the change.
- When requirements are ambiguous or carry meaningful product trade-offs, surface the assumptions and ask for direction rather than silently choosing a risky interpretation.

### Clean, Human-Readable Code

- Write code that a competent human maintainer can quickly understand, review, debug, and modify.
- Use clear names, small focused functions, explicit control flow, consistent formatting, and meaningful module boundaries.
- Follow the repository's established conventions unless there is a strong, documented reason to improve them.
- Keep business logic simple. Favor direct solutions over cleverness or speculative generalization.
- Avoid duplication when a shared abstraction genuinely improves clarity. Avoid premature abstraction when it hides straightforward behavior.
- Handle expected errors deliberately, with useful messages and safe behavior. Do not swallow errors or rely on unexplained magic values.
- Document decisions, invariants, public interfaces, and non-obvious trade-offs. Do not use comments to compensate for confusing code that can be made clearer instead.

### Robust Engineering Without Unnecessary Complexity

- Build production-quality solutions: validate inputs at appropriate boundaries, preserve important invariants, account for realistic edge cases, and keep interfaces stable.
- Engineer for the actual requirements and credible future needs, not hypothetical scenarios. Robustness must not become overengineering.
- Reuse proven repository patterns and existing utilities before introducing new frameworks or bespoke infrastructure.
- Keep changes focused. Do not mix unrelated refactors, formatting churn, or feature work into the same change unless necessary for correctness.

### Research Before Adding Something New

For each material new feature, dependency, integration, architectural pattern, or unfamiliar technology:

1. Define the problem, success criteria, constraints, and alternatives.
2. Research the relevant documentation, existing codebase patterns, security and maintenance implications, and viable implementation options.
3. Use subagents for independent research, design review, or risk analysis when the change is non-trivial. Give each subagent a focused question and synthesize their findings rather than blindly combining recommendations.
4. Choose the simplest option that meets the requirements, and record significant decisions and trade-offs in the change documentation or pull request.
5. Prototype or validate uncertain assumptions before committing to a broad implementation.

Do not require subagents for trivial, well-understood edits. Use them where independent investigation materially improves confidence, coverage, or design quality.

### Testing and Verification

- Add or update automated tests for every behavior change. Cover the normal path, important boundaries, failures, regressions, and integration points appropriate to the scope.
- Run the relevant formatter, linter, type checker, unit tests, integration tests, and end-to-end tests when available and applicable.
- Verify the delivered behavior end to end from the perspective of the real user or caller, not only through isolated unit tests.
- Do not claim a change is complete, tested, or verified unless the corresponding checks actually ran and their outcomes are known.
- If a required check cannot run, state exactly what was not run, why, the expected risk, and how it should be validated.

### Completion Standard

Before considering work complete, confirm that:

- The implementation meets the stated requirements and preserves relevant existing behavior.
- The code is readable, idiomatic for this repository, and no more complex than necessary.
- Design choices and assumptions have been checked, including research or subagent review where warranted.
- Tests and quality checks have passed, with end-to-end verification performed where applicable.
- Documentation, configuration, migrations, observability, and rollback considerations are updated when the change requires them.
- The final report accurately distinguishes completed verification from checks that remain outstanding.

Quality is not optional: think carefully, research proportionately, implement cleanly, test thoroughly, and verify the result before declaring success.

## Review Guidelines

When reviewing code changes:

1. **Architecture Review**: System design, component boundaries, dependency graph, data flow, security
2. **Code Quality**: Module structure, DRY violations, error handling, technical debt
3. **Test Review**: Coverage gaps, assertion strength, edge case coverage, failure modes
4. **Performance**: N+1 queries, memory usage, caching opportunities

For each issue found:
1. Describe the problem with file/line references
2. Present 2-3 options with tradeoffs (implementation effort, risk, impact)
3. Give recommended option and explain why
4. Ask for user input before proceeding

## CLI Commands

- `run` — Execute a coding task
- `debug` — Debug existing code
- `test` — Generate or run tests
- `review` — Review code changes
- `apply` — Apply pending changes from output directory
- `config` — Manage configuration
- `simplify` — Simplify/refactor code (custom skill)