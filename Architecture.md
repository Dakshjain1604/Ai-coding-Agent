# CodingAgent — Revised Architecture
> Version 2.0 · Post Council Review · Replaces Architecture v1.0

---

## Overview

CodingAgent is a CLI coding assistant that helps developers with code generation, debugging, testing, and review. It uses a single universal AI agent with mode-switching, a session-scoped memory system, a dynamic provider fallback chain, and a permission-guarded tool layer. It is designed to run efficiently on consumer hardware (8–16GB RAM) using free LLM providers (local Ollama, Groq free tier, OpenRouter free models).

### Design Principles

1. **Local-first** — Ollama runs on device. No API keys required to get started. Privacy-preserving.
2. **Free-tier optimized** — Full capability using only free providers (Ollama + Groq + OpenRouter).
3. **Single agent, mode switching** — One model instance, one context window, role switching via system prompt. No multi-agent overhead.
4. **Session-scoped I/O** — Memory reads once at session start, writes once at session end. Zero I/O in the hot path.
5. **System-aware** — Token limits, model size, and concurrency automatically adapt to available RAM.
6. **Sandbox-safe** — All agent writes go to an isolated output directory. Changes are previewed and applied explicitly via `coding-agent apply`.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLI Layer                                        │
│                                                                               │
│  ┌─────────────────────┐  ┌───────────────────────┐  ┌─────────────────────┐ │
│  │  Interactive Mode   │  │  oclif Commands        │  │  Permission System  │ │
│  │  (REPL)             │  │                        │  │                     │ │
│  │  - Streaming output │  │  run / debug / test    │  │  - shell ops        │ │
│  │  - Mode detection   │  │  review / plan         │  │  - git ops          │ │
│  │  - /config /tasks   │  │  apply / tasks         │  │  - file delete      │ │
│  │  - Progress display │  │                        │  │  - Yes/Always/No    │ │
│  └──────────┬──────────┘  └──────────┬────────────┘  └──────────┬──────────┘ │
└─────────────┼──────────────────────┼───────────────────────────┼─────────────┘
              │                      │                            │
              ▼                      ▼                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Orchestration Layer                                   │
│                                                                               │
│  ┌──────────────────────┐   ┌────────────────────┐   ┌────────────────────┐  │
│  │   Task Analyzer      │   │   Agent Spawner     │   │   Plan Manager     │  │
│  │   (HEURISTIC ONLY)   │   │   (simplified)      │   │                    │  │
│  │                      │   │                     │   │  - Task planning   │  │
│  │  - File count        │   │  - Always returns   │   │  - Step execution  │  │
│  │  - Scope analysis    │   │    UniversalAgent   │   │  - Plan history    │  │
│  │  - Domain count      │   │  - Sets mode on     │   │                    │  │
│  │  - Implementation    │   │    agent before     │   │                    │  │
│  │  - Dependencies      │   │    returning        │   │                    │  │
│  │  - 0 LLM calls       │   │                     │   │                    │  │
│  └──────────────────────┘   └────────────────────┘   └────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
              │                      │                            │
              ▼                      ▼                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Universal Agent                                      │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         UniversalAgent                                   │ │
│  │                                                                          │ │
│  │   Mode Detection (keyword heuristic)                                     │ │
│  │   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │ │
│  │   │  code  │  │ debug  │  │  test  │  │ review │  │  plan  │           │ │
│  │   │ (dflt) │  │        │  │        │  │        │  │        │           │ │
│  │   └────────┘  └────────┘  └────────┘  └────────┘  └────────┘           │ │
│  │        ▼           ▼           ▼           ▼           ▼                │ │
│  │   System Prompt (per mode) + Tool Set (per mode)                        │ │
│  │                                                                          │ │
│  │   Agent Loop:                                                            │ │
│  │   1. initSession() — load memory ONCE                                   │ │
│  │   2. Build system prompt + context                                       │ │
│  │   3. callLLM() with streaming                                            │ │
│  │   4. parseToolCalls() — multi-strategy parser                           │ │
│  │   5. executeTool() — permission check → execute                         │ │
│  │   6. Early exit if 3 consecutive idle iterations                        │ │
│  │   7. Repeat from 3 until done or maxIterations                          │ │
│  │   8. flushSession() — write memory ONCE                                 │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                             Tool Layer                                        │
│                                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  File System │  │    Shell     │  │     Git      │  │  Test & Coverage │ │
│  │              │  │              │  │              │  │                  │ │
│  │  file_read   │  │  shell_exec* │  │  git_status  │  │  test_run        │ │
│  │  file_write  │  │              │  │  git_add*    │  │  coverage_report │ │
│  │  file_delete*│  │  (*requires  │  │  git_commit* │  │                  │ │
│  │  dir_create  │  │   permission)│  │  git_diff    │  │                  │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │  Tool Call Parser (multi-strategy)                                       │ │
│  │  Strategy 1: ```tool\n<name>\n{params}```  (primary format)             │ │
│  │  Strategy 2: {"tool": "name", "params": {...}}  (JSON object)           │ │
│  │  Strategy 3: <tool name="name"><params>{...}</params></tool>  (XML)     │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Provider Layer                                      │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Dynamic Fallback Chain (runtime health-check at session start)          │ │
│  │                                                                          │ │
│  │  1. Ollama (local) ──────── health check: GET /api/tags timeout 1s      │ │
│  │     qwen2.5-coder:3b  (<8GB RAM available)                              │ │
│  │     qwen2.5-coder:7b  (8–16GB RAM available)                            │ │
│  │     qwen2.5-coder:14b (16GB+ RAM available)                             │ │
│  │         │                                                                │ │
│  │         ▼ (if not running)                                               │ │
│  │  2. Groq (free tier) ────── requires GROQ_API_KEY                       │ │
│  │     llama-3.1-8b-instant   (simple tasks, ~500 tok/sec)                 │ │
│  │     llama-3.3-70b-versatile (complex tasks)                             │ │
│  │         │                                                                │ │
│  │         ▼ (if no key)                                                    │ │
│  │  3. OpenRouter (free) ───── requires OPENROUTER_API_KEY                 │ │
│  │     google/gemma-2-9b-it:free                                           │ │
│  │     meta-llama/llama-3.2-90b:free                                       │ │
│  │         │                                                                │ │
│  │         ▼ (if no key)                                                    │ │
│  │  4. Paid fallbacks ─────── OpenAI / Anthropic (optional)                │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Memory Layer                                       │
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────────┐  ┌───────────────────────┐  │
│  │  SessionCache    │  │  ProjectMemory        │  │  Task Manager         │  │
│  │  (IN-MEMORY)     │  │  (file-based)         │  │                       │  │
│  │                  │  │                       │  │  - Task IDs           │  │
│  │  - Loaded ONCE   │  │  - Patterns           │  │  - Output dirs        │  │
│  │    at session    │  │  - Decisions          │  │  - Task metadata      │  │
│  │    start         │  │  - Preferences        │  │  - Task isolation     │  │
│  │  - O(1) search   │  │  - loadAll() on init  │  │                       │  │
│  │  - Append-only   │  │  - batchWrite() on    │  │                       │  │
│  │    during session│  │    session end        │  │                       │  │
│  │  - Flushed ONCE  │  │                       │  │                       │  │
│  │    at session end│  └──────────────────────┘  └───────────────────────┘  │
│  └──────────────────┘                                                        │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  SQLiteStore                                                             │ │
│  │  - Execution history (written at session end via batchWrite)            │ │
│  │  - Conversation logs                                                     │ │
│  │  - NOT read during active agent turns                                   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  Storage: SQLite (.claude/memory/) + File-based — ALL deferred writes        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. CLI Layer

#### Interactive Mode (`src/cli/modes/interactive.ts`)

