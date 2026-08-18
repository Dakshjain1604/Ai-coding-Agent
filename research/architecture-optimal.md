# CodingAgent — Optimal Architecture v4.0

## The Best of architecture2 + architecture3, Unified into a Single Buildable Design

---

## Design Principles

1. **Local-first, enforced by construction.** Ollama preferred whenever available — routing rules built from `config.preferLocal` at construction, not a static table.
2. **Free-tier optimized.** Works with Ollama + Groq + OpenRouter only.
3. **Single agent, mode switching.** One model instance with role switching via system prompt + skill injection.
4. **Session-scoped I/O, honestly documented.** Memory loads once at session start, writes once at session end. Where a write is immediate, it's documented.
5. **System-aware.** Per-model context limits via fetched capability catalog.
6. **Sandbox-safe.** Output-directory isolation, explicit `apply`.
7. **One context, honestly built.** Single unified truncation/compaction path.
8. **Cache-aware.** Every context-assembly decision considers provider prompt-caching.
9. **Defense in depth, sized to fit.** Prefix-rule table + tool-level permissions + risk levels. No OS-level sandboxing.
10. **Evidence over assumption.** LLM proposes, environment verifies.
11. **Memory is not conversation summary.** Seven distinct memory types with promotion rules and decay.
12. **Self-improvement is gated.** Candidate → eval → regression → shadow → production. Never auto-modify.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                                      │
│  CLI (oclif) · Interactive REPL · TUI                                       │
│  Hooks fire: pre-tool-use / post-tool-use / on-error                        │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENT GATEWAY                                       │
│  User identity · Project identity · Session routing                         │
│  Client capability negotiation · Rate limiting                              │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SESSION ORCHESTRATOR                                   │
│                                                                             │
│  Task Understanding (structured task object)                                │
│    ↓                                                                        │
│  Task Classifier (type/difficulty/risk/ambiguity/parallelization)           │
│    ↓                                                                        │
│  Planner (DAG-based, success criteria, stop conditions)                     │
│    ↓                                                                        │
│  Model Router (role-based: FAST/BALANCED/REASONING/CODING/REVIEW)           │
│    ↓                                                                        │
│  Agent Loop (see below)                                                     │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                ┌─────────────────┼──────────────────┐
                │                 │                   │
                ▼                 ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  CONTEXT ENGINE  │  │   MEMORY OS      │  │  AGENT SWARM     │
