# Architecture Comparison: architecture2.md vs architecture3.md

## Summary Verdict

| Dimension | Winner | Notes |
|---|---|---|
| **Grounding in reality** | architecture2 | Built on a wiring audit; every change cites a real code defect |
| **Comprehensiveness** | architecture3 | Covers 96 sections: memory, learning, eval, security, research, UX, data model |
| **Implementation readiness** | architecture2 | File-by-file mapping, explicit "retired" list, phased landing sequence |
| **Self-improvement vision** | architecture3 | Failure bank → eval generation → promotion is the strongest loop in either doc |
| **Memory system depth** | architecture3 | 7 memory types, promotion rules, decay, experience graph, write pipeline |
| **Security model** | architecture3 | Permission levels, network policy, secret management, risk levels — all absent from architecture2 |
| **Verification rigor** | architecture3 | 8-level verification ladder with task-risk-matched depth; architecture2 stops at lint+typecheck |
| **Research subsystem** | architecture3 | Query decomposition, parallel researchers, evidence store, contradiction check, citation verify — architecture2 has nothing |
| **Deployment model** | architecture2 | Explicitly scoped as local downloadable npm package; architecture3 assumes PostgreSQL/Docker/Rust stack |
| **Provider optimization** | architecture2 | Context Epoch, prompt caching, ModelCatalog, ProviderRegistry — concrete, buildable components |
| **Compaction strategy** | architecture2 | Structured template-based compaction that preserves provider cache prefix |
| **Agent communication** | architecture3 | Structured JSON messages between agents vs unstructured text return |
| **Session model** | architecture3 | Session DAG, fork/branch/rollback, explicit finite state machine |
| **Explainability** | architecture3 | "Why did you do X?" answered from structured recorded state |
| **User control** | architecture3 | Explicit remember/forget/show commands, memory inspectability |

---

## Feature-by-Feature Analysis

### 1. Multi-Agent System

**architecture2:** `spawn_subagent` tool — child session, depth-limited (max 2), permission-narrowed, text-only return. Agent itself decides mid-conversation whether to spawn.

**architecture3:** Full Agent Swarm — 10 specialized agents (Planner, Explorer, Researcher, Coder, Debugger, Reviewer, Security, Documentation, Verifier, Test). Structured JSON message passing between agents.

**Best from each:**
- architecture2's **single decision point** (agent decides when to spawn, not a pre-computed pipeline)
- architecture3's **structured agent communication** (JSON findings with severity/file/line/claim/evidence)
- architecture2's **depth limiting** and permission narrowing (practical safety)
- architecture3's **verification agent** that can reject the primary agent's result (independent verification)