REPL-like interface for continuous workflow. Key changes from v1:
- **Streaming output** — LLM tokens stream to terminal in real time via `AsyncIterable<StreamChunk>`. Perceived latency is near-zero.
- **Progress indicators** — Shows current tool being executed (`▸ file_read src/api.ts...`) and iteration count (`[3/12]`).
- **Mode auto-detection** — Task description keywords automatically select agent mode (debug/test/review/plan/code).
- Mode switching via `/debug`, `/test`, `/review`, etc. still works as before.
- Config management via `/config get/set` unchanged.
- System info via `/system`, task list via `/tasks` unchanged.

#### Apply Command (`src/cli/commands/apply.ts`) — NEW

Post-task command that previews and merges sandbox output back to the source tree.

```
coding-agent apply <task-id>            # interactive diff preview + prompt
coding-agent apply <task-id> --dry-run  # show diff only, no changes
coding-agent apply <task-id> --yes      # apply all without prompting
```

Generates unified diffs between `output/task_xxx/` and the real source tree. User confirms before any source file is modified.

#### Permission System (`src/utils/permission-system.ts`) — UNCHANGED

Controls dangerous operations. Three options: Yes (once), Yes (always for session), No.

| Operation | Requires Permission |
|---|---|
| `file_read` | No |
| `file_write` (to output/) | No |
| `shell_exec` | Yes |
| `git_add`, `git_commit`, `git_push` | Yes |
| `file_delete` | Yes |

---

### 2. Orchestration Layer

#### Task Analyzer (`src/core/orchestrator/TaskAnalyzer.ts`) — UNCHANGED

Heuristic-only complexity analysis. Zero LLM calls. Analyzes:

| Factor | Weight | How Measured |
|---|---|---|
| File count | 0.15 | Estimated from task description keywords |
| Scope | 0.20 | Keyword matching (single-file vs multi-file vs project-wide) |
| Domain count | 0.20 | Count of distinct technical domains mentioned |
| Implementation | 0.25 | Complexity keywords (algorithm, integration, migration, etc.) |
| Testing | 0.10 | Test-related keywords present |
| Dependencies | 0.10 | Estimated external dependencies |

Output: `{ complexity: "simple" | "medium" | "complex", score: 0.0–1.0 }`

This complexity score feeds into:
- Provider routing (simple → smaller/faster model, complex → larger model)
- Context token budget (simple tasks get less context reserved)

#### Agent Spawner (`src/core/orchestrator/AgentSpawner.ts`) — SIMPLIFIED

Previously managed 6 specialized agent factories with complex lifecycle management. Now manages one factory: `UniversalAgent`. The `spawn(type)` interface is preserved for backward compatibility, but all types return a `UniversalAgent` with the appropriate mode pre-set.

```
AgentSpawner.spawn("debug") → UniversalAgent (mode: "debug")
AgentSpawner.spawn("test")  → UniversalAgent (mode: "test")
AgentSpawner.spawn("code")  → UniversalAgent (mode: "code")
```

System-aware capacity limits remain: the spawner still enforces `maxParallelAgents` based on `SystemAnalyzer` output.

#### Plan Manager (`src/core/orchestrator/PlanManager.ts`) — UNCHANGED

Breaks complex tasks into steps, manages execution plans, stores plan history.

---

### 3. Universal Agent

The core architectural change of v2.0. Replaces 6 specialized agents with a single `UniversalAgent`.

#### Why One Agent Is Better Here

| Concern | 6-Agent Model | UniversalAgent |
|---|---|---|
| Memory per agent | ~N × context window | 1 × context window |
| Instantiation cost | Factory + import per type | Single import, mode set |
| LLM connections | Potentially multiple | Always 1 |
| System prompt reuse | None (each agent separate) | All modes in one registry |
| Cross-mode tasks | OrchestratorAgent needed | Set mode mid-session |
| Codebase complexity | 6 files, ~1200 lines | 1 file, ~150 lines |

#### Mode Detection