│                  │  │                  │  │                  │
│  Context Epoch   │  │  User Memory     │  │  Primary Agent   │
│  (cached-based)  │  │  Project Memory  │  │    ├── Explorer  │
│                  │  │  Session Memory  │  │    ├── Researcher│
│  Budget Alloc    │  │  Fact Memory     │  │    ├── Coder     │
│  (per task type) │  │  Procedural      │  │    ├── Debugger  │
│                  │  │  Failure Memory  │  │    ├── Reviewer   │
│  Multi-Retrieval │  │  Experience      │  │    ├── Security   │
│  Vector+FTS+SQL  │  │  Graph           │  │    └── Verifier  │
│                  │  │                  │  │                  │
│  Compactor       │  │  Write Pipeline  │  │  spawn_subagent  │
│  (cache-preserv) │  │  Promotion Rules │  │  (depth≤3,       │
│                  │  │  Decay           │  │   narrowed perms) │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PROVIDER LAYER                                       │
│  ProviderRegistry (typed capability map)                                    │
│  ModelCatalog (fetched + cached + offline fallback)                         │
│  ModelRouter (role-based classification)                                    │
│  Prompt caching (cache_control breakpoints)                                 │
│  Providers: Ollama · OpenAI · Anthropic · Gemini · Groq · OpenRouter       │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TOOL RUNTIME                                       │
│  File System · Shell (prefix-rule gated) · Git · Code Search               │
│  Terminal (background/streaming/PTY) · Browser · Search · HTTP             │
│  spawn_subagent (plan/code modes only)                                      │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SECURITY PLANE                                        │
│  Permission levels: READ/WRITE/EXECUTE/NETWORK/SECRETS/PROCESS_CONTROL    │
│  Risk levels: LOW/MEDIUM/HIGH/CRITICAL                                      │
│  Prefix-rule table (git status→allow, git push→prompt, rm -rf→deny)       │
│  Contextual approval engine                                                 │
│  Secret reference injection (never in LLM context)                          │
│  Permission persistence (.claude/permissions.json)                          │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VERIFICATION PLANE                                    │
│  Risk-matched verification depth:                                           │
│    LOW: lint + typecheck                                                    │
│    MEDIUM: + unit tests + build                                             │
│    HIGH: + integration tests + security review                              │
│    CRITICAL: + E2E + independent reviewer + human approval                  │
│                                                                             │
│  Coding completion protocol:                                                │
│    implement → format → lint → typecheck → unit → integration              │
│    → build → diff review → security review → verifier                      │
│                                                                             │
│  Failure classification: syntax/type/test/dependency/environment/           │
│    logic/architecture/external                                              │
│                                                                             │
│  Repair: classify → root cause → changed hypothesis → retry (bounded)      │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY PLANE                                       │
│  Event bus (lightweight, session-scoped)                                    │
│  Metrics: time_to_first_token, task_duration, tokens_in/out,               │
│    tool_latency, cost, retry_count, verification_pass_rate                 │
│  Trajectory recording for learning                                          │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LEARNING PLANE                                         │
│  (Gated — Phase 1 is analysis-only, no auto-modification)                  │
│                                                                             │
│  Trajectory Analysis                                                        │
│    ↓                                                                        │
│  Experience Mining (what worked/failed/surprised/was reusable)             │
│    ↓                                                                        │
│  Candidate Generation (memory/skill/failure/eval/routing/prompt)           │
│    ↓                                                                        │
│  Offline Evaluation                                                         │
│    ↓                                                                        │
│  Regression Testing                                                         │
│    ↓                                                                        │
│  Promotion (candidate → shadow → A/B → production)                          │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATA PLANE                                          │
│  SQLite (authoritative store — metadata, memory, sessions, metrics)        │
│  Git (source control, snapshots, worktrees)                                 │
│  File system (artifacts, logs, caches)                                      │
│  FTS via SQLite FTS5                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Design Principle

The system must distinguish six different things:

```text
1. WHAT THE USER SAID
2. WHAT THE AGENT KNOWS
3. WHAT THE AGENT REMEMBERS
4. WHAT THE AGENT DID
5. WHAT THE AGENT VERIFIED
6. WHAT THE AGENT LEARNED
```

Never collapse them into one conversation transcript.

---

## 1. TASK UNDERSTANDING

Every user request becomes a structured task before any planning occurs.

```json
{
  "task_id": "t_abc123",
  "objective": "Implement OAuth login",
  "task_type": "coding",
  "difficulty": 0.82,
  "risk": "high",
  "ambiguity": 0.15,
  "scope": "authentication",
  "constraints": ["TypeScript", "existing auth architecture", "do not break existing users"],
  "success_criteria": ["OAuth login works", "existing login works", "tests pass", "security checks pass"],
  "parallelization_potential": 0.3,
  "required_tools": ["file-system", "shell", "git", "test-runner"],
  "estimated_cost_budget": "$0.50",
  "estimated_time_budget": "5 minutes"
}
```

Task types: `CODING | DEBUGGING | REFACTORING | RESEARCH | DOCUMENTATION | DEVOPS | SECURITY | PLANNING | MULTI-DOMAIN`

---

## 2. SESSION MODEL

```text
PROJECT
   │
   ├── SESSION
   │      │
   │      ├── TURN
   │      │      ├── MODEL CALL
   │      │      ├── TOOL CALL
   │      │      ├── TOOL RESULT
   │      │      ├── APPROVAL
   │      │      └── OBSERVATION
   │      │
   │      └── SUB-SESSIONS (via spawn_subagent)
   │
   └── OTHER SESSIONS
```

Session states (FSM):

```text
INIT → UNDERSTANDING → PLANNING → EXECUTING → VERIFYING → CLOSING → COMPLETED
                                ↑                         │
                                └─── REPAIRING ←──────────┘
```

Optional session forking in plan mode for exploring architectural alternatives. Fork preserves history, context, workspace snapshot, tool observations, memory references.

---

## 3. THE AGENT LOOP

```text
1. initSession() — load memory ONCE
2. Task Understanding — structured task object
3. Task Classification — type, difficulty, risk, ambiguity
4. Build Context Epoch (baseline system prompt + skill instructions)
5. Planning — DAG-based with success criteria and stop conditions
6. callLLM() — REAL streaming, tokens to terminal
7. parseToolCalls() — multi-strategy parser
8. Hooks fire: pre-tool-use → permission check → execute → post-tool-use
9. Verification (risk-matched depth)
10. On failure: classify → root cause → changed hypothesis → retry (bounded)
11. Compactor if budget crossed (cache-preserving, template-based)
12. Early exit if 3 consecutive idle iterations
13. flushSession() — write memory ONCE
14. Session Closeout — trajectory analysis, experience mining, candidate generation
```

---

## 4. CONTEXT ENGINE

### Context Epoch

One baseline system prompt per task, built from:
- Current mode's prompt
- Matched skill instructions
- Environment sources (date, git status, project instructions)

Cached for the task's lifetime. Source changing mid-task appends a small system message instead of triggering a rebuild. This enables provider-side prompt caching.

### Budget Allocation

```text
100% CONTEXT BUDGET

 20% system / policies / Context Epoch
 20% current task + plan
 25% relevant code
 10% recent trajectory
 10% project knowledge
  5% user memory
  5% skills
  5% historical evidence
```

Dynamic per task type:
- **Coding:** more code, less historical chat
- **Research:** more evidence, less code
- **Debugging:** more logs, more recent tool observations

### Multi-Retrieval

```text
                QUERY
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
   VECTOR      SQLITE       SQL
   SEARCH      FTS5        FILTERS
       │          │           │
       └──────────┼───────────┘
                  ▼
            RERANKER (score-based)
                  │
                  ▼
         CONTEXT SELECTOR (budget-aware)
```

Context relevance score:

```text
relevance =
  semantic_similarity
  + lexical_match
  + recency
  + task_type_match
  + project_match
  + success_history
  - redundancy
  - contradiction
```

### Compactor

Triggered when budget check crosses threshold. Produces:

```text
COMPACTION
├── objective
├── current plan
├── decisions
├── completed work
├── unresolved problems
├── important observations
├── active constraints
├── tool state
└── evidence references
```

Re-compaction merges into existing summary. Summarization call replays prefix verbatim and appends compaction instruction last (preserves provider cache). Falls back to hard-trim on failure.

---

## 5. MEMORY OS

### Seven Memory Types

```text
USER MEMORY
  preferences, working style, preferred technologies, communication preferences

PROJECT MEMORY
  architecture, conventions, commands, deployment, database, tests, constraints

SESSION MEMORY
  current session trajectory, decisions, outcomes

FACT MEMORY
  structured knowledge: subject/predicate/object/confidence/source/verified_at

PROCEDURAL MEMORY (Skills)
  HOW TO DO something — versioned, with success rate and eval suite

FAILURE MEMORY
  task/assumption/action/error/root_cause/fix/verification/frequency

EXPERIENCE MEMORY
  graph connecting tasks → models/skills/files/errors/fixes/tests
```

### Memory Write Pipeline

```text
SESSION CLOSE
  │
  ▼
TRAJECTORY ANALYZER
  │
  ▼
CANDIDATE EXTRACTION
  │
  ▼
DEDUPLICATION
  │
  ▼
CONFLICT DETECTION
  │
  ▼
EVIDENCE CHECK
  │
  ▼
CONFIDENCE SCORING
  │
  ▼
MEMORY PROMOTION (if criteria met)
```

### Promotion Rules

Memory becomes durable when:
- Repeated observation (seen 3+ times)
- Strong direct evidence (verified by test/tool)
- Explicit user instruction

