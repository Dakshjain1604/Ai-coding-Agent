# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
- **Providers** (`src/providers/`): Multi-provider fallback chain (Ollama, Codex, OpenAI, Gemini, Groq, OpenRouter, HuggingFace, Local)
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