```
Task description → keyword matching → mode
─────────────────────────────────────────────────────────
"fix the bug", "crash", "error", "broken"  → debug
"write tests", "unit test", "coverage"     → test
"review code", "refactor", "analyze"       → review
"plan this", "break down", "steps for"    → plan
(default)                                  → code
```

#### Agent Loop (v2.0)

```
execute(task):
  1. detectMode(task.description) → set system prompt + tool set
  2. memory.initSession()          → load ALL project memory into RAM (once)
  3. Build initial messages array  → [system_prompt, task_description]
  4. Loop (max: maxIterations):
     a. callLLM(messages, stream=true) → stream tokens to terminal
     b. Collect full response
     c. parseToolCalls(response)    → multi-strategy parser
     d. If no tool calls AND idle count >= 3 → BREAK (early exit)
     e. For each tool call:
          - permissionSystem.check(tool, params)
          - If needs approval → prompt user
          - executeTool(name, params) → append result to messages
     f. truncateMessages(messages, maxTokens) → preserve system + recent
  5. memory.flushSession()         → batch write to SQLite + files (once)
  6. Return TaskResult
```

#### Token Budget Management

```typescript
// System capacity → token budget (from SystemAnalyzer, not hardcoded)
| RAM Usage | Max Tokens | Effective Context |
|-----------|------------|-------------------|
| < 35%     | 64,000     | ~50K after system |
| 35–50%    | 32,000     | ~25K after system |
| 50–70%    | 16,000     | ~12K after system |
| > 70%     | 8,000      | ~6K after system  |
```

**Truncation strategy (pinned-head sliding window):**
- Always preserve: all `system` role messages
- Always preserve: the first `user` message (original task)
- Slide window over remaining messages to fit budget
- Result: model never loses its instructions or task context

#### Iteration Limits

| Mode | Max Iterations | Early Exit After | Max Time (5s/iter) |
|---|---|---|---|
| code | 12 | 3 idle | ~60s |
| debug | 10 | 3 idle | ~50s |
| test | 10 | 3 idle | ~50s |
| review | 8 | 3 idle | ~40s |
| plan | 6 | 3 idle | ~30s |

---

### 4. Tool Layer

#### File System Tools

| Tool | Permission | Description |
|---|---|---|
| `file_read` | None | Read file contents. Source files are readable. |
| `file_write` | None | Write files. All writes go to `output/task_xxx/` directory. |
| `file_delete` | Required | Delete files. Always prompts user. |
| `directory_create` | None | Create directories within output dir. |

#### Shell Tools

| Tool | Permission | Description |
|---|---|---|
| `shell_exec` | Required | Execute shell commands. Always prompts unless session-approved. |

#### Git Tools

| Tool | Permission | Description |
|---|---|---|
| `git_status` | None | Read-only repository status. |
| `git_diff` | None | Show diffs. Read-only. |
| `git_add` | Required | Stage files. Prompts user. |
| `git_commit` | Required | Create commits. Prompts user. |
| `git_push` | Required | Push to remote. Prompts user. |

#### Test Tools

| Tool | Permission | Description |
|---|---|---|
| `test_run` | Implicit shell | Run test suites. Uses configured test command. |
| `coverage_report` | Implicit shell | Generate coverage. Appends report to output. |

#### Tool Call Parser (`src/core/agents/tool-parser.ts`) — NEW

Multi-strategy parser that attempts three parsing strategies in cascade. Returns on first non-empty result.

```
Input: LLM output text
  │
  ├─ Strategy 1: Markdown code block  /```tool\n(\w+)\n([\s\S]*?)```/
  │   Match? → return ParsedToolCall[]
  │
  ├─ Strategy 2: JSON object with tool/name key
  │   Find all {...} blobs → parse JSON → filter by known tool names
  │   Match? → return ParsedToolCall[]
  │
  ├─ Strategy 3: XML-style <tool name="..."><params>...</params></tool>
  │   Match? → return ParsedToolCall[]
  │
  └─ No match → return [] (agent loop detects idle, applies early exit)
```

---

### 5. Provider Layer

#### Dynamic Fallback Chain

The key change from v1: provider selection is now dynamic, not static. At session start, the system health-checks each provider in priority order and uses the first available one.

```
getAvailableProvider(preferLocal, taskComplexity):
  │
  ├─ if preferLocal && isOllamaRunning() [1s timeout]:
  │    availableRAM < 8GB  → qwen2.5-coder:3b
  │    8GB ≤ RAM < 16GB   → qwen2.5-coder:7b   (simple) or :7b (complex)
  │    RAM ≥ 16GB          → qwen2.5-coder:14b
  │    return { provider: "ollama", model }
  │
  ├─ elif GROQ_API_KEY exists:
  │    simple  → llama-3.1-8b-instant    (~500 tok/sec, free)
  │    complex → llama-3.3-70b-versatile (larger, free tier)
  │    return { provider: "groq", model }
  │
  ├─ elif OPENROUTER_API_KEY exists:
  │    simple  → google/gemma-2-9b-it:free
  │    complex → meta-llama/llama-3.2-90b:free
  │    return { provider: "openrouter", model }
  │
  ├─ elif OPENAI_API_KEY: return { provider: "openai", model: "gpt-4o-mini" }
  ├─ elif ANTHROPIC_API_KEY: return { provider: "anthropic", model: "claude-haiku-4-5-20251001" }
  │
  └─ throw Error with setup instructions
```

#### Provider Comparison (Free Tiers)

| Provider | Speed | Privacy | Rate Limit | Best For |
|---|---|---|---|---|
| Ollama (local) | 2–6s/turn | 100% local | None | Code with private data |
| Groq | 0.5–1s/turn | API (Groq servers) | 6000 tok/min | Fast tasks, debugging |
| OpenRouter | 1–3s/turn | API (varies) | Varies by model | Overflow / no Ollama |

#### Model Size vs RAM

| Available RAM | Recommended Ollama Model | Context Quality |
|---|---|---|
| < 6GB | `qwen2.5-coder:1.5b` | Basic |
| 6–8GB | `qwen2.5-coder:3b` | Acceptable |
| 8–16GB | `qwen2.5-coder:7b` | Good |
| 16GB+ | `qwen2.5-coder:14b` | Excellent |

---

### 6. Memory Layer

The most significantly changed layer from v1. The core principle shift: **all I/O is deferred to session boundaries.**

#### SessionCache (`src/memory/SessionCache.ts`) — NEW

In-memory store for the current session. All memory reads during agent execution hit this cache, not disk.

| Operation | v1 Behavior | v2 Behavior |
|---|---|---|
| `memory.search()` | SQLite query + file read every turn | In-memory text match, O(entries) |
| `memory.store()` | SQLite write + file write immediately | Append to in-memory list |
| Session start | Nothing | `loadAll()` — bulk read from files |
| Session end | Nothing | `flushSession()` — batch write to SQLite + files |

#### ProjectMemory (`src/memory/ProjectMemory.ts`) — EXTENDED

Added `loadAll()` and `batchWrite()` methods. All other behavior unchanged.

- `loadAll()` — reads all `.json` files from `.claude/memory/` in one pass, returns flat array of entries
- `batchWrite(entries)` — groups new entries by type, appends to appropriate files in one pass

#### SQLiteStore (`src/memory/SQLiteStore.ts`) — EXTENDED

Added `batchWrite(entries)` for deferred bulk inserts. All other behavior unchanged. No longer called during agent turn execution.

#### Context Window (`src/memory/ContextWindow.ts`) — UNCHANGED

Short-term in-memory conversation tracking. Already in-memory, no change needed.

#### Task Manager (`src/utils/task-manager.ts`) — UNCHANGED

Manages task IDs, output directories, and metadata. Behavior unchanged.

---

## Data Flow

### Session Lifecycle (v2.0)

```
User starts session
        │
        ▼
SessionCache.initSession()
  - Read ALL .claude/memory/*.json into RAM
  - Start SQLite conversation record
        │
        ▼
User submits task
        │
        ▼
TaskAnalyzer.analyze(task)
  - Heuristic scoring (0 LLM calls)
  - Returns: { complexity, agentMode }
        │
        ▼
Provider health check (once per session)
  - isOllamaRunning()? → pick model size by RAM
  - else hasGroqKey()?  → pick Groq model by complexity
  - else hasOpenRouterKey()? → pick free model
        │
        ▼
AgentSpawner.spawn(agentMode)
  - Returns UniversalAgent with mode pre-set
        │
        ▼
UniversalAgent.execute(task)
  ┌────────────────────────────────────────────────────┐
  │  Agent Loop                                        │
  │                                                    │
  │  iteration = 0, idleCount = 0                      │
  │  ┌──────────────────────────────────────────────┐  │
  │  │  Build messages: [system, history, task]     │  │
  │  │       │                                      │  │
  │  │       ▼                                      │  │
  │  │  Search SessionCache for relevant context    │  │
  │  │  (O(n) in-memory, no I/O)                   │  │
  │  │       │                                      │  │
  │  │       ▼                                      │  │
  │  │  truncateMessages() if over budget           │  │
  │  │  (preserve system + first user message)      │  │
  │  │       │                                      │  │
  │  │       ▼                                      │  │
  │  │  callLLM(stream=true)                        │  │
  │  │    → stream tokens to terminal               │  │
  │  │       │                                      │  │
  │  │       ▼                                      │  │
  │  │  parseToolCalls(response)                    │  │
  │  │  [Strategy 1 → 2 → 3]                        │  │
  │  │       │                                      │  │
  │  │    no tools?                                 │  │
  │  │    idleCount++                               │  │
  │  │    idleCount >= 3 → BREAK                    │  │
  │  │       │                                      │  │
  │  │    tools found?                              │  │
  │  │    idleCount = 0                             │  │
  │  │    For each tool:                            │  │
  │  │      permissionCheck() → prompt if needed   │  │
  │  │      executeTool()                           │  │
  │  │      ▸ file_write → output/task_xxx/         │  │
  │  │      ▸ file_read  → source files             │  │
  │  │      ▸ shell_exec → requires permission      │  │
  │  │      ▸ git_*      → requires permission      │  │
  │  │      append result to messages               │  │
  │  │       │                                      │  │
  │  │    iteration++                               │  │
  │  │    iteration >= maxIterations → BREAK        │  │
  │  └──────────────────────────────────────────────┘  │
  │                                                    │
  │  Task complete                                     │
  └────────────────────────────────────────────────────┘
        │
        ▼
SessionCache.flushSession()
  - batchWrite new entries to .claude/memory/*.json
  - batchWrite to SQLite
  - Save task metadata
        │
        ▼
Return TaskResult to CLI
        │
        ▼
User sees: "✓ Task complete. Run: coding-agent apply <task-id>"
```

### Apply Workflow (NEW)

```
coding-agent apply <task-id>
        │
        ▼
Load task metadata from .tasks/<task-id>.json
        │
        ▼
glob all files in output/<task-id>/
        │
        ▼
For each output file:
  - Read output version
  - Read source version (or empty string if new file)
  - Generate unified diff
  - Count +additions -deletions
        │
        ▼
Display summary:
  "3 file(s) changed:"
  "  src/api.ts (+12 -2)"
  "  src/api.test.ts (new)"
  "  src/utils.ts (+1 -0)"
        │
        ▼
Prompt: "Apply these changes? [y/n/diff]"
        │
   ├── "diff" → show full unified diff for each file
   ├── "n"    → abort, source tree untouched
   └── "y"    → writeFileSync each output file to source path
```

---

## Configuration

### Config Hierarchy — UNCHANGED

```
Defaults → Global Config (~/.coding-agent/coding-agent.json)
         → Project Config (./coding-agent.json)
```

### Key Settings (v2.0)

```json
{
  "defaults": {
    "preferLocal": true,
    "fallbackToPaid": false,
    "maxParallelAgents": 2,
    "complexityThreshold": 0.7,
    "outputDir": "output",
    "streaming": true,
    "earlyExitIdleThreshold": 3
  },
  "providers": [
    {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "enabled": true,
      "modelOverride": null
    },
    {
      "type": "groq",
      "enabled": true
    },
    {
      "type": "openrouter",
      "enabled": true
    }
  ],
  "memory": {
    "sessionCacheEnabled": true,
    "deferredWrites": true,
    "maxSessionEntries": 500
  }
}
```

---

## Output Structure — EXTENDED

```
project/
├── output/                         # All agent-created/modified files
│   ├── .tasks/                     # Task metadata
│   │   ├── task_abc123.json
│   │   └── task_def456.json
│   ├── task_abc123/                # Task-specific output
│   │   └── src/
│   │       └── api.ts              # Agent's version of the file
│   └── task_def456/
│       └── src/
│           ├── utils.ts
│           └── utils.test.ts
├── src/                            # Your existing code (read-only for agent)
├── .claude/                        # Project memory
│   └── memory/
│       ├── patterns.json           # Learned code patterns
│       ├── decisions.json          # Architecture decisions
│       ├── preferences.json        # User coding style
│       └── history.json            # Past executions (batch-written)
├── coding-agent.json               # Project config
└── package.json
```

---

## System Awareness

### Capacity Detection (`src/utils/system-analyzer.ts`) — EXTENDED

Extended to output `recommendedModel` in addition to existing fields.

```typescript
interface SystemCapabilities {
  status: "optimal" | "moderate" | "limited" | "critical";
  cpuCount: number;
  totalMemoryGB: number;
  usedMemoryPercent: number;
  maxTokens: number;                // Used by BaseAgent.getDefaultConfig()
  recommendedMaxAgents: number;     // Used by AgentSpawner
  recommendedModel: {               // NEW — used by ModelRouter
    ollama: string;
    reasoning: string;
  };
}
```

### Adaptive Limits

| System Status | RAM Usage | Max Agents | Max Tokens | Ollama Model |
|---|---|---|---|---|
| Optimal | < 35% | 2 | 64,000 | qwen2.5-coder:7b+ |
| Moderate | 35–50% | 1 | 32,000 | qwen2.5-coder:7b |
| Limited | 50–70% | 1 | 16,000 | qwen2.5-coder:3b |
| Critical | > 70% | 1 | 8,000 | qwen2.5-coder:3b |

---

## Security Considerations — UNCHANGED

### Output Directory Isolation

All agent file writes go to `output/task_xxx/` directory. Existing project files are read-only for the agent. The `apply` command is the only path to modifying source files, and it requires explicit user confirmation.

### Permission System

Shell commands, git operations, and file deletions always prompt the user. Session-level approval (`Yes (always)`) is available but scoped to the current interactive session only.

### System Resource Limits

`maxTokens` is now enforced at the agent level (not just at `AgentSpawner` construction), ensuring Ollama never receives context requests larger than the system can handle.

---

## File:Module Mapping (v2.0)