Memory is downgraded when:
- Contradicted by new evidence
- Stale (not verified in N days based on risk level)
- Project changed
- User explicitly corrects it

### Memory Decay

Every memory has:

```text
confidence          (0.0 - 1.0)
last_verified       (timestamp)
success_count       (integer)
failure_count       (integer)
scope               (user/project/session)
expiry              (based on risk level)
```

Low-risk facts (user preferences) → long-lived
High-risk facts (dependency versions) → immediately tied to repository state

### Experience Graph

```text
TASK
 ├── USED → MODEL
 ├── USED → SKILL
 ├── TOUCHED → FILE
 ├── CAUSED → ERROR
 ├── FIXED_BY → ACTION
 ├── VERIFIED_BY → TEST
 └── GENERATED → MEMORY / SKILL
```

Enables queries: "How did we fix this before?" "What usually breaks after changing auth?" "Which model is best for this project?"

---

## 6. SKILL SYSTEM

Every skill contains:

```text
skill_id, name, description, version, scope
instructions, required_tools, examples
known_failures, dependencies
success_rate, usage_count, last_verified
eval_suite, status
```

Status lifecycle: `CANDIDATE → EXPERIMENTAL → ACTIVE → DEPRECATED | QUARANTINED`

Skills matched to task context and injected into system prompt alongside Context Epoch.

---

## 7. PROVIDER LAYER

### ProviderRegistry

Typed capability map replacing per-provider switch statements:

```typescript
interface ProviderCapability {
  streaming: boolean;
  toolCalling: boolean;
  promptCaching: boolean;
  maxContextLength: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}
```

### ModelCatalog

Fetches and caches model capability/pricing data with TTL. Hardcoded `MODEL_SPECS` as offline fallback. Feeds real context-length numbers into Compactor thresholds.

### Model Router

Role-based classification:

```text
FAST          → grep/search, simple classification
BALANCED      → simple edits, formatting
REASONING     → architecture decisions, complex refactor
CODING        → implementation, debugging
RESEARCH      → web search, documentation analysis
REVIEW        → code review, security review
CHEAP_BACKGROUND → memory extraction, eval generation
```

Routing rules built from `config.preferLocal` at construction. Local-first enforced by construction.

### Prompt Caching

`cache_control` breakpoints on system and message boundaries for providers that support it (Anthropic). Context Epoch makes this effective by keeping the system prompt stable.

---

## 8. TOOL RUNTIME

### Tool Interface

```text
Tool
├── name
├── description
├── input schema
├── output schema
├── permissions (risk level)
├── cost estimate
├── latency estimate
├── side effects flag
└── verification requirements
```

### Shell Command Gating

Prefix-rule table checked FIRST (before generic permission):

```text
git status          → ALLOW
git diff            → ALLOW
git log             → ALLOW
npm install         → PROMPT (explain why)
git push            → PROMPT
rm -rf              → DENY
curl | sh           → DENY
sudo                → DENY
```

### Terminal Execution

Supports: foreground, background, streaming, timeout, cancellation, resource limits, PTY, log capture.

Agent can start a server, continue coding, poll server, inspect logs, stop server — without blocking the session.

---

## 9. SECURITY PLANE

### Permission Levels

```text
READ              → read files, list directories
WRITE             → edit files, create files
EXECUTE           → run shell commands, scripts
NETWORK           → HTTP requests, API calls
SECRETS           → access environment variables, API keys
PROCESS_CONTROL   → kill processes, manage services
SYSTEM            → system-level operations
```

### Risk Levels

```text
LOW      → read file, grep, git status
MEDIUM   → edit source, install package, network request
HIGH     → run tests, build, delete files
CRITICAL → delete database, push to production, modify system config
```

### Contextual Approval

Instead of "Allow bash? yes/no":

```text
The agent wants to:
  npm install package X

Reason:
  Required to run the project's existing test command.

Scope:
  Current workspace only.

Network:
  registry.npmjs.org

Future requests:
  [Approve this package only] [Approve this host] [Approve all package installs] [Deny]
```