**→ Hybrid:** Single agent with mode switching + `spawn_subagent` for delegation. Sub-agents communicate via structured messages. Verification agent has veto power. Depth-limited to 3 levels (not 2 — architecture3's richer verification needs more depth).

---

### 2. Context Management

**architecture2:** Context Epoch — one baseline system prompt per task, cached. Source drift appends small messages. Unified truncation path. `ContextWindowManager` retired. Structured compaction (Objective/Important Details/Work State/Next Move/Relevant Files) that preserves provider cache prefix.

**architecture3:** Context Engine with budget allocation (20% system, 20% task, 25% code, etc.). Multi-retrieval (vector + FTS + graph). Context relevance scoring with 9 factors. Compaction produces structured artifacts (objective, decisions, completed work, etc.).

**Best from each:**
- architecture2's **Context Epoch** (avoids rebuilding system prompt, enables provider caching)
- architecture2's **cache-preserving compaction** (replays prefix, appends instruction)
- architecture3's **budget allocation** (dynamic per task type)
- architecture3's **multi-retrieval** (vector + FTS + graph for context selection)

**→ Hybrid:** Context Epoch for system prompt caching. Budget-based context allocation that adjusts per task type. Multi-retrieval for memory/project knowledge. Cache-preserving compaction as the truncation mechanism.

---

### 3. Memory System

**architecture2:** SessionCache + ProjectMemory + SQLiteStore. No learning/experience/failure memory. "Embedding-based memory retrieval stays dormant."

**architecture3:** 7 memory types (User, Project, Session, Fact, Procedural, Failure, Experience). Structured fact representation (subject/predicate/object/confidence). Promotion rules (repeated observation OR strong evidence OR explicit instruction). Memory decay with confidence/last_verified/success_count/failure_count. Experience Graph for long-term representation. Write pipeline (trajectory → candidate → dedup → conflict → evidence → confidence → promotion).

**Best from each:**
- architecture3's **entire memory system** is superior — architecture2 has nothing comparable
- architecture2's **SQLite-backed implementation** (actually built and working)
- architecture3's **promotion rules** prevent memory pollution
- architecture3's **failure memory** enables learning from mistakes

**→ Hybrid:** Keep SQLiteStore as the storage backend. Layer architecture3's 7 memory types on top. Implement the write pipeline (trajectory analysis → candidate extraction → dedup → conflict → evidence → confidence → promotion). Add memory decay.

---

### 4. Security Model

**architecture2:** Permission persistence (.claude/permissions.json). Prefix-rule table for shell commands (git status → allow, git push → prompt, rm -rf → deny). "Defense in depth, sized to fit."

**architecture3:** 7 permission levels (READ, WRITE, EXECUTE, NETWORK, SECRETS, PROCESS_CONTROL, SYSTEM). 4 risk levels (LOW, MEDIUM, HIGH, CRITICAL). Contextual approval engine (not just "Allow bash? yes/no"). Network policy (domain/port/allow/deny). Secret management (reference injection, never in LLM context). Sandbox isolation.

**Best from each:**
- architecture2's **prefix-rule table** (practical, implementable now)
- architecture2's **permission persistence** (cross-session)
- architecture3's **contextual approval** (explain WHY the agent wants to do something)
- architecture3's **risk levels** (task-appropriate enforcement)
- architecture3's **secret reference injection** (never expose secrets to LLM)

**→ Hybrid:** Prefix-rule table + tool-level permissions + risk levels. Contextual approval prompts. Secret references only in LLM context. Persisted permission grants.

---

### 5. Deployment / Packaging

**architecture2:** Local downloadable npm package. oclif-based CLI. No server, no Docker, no external services required.

**architecture3:** Rust core + Python/TypeScript service layer + PostgreSQL + pgvector + Redis + Docker/Firecracker + gRPC/WebSocket + OpenTelemetry + Prometheus.

**→ Decision:** architecture2 wins completely. The project is a Node.js/TypeScript npm package. architecture3's stack is for a cloud-hosted SaaS product, which is explicitly out of scope. All of architecture3's data storage ideas must be adapted to SQLite/local-first.

---

### 6. Self-Improvement / Learning

**architecture2:** No self-improvement system. Memory write-once-per-task. No experience mining, no skill promotion, no eval generation.

**architecture3:** Full learning plane — trajectory mining, memory extraction, skill extraction, failure mining, eval generation, prompt evolution, routing optimization. Gated self-improvement: candidate → offline eval → regression test → A/B test → shadow mode → production. Failure bank → eval generation → regression suite.

**Best from each:**
- architecture3's **entire learning plane** is the strongest feature in either document
- architecture2's **"honestly documented" principle** — don't claim self-improvement if it doesn't work yet

**→ Hybrid:** Build the learning plane but gate it strictly. Phase 1: trajectory recording + experience mining (analysis only). Phase 2: skill candidates + failure patterns. Phase 3: eval generation + regression suites. Phase 4: shadow mode routing optimization. Never auto-modify production agent code.

---

### 7. Verification System

**architecture2:** Lint → typecheck → unit test → build → diff review. Manual terminal verification for wiring.

**architecture3:** 8-level verification ladder (model confidence → static → unit → integration → E2E → independent reviewer → domain evaluator → human approval). Task-risk-matched depth. Coding completion protocol (implement → format → lint → typecheck → unit → integration → build → diff review → security → verifier). Failure classification (syntax/type/test/dependency/environment/logic/architecture/external).

**Best from each:**
- architecture3's **verification ladder** with task-risk matching
- architecture3's **failure classification** for targeted repair
- architecture2's **practical verification** (actually runnable in current codebase)

**→ Hybrid:** Coding completion protocol from architecture3. Risk-based verification depth. Failure classification for repair. Practical commands (npm run lint, npm run typecheck, npm test) that actually exist in the project.

---

### 8. Research Subsystem

**architecture2:** Nothing. Not addressed.

**architecture3:** Full research engine — query decomposition, parallel researchers, evidence store, contradiction check, synthesis, citation verification. Evidence objects with claim/source/authority/confidence/contradictions. Source ranking.

**→ Decision:** architecture3 wins by default. Build a research subsystem using web search + documentation crawling. Keep it local — no external databases needed. Use SQLite for evidence storage.

---

### 9. Provider / Model Management

**architecture2:** ModelRouter with config-based local-first routing. ProviderRegistry (typed capability map). ModelCatalog (fetched + cached capability/pricing data, hardcoded fallback). Prompt caching (cache_control breakpoints).

**architecture3:** Model Router with complexity estimator. Models classified by role (FAST/BALANCED/REASONING/CODING/RESEARCH/REVIEW/CHEAP_BACKGROUND). Router continuously evaluated.

**Best from each:**
- architecture2's **concrete implementation** (ProviderRegistry, ModelCatalog, prompt caching)
- architecture3's **role-based classification** (FAST/BALANCED/REASONING etc.)
- architecture2's **local-first enforcement** (config.preferLocal at construction)

**→ Hybrid:** ProviderRegistry from architecture2. Role-based model classification from architecture3. ModelCatalog with offline fallback. Prompt caching. Local-first routing enforced by construction.

---

### 10. Session Model

**architecture2:** Single session per task. SessionCache stores messages. No forking.

**architecture3:** Project → Session → Turn → Model Call/Tool Call/Tool Result/Approval/Observation. Session DAG for forking. Explicit FSM (CREATED → INITIALIZING → UNDERSTANDING → PLANNING → EXECUTING → VERIFYING → SUCCESS/REPAIRING → CLOSING → LEARNING → COMPLETED). Fork preserves history/context/workspace/observations.

**Best from each:**
- architecture3's **session DAG** (fork/branch/rollback for exploring alternatives)
- architecture3's **FSM** (explicit state management)
- architecture2's **simplicity** (single session is easier to reason about)

**→ Hybrid:** Keep single session as default. Add optional session forking for plan mode (exploring architectural alternatives). Simple state machine (INIT → UNDERSTANDING → PLANNING → EXECUTING → VERIFYING → CLOSING).

---

### 11. Explainability

**architecture2:** Not addressed.

**architecture3:** Agent answers "Why did you choose this model/modify this file/retrieve this memory/distrust this source/retry/stop/promote this skill?" from recorded structured state.

**→ Decision:** architecture3 wins. Record structured decision rationale during execution. Answer questions from recorded state, not fabricated explanations.

---

### 12. User Control

**architecture2:** Permission grants with "Always for session" option. Persisted across runs.

**architecture3:** Explicit commands: `remember`, `forget`, `show memory`, `show project knowledge`, `show learned skills`, `disable memory`, `disable learning`, `explain why you remembered this`.

**→ Hybrid:** Permission persistence from architecture2. User control commands from architecture3. Memory remains inspectable and editable.

---

### 13. Observability / Metrics

**architecture2:** Hooks fire on tool calls. Structured logging.

**architecture3:** Full metrics: time_to_first_token, time_to_first_action, task_duration, tokens_in/out, tool_latency, model_latency, cost, retry_count, verification_pass_rate. Agent quality metrics: task_success_rate, first_attempt_success, tool_efficiency, cost_per_success.

**→ Hybrid:** Build observability on top of existing hooks. Track key metrics per session. Store in SQLite. No Prometheus/Grafana (local package).

---

### 14. Event System

**architecture2:** Hooks (pre-tool-use, post-tool-use, on-error). Session-scoped.

**architecture3:** Full event bus — SessionCreated, TaskStarted, PlanCreated, ToolRequested, ApprovalRequested, ToolExecuted, FileChanged, TestStarted, etc.

**→ Hybrid:** Extend existing hooks with a lightweight event bus. Events stored in SQLite for trajectory analysis. No external message queue.

---

## Final Recommendation: Best of Each

| Component | Source | Rationale |
|---|---|---|
| **Deployment** | architecture2 | npm package, oclif CLI, local-first |
| **Context Epoch** | architecture2 | Cache-preserving, avoids rebuilds |
| **Compactor** | architecture2 | Structured template, preserves cache prefix |
| **ProviderRegistry** | architecture2 | Typed capability map, actually buildable |
| **ModelCatalog** | architecture2 | Fetched + cached + offline fallback |
| **Permission system** | architecture2+3 | Prefix rules + risk levels + persistence |
| **Memory types** | architecture3 | 7 types, promotion, decay, experience graph |
| **Memory write pipeline** | architecture3 | Trajectory → candidate → dedup → evidence → promotion |
| **Verification ladder** | architecture3 | Task-risk-matched depth, 8 levels |
| **Failure classification** | architecture3 | 8 failure types for targeted repair |
| **Learning plane** | architecture3 | Gated: mine → extract → evaluate → promote |
| **Research subsystem** | architecture3 | Query decomposition, evidence, contradiction |
| **Session forking** | architecture3 | For plan mode exploration |
| **Explainability** | architecture3 | From structured recorded state |
| **User control** | architecture3 | Remember/forget/show commands |
| **Agent communication** | architecture3 | Structured JSON messages |
| **Security model** | architecture3 | Risk levels, contextual approval, secret refs |
| **Multi-agent** | architecture2+3 | spawn_subagent + structured messages + verifier veto |
| **Task understanding** | architecture3 | Structured task object before planning |
| **Observability** | architecture3 | Metrics tracked per session, SQLite storage |