| File | Responsibility | Status |
|---|---|---|
| `src/cli/index.ts` | CLI entry point | Unchanged |
| `src/cli/modes/interactive.ts` | REPL, streaming output | Modified |
| `src/cli/commands/apply.ts` | Diff preview + merge | **NEW** |
| `src/utils/config.ts` | Configuration management | Unchanged |
| `src/utils/system-analyzer.ts` | System capacity + model recommendation | Modified |
| `src/utils/task-manager.ts` | Task isolation & IDs | Unchanged |
| `src/utils/permission-system.ts` | Permission prompts | Unchanged |
| `src/utils/diff-merge.ts` | Unified diff + file merge | **NEW** |
| `src/core/orchestrator/AgentSpawner.ts` | Agent lifecycle (simplified) | Modified |
| `src/core/orchestrator/TaskAnalyzer.ts` | Task complexity (heuristic) | Unchanged |
| `src/core/orchestrator/PlanManager.ts` | Task planning | Unchanged |
| `src/core/agents/BaseAgent.ts` | Abstract agent, token budget, truncation | Modified |
| `src/core/agents/UniversalAgent.ts` | Single agent, mode switching | **NEW** |
| `src/core/agents/system-prompts.ts` | Per-mode system prompts | **NEW** |
| `src/core/agents/tool-sets.ts` | Per-mode tool availability | **NEW** |
| `src/core/agents/tool-parser.ts` | Multi-strategy tool call parser | **NEW** |
| `src/core/agents/CodeAgent.ts` | ~~General coding~~ | **DEPRECATED** |
| `src/core/agents/DebugAgent.ts` | ~~Bug diagnosis~~ | **DEPRECATED** |
| `src/core/agents/TestAgent.ts` | ~~Test generation~~ | **DEPRECATED** |
| `src/core/agents/ReviewAgent.ts` | ~~Code review~~ | **DEPRECATED** |
| `src/core/agents/PlanAgent.ts` | ~~Task planning~~ | **DEPRECATED** |
| `src/core/agents/OrchestratorAgent.ts` | ~~Multi-agent coordination~~ | **DEPRECATED** |
| `src/core/tools/*.ts` | Tool implementations | Unchanged |
| `src/providers/ModelRouter.ts` | Dynamic provider routing | Modified |
| `src/providers/health-check.ts` | Runtime provider availability | **NEW** |
| `src/providers/ProviderFactory.ts` | Provider instantiation | Unchanged |
| `src/providers/OllamaProvider.ts` | Ollama API, JSON mode | Modified |
| `src/memory/MemoryManager.ts` | Unified memory interface | Modified |
| `src/memory/SessionCache.ts` | In-memory session store | **NEW** |
| `src/memory/ProjectMemory.ts` | File-based memory, bulk ops | Modified |
| `src/memory/SQLiteStore.ts` | SQLite history, batch write | Modified |
| `src/memory/ContextWindow.ts` | Short-term conversation | Unchanged |

---

## Extension Points

### Adding New Agent Modes

1. Add mode key to `AgentMode` type in `system-prompts.ts`
2. Write the system prompt in `SYSTEM_PROMPTS`
3. Define the tool set in `TOOL_SETS`
4. Add keyword patterns to `UniversalAgent.detectMode()`
5. No new class, no factory registration needed

### Adding New Tools

1. Create tool definition in `ToolRegistry`
2. Implement handler function in `src/core/tools/`
3. Add tool name to relevant mode entries in `TOOL_SETS`
4. Register with permission system if dangerous

### Adding New Providers

1. Implement `ProviderInterface` in `src/providers/`
2. Add to `ProviderFactory`
3. Add health-check logic to `health-check.ts`
4. Add to the fallback chain in order of preference
5. Configure in `coding-agent.json`

---

## Performance Comparison: v1.0 vs v2.0

| Metric | v1.0 | v2.0 | Change |
|---|---|---|---|
| RAM on 8GB (idle) | ~75% | ~20–30% | **-50–55%** |
| LLM calls per "fix bug" task | 3–10 | 3–10 | Same |
| I/O ops per agent turn | 3–6 (SQLite + files) | 0 (cache hit) | **-100%** |
| Max possible hang time | ~4 min (50 iter) | ~60s (12 iter) | **-75%** |
| Silent tool failures | Frequent (1 regex) | Rare (3 strategies) | **Eliminated** |
| Provider fallback | Error if Ollama down | Auto-fallback to Groq | **Added** |
| Streaming output | Not wired | Real-time to terminal | **Added** |
| Source file editing | Manual copy | `apply` command | **Added** |
| Agent classes | 6 (+ orchestrator) | 1 (UniversalAgent) | **-83%** |
| Codebase size (agents) | ~1400 lines | ~350 lines | **-75%** | 