Approved policies become reusable rules in `.claude/permissions.json`.

### Secret Management

```text
secret reference (SECRET_REF: STRIPE_API_KEY)
    ↓
tool runtime
    ↓
secret injection into process
    ↓
process receives actual key
```

Never `API_KEY=abc123` inside LLM context.

---

## 10. VERIFICATION PLANE

### Verification Depth by Risk

```text
LOW Risk:
  lint + typecheck

MEDIUM Risk:
  + unit tests + build

HIGH Risk:
  + integration tests + security review

CRITICAL Risk:
  + E2E tests + independent reviewer + human approval
```

### Coding Completion Protocol

```text
IMPLEMENT
   ↓
FORMAT
   ↓
LINT
   ↓
TYPECHECK
   ↓
UNIT TEST
   ↓
INTEGRATION TEST
   ↓
BUILD
   ↓
DIFF REVIEW
   ↓
SECURITY REVIEW
   ↓
FINAL VERIFIER (can PASS/FAIL/PARTIAL/UNCERTAIN)
```

### Verification Agent

Independent from the implementer. Has separate context. Can reject the primary agent's result. Returns:

```text
objective, actions, findings, artifacts, files_changed, tests, failures, confidence, recommendation
```

### Failure Recovery

```text
FAILURE
   │
   ▼
CLASSIFY (syntax/type/test/dependency/environment/logic/architecture/external)
   │
   ▼
ROOT CAUSE ANALYSIS
   │
   ▼
REPAIR STRATEGY (changed hypothesis — not same action repeated)
   │
   ▼
RETRY (bounded by retry_count, failure_similarity, strategy_change, time_budget, cost_budget)
```

Escalation path:
```text
Attempt 1 → fix implementation
Attempt 2 → change approach
Attempt 3 → escalate to reviewer
Attempt 4 → stop and ask user
```

---

## 11. RESEARCH SUBSYSTEM

```text
RESEARCH TASK
      │
      ▼
QUERY DECOMPOSITION
      │
      ├── question A
      ├── question B
      └── question C
      │
      ▼
PARALLEL RESEARCHERS
      │
      ├── web search
      ├── documentation
      ├── GitHub inspection
      └── local codebase
      │
      ▼
EVIDENCE STORE (SQLite)
      │
      ▼
CONTRADICTION CHECK
      │
      ▼
SYNTHESIS
      │
      ▼
CITATION VERIFICATION
```

Evidence object:

```text
claim_id, claim, source_url, source_type
published_at, retrieved_at, excerpt
source_authority, confidence
supporting_evidence, contradicting_evidence, freshness
```

Source ranking: primary source > official docs > original paper > repository > benchmark > expert analysis > community discussion.

---

## 12. MULTI-AGENT (SUB-AGENT)

### spawn_subagent Tool

Available in `plan` and `code` modes. Spawns a fresh `UniversalAgent` in the requested mode.

Constraints:
- Tool set is strict subset of parent's
- Depth-limited (max depth 3)
- Permission-narrowed
- Returns `{ success, output, files_changed }` — no shared mutable state
- Sub-agents communicate via structured JSON messages

### Agent Types

```text
PRIMARY AGENT (orchestrates)
  │
  ├── EXPLORER — understand repo, find files, trace deps, build code graph
  ├── RESEARCHER — search web, read docs, collect evidence
  ├── CODER — modify code, create files, implement features
  ├── DEBUGGER — reproduce, localize, hypothesize, fix
  ├── REVIEWER — read diff, find bugs, challenge assumptions (separate context)
  ├── SECURITY — dependency risks, injection, secrets, permissions
  └── VERIFIER — determine if success criteria are actually satisfied
```

### Structured Agent Communication

```json
{
  "from": "reviewer",
  "to": "primary",
  "type": "finding",
  "severity": "high",
  "file": "auth.ts",
  "line": 82,
  "claim": "Refresh token is not rotated",
  "evidence": "integration-test-17",
  "required_action": "Implement token rotation"
}
```

---

## 13. EXPLAINABILITY

The agent records structured decision rationale during execution:

```text
Why did you choose this model?
  → recorded: "Task classified as CODING, difficulty 0.8, routed to coding model"

Why did you modify this file?
  → recorded: "Plan step 3: implement OAuth callback, file identified by explorer"

Why did you retry?
  → recorded: "Previous attempt failed: test_oauth_login timed out, hypothesis changed from 'missing env var' to 'wrong callback URL'"

Why did you stop?
  → recorded: "All success criteria met: OAuth works, existing login works, tests pass, security review clean"
```

---

## 14. USER CONTROL

### Explicit Commands

```text
remember <fact>              → persist to user/project memory
forget <fact>                → remove from memory
show memory                  → display current memory
show project knowledge       → display project facts
show learned skills          → display active skills
disable memory               → stop memory writes
disable learning             → stop experience mining
explain why you remembered X → answer from structured state
```

### Permission Control

```text
Always allow [tool] for this session
Always allow [tool] permanently (persisted to .claude/permissions.json)
Deny [tool] for this session
```

---

## 15. LEARNING PLANE (GATED)

### Phase 1: Analysis Only (v4.0)

```text
SESSION CLOSE
  │
  ▼
TRAJECTORY RECORDING (every action, observation, failure, result)
  │
  ▼
EXPERIENCE MINING
  │
  ├── what worked?
  ├── what failed?
  ├── what surprised us?
  ├── what was inefficient?
  └── what was reusable?
  │
  ▼
CANDIDATE GENERATION (memory/skill/failure/eval/routing candidates)
  │
  ▼
STORE AS CANDIDATES (not auto-promoted)
```

### Phase 2: Skill + Failure Patterns (v4.1)

```text
Failure Bank
  │
  ▼
ABSTRACT FAILURE PATTERN
  │
  ▼
GENERATE EVAL CASE
  │
  ▼
ADD TO REGRESSION SUITE
```

Every serious failure makes the system harder to fool again.

### Phase 3: Eval + Routing (v4.2)

```text
Candidate Change
  │
  ▼
OFFLINE EVALUATION
  │
  ▼
REGRESSION TEST
  │
  ▼
A/B TEST
  │
  ├── worse → reject
  └── better → shadow mode → production
```

### Phase 4: Shadow Mode (v4.3)

New routing/prompts run in parallel with existing ones. Compare outcomes. Promote only if verified better.

### What Can Self-Improve

```text
v4.0: system prompts, tool descriptions, memory extraction, context allocation
v4.1: planning strategies, retry strategies, verification strategies
v4.2: model routing, skill promotion, retrieval ranking
v4.3+: agent code, tool implementations (requires significantly stronger evaluation gates)
```

---

## 16. PROJECT BOOTSTRAPPING

When entering an unknown repository:

```text
PROJECT INIT
   │
   ├── detect language / framework / package manager / test framework
   ├── inspect git / CI / deployment
   ├── build dependency graph
   ├── detect architecture / conventions
   └── create project manifest
```

Project manifest (YAML):

```yaml
project:
  name: my-app
stack:
  backend: node
  frontend: react
  database: postgres
commands:
  test: npm test
  lint: npm run lint
  typecheck: npx tsc --noEmit
  build: npm run build
architecture: ...
conventions: ...
critical_files: ...
```

Replaces repeatedly rediscovering repository information.

---

## 17. OBSERVABILITY

### Metrics Per Session

```text
time_to_first_token
time_to_first_action
task_duration
tokens_in / tokens_out
tool_latency (per tool)
model_latency (per call)
cost (total)
retry_count
verification_pass_rate
```

### Agent Quality Metrics

```text
task_success_rate
first_attempt_success
repair_success
verification_accuracy
tool_efficiency
context_efficiency
memory_precision / recall
skill_success_rate
regression_rate
cost_per_success
time_per_success
```

Stored in SQLite. No external metrics infrastructure.

---

## 18. EVENT BUS

Lightweight, session-scoped:

```text
SessionCreated, TaskStarted, PlanCreated
ToolRequested, ApprovalRequested, ToolExecuted
FileChanged, TestStarted, TestFailed, TestPassed
AgentSpawned, AgentCompleted
MemoryCandidateCreated, SkillCandidateCreated
VerificationStart, VerificationComplete
SessionCompleted
```

Events stored in SQLite for trajectory analysis and learning.

---

## 19. DATA STORAGE

All local. No external services.

```text
SQLite (via better-sqlite3)
  → sessions, turns, tool calls, tool results
  → memory (all 7 types)
  → skills, skill versions
  → failures, failure patterns
  → experience graph
  → eval cases, eval runs
  → metrics, events
  → project manifests
  → permission grants
  → model routing statistics

SQLite FTS5
  → full-text search across memory, sessions, code

Git
  → source control, snapshots, worktrees for parallel attempts

File system
  → artifacts, logs, caches, config files
```

---

## 20. EXPLICITLY OUT OF SCOPE

- Client-server split with SSE/WebSocket transport
- OS-level sandboxing (Seatbelt/Landlock)
- Full plugin/DI framework
- Embedding-based memory retrieval (SQLite embeddings table stays dormant)
- Cloud deployment, Docker, Kubernetes
- External databases (PostgreSQL, Redis, etc.)
- Prometheus/Grafana observability stack
- gRPC/WebSocket API layer

All of these can be revisited if the project's scale changes.

---

## 21. BUILD ORDER

### Phase 1: Foundation (v4.0)

1. Wire streaming (currently implemented but never invoked)
2. Wire hooks into executeTool() (currently inert)
3. Wire skills into system prompt (currently inert)
4. Implement Context Epoch
5. Implement structured Compactor
6. Implement ProviderRegistry + ModelCatalog
7. Fix local-first routing (enforce by construction)
8. Wire code-search tool
9. Implement spawn_subagent
10. Implement permission persistence + prefix-rule table

### Phase 2: Memory + Security (v4.0)

11. Implement 7 memory types on SQLite
12. Implement memory write pipeline
13. Implement promotion rules + decay
14. Implement risk levels + contextual approval
15. Implement secret reference injection
16. Implement task understanding (structured task object)

### Phase 3: Verification + Research (v4.0)

17. Implement verification ladder (risk-matched depth)
18. Implement failure classification + bounded retry
19. Implement research subsystem (query decomposition, evidence store)
20. Implement session forking (plan mode)

### Phase 4: Learning (v4.1)

21. Implement trajectory recording
22. Implement experience mining (analysis only)
23. Implement candidate generation (memory/skill/failure/eval)
24. Implement explainability (structured decision rationale)

### Phase 5: Self-Improvement (v4.2+)

25. Implement failure bank → eval generation
26. Implement skill eval (baseline vs skill-enabled)
27. Implement model routing eval
28. Implement shadow mode routing

---

## 22. THE FIVE MOST IMPORTANT ENGINEERING PRINCIPLES

```text
1. Durable history ≠ active context.
2. Memory ≠ conversation summary.
3. Agent output ≠ verified truth.
4. Self-improvement ≠ unrestricted self-modification.
5. A skill is only valuable if its eval proves that it improves behavior.
```

---

## 23. FINAL DESIGN TARGET

The finished system should feel to a user like:

```text
"This is the same engineer I have been working with for months."
```

The agent should know:

```text
my projects, my codebase, my conventions
my preferred tools, my previous decisions
my common mistakes, my successful workflows
my research interests, my previous failures
my preferred degree of autonomy
```

But it should never blindly assume those things. Instead:

```text
REMEMBER + RETRIEVE + VERIFY + ACT + LEARN
```

The ideal architecture combines:

```text
ARCHITECTURE2:
  execution sandbox + local-first + provider optimization + cache-aware compaction

ARCHITECTURE3:
  memory OS + learning plane + verification rigor + research + explainability
```

And adds:

```text
EVIDENCE-BACKED EXPERIENCE GRAPH
+ CONTINUOUS EVALUATION (gated)
+ CONTROLLED SELF-IMPROVEMENT (phased)
```

That combination is the foundation for a genuinely persistent coding/research agent.
