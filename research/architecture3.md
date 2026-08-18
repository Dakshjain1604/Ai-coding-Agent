# Next-Generation Coding + Research Agent

## End-to-End Architecture, Runtime, Memory, Context, Execution, Evaluation, and Self-Improvement Design

---

# 1. SYSTEM OBJECTIVE

The system should not be designed as a chatbot with tools.

It should be designed as a persistent agent operating system with four simultaneous properties:

1. It can complete complex coding and research tasks autonomously.
2. It can safely operate a real development environment.
3. It remembers useful information across sessions without polluting context.
4. It improves its behavior, skills, routing, and strategies from verified experience.

The core lifecycle is:

```text
USER
  │
  ▼
IDENTITY + SESSION
  │
  ▼
TASK UNDERSTANDING
  │
  ▼
CONTEXT ASSEMBLY
  │
  ▼
PLANNING
  │
  ▼
MODEL / AGENT ROUTING
  │
  ▼
EXECUTION
  │
  ├───────────────┐
  │               │
  ▼               ▼
TOOLS          SUB-AGENTS
  │               │
  └───────┬───────┘
          ▼
      VERIFICATION
          │
     ┌────┴────┐
     │         │
   PASS      FAIL
     │         │
     │         ▼
     │      DIAGNOSE
     │         │
     │         ▼
     │      REPAIR
     │         │
     └────┬────┘
          ▼
      FINAL RESULT
          │
          ▼
     SESSION CLOSEOUT
          │
          ▼
 EXPERIENCE MINING
          │
     ┌────┼────────────┐
     ▼    ▼            ▼
  MEMORY SKILL       EVAL
     │    │            │
     └────┴────────────┘
          │
          ▼
     FUTURE AGENT
       IMPROVEMENT
```

---

# 2. TOP-LEVEL ARCHITECTURE

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER / CLIENT LAYER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ CLI │ TUI │ IDE Extension │ Desktop │ Web │ API │ Slack │ Telegram │ MCP   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENT GATEWAY                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Authentication                                                            │
│ User identity                                                             │
│ Project identity                                                          │
│ Session routing                                                           │
│ Rate limiting                                                             │
│ Model/provider routing                                                    │
│ Event streaming                                                           │
│ Client capabilities                                                        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SESSION ORCHESTRATOR                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Session lifecycle                                                         │
│ Thread / turn / item model                                                 │
│ Session DAG                                                                │
│ Parent / child agents                                                      │
│ Fork / branch / rollback                                                   │
│ Task state                                                                  │
│ Todo state                                                                  │
│ Approval state                                                              │
│ Background execution                                                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
               ┌───────────────────┼────────────────────┐
               │                   │                    │
               ▼                   ▼                    ▼
┌──────────────────────┐ ┌────────────────────┐ ┌────────────────────────┐
│    CONTEXT ENGINE    │ │ ORCHESTRATION CORE │ │  MEMORY / EXPERIENCE   │
│                      │ │                    │ │         OS             │
│ Working context      │ │ Planner            │ │ User memory            │
│ Retrieval            │ │ Agent router       │ │ Project memory         │
│ Compaction           │ │ Model router       │ │ Session history        │
│ Context budget       │ │ Task decomposition │ │ Skills                 │
│ Code graph           │ │ Parallelization   │ │ Failure bank           │
│ Evidence retrieval   │ │ Verification plan │ │ Experience graph       │
└──────────┬───────────┘ └──────────┬─────────┘ │ Memory lifecycle       │
           │                        │           └───────────┬────────────┘
           └────────────────────────┼───────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT SWARM                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Primary Agent                                                            │
│       │                                                                    │
│       ├── Planner Agent                                                     │
│       ├── Explorer Agent                                                    │
│       ├── Research Agent                                                    │
│       ├── Coding Agent                                                      │
│       ├── Debugging Agent                                                   │
│       ├── Reviewer Agent                                                    │
│       ├── Test Agent                                                        │
│       ├── Security Agent                                                    │
│       ├── Documentation Agent                                               │
│       └── Verification Agent                                                │
│                                                                            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TOOL RUNTIME                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Filesystem │ Terminal │ Git │ Browser │ Search │ HTTP │ Database           │
│ MCP        │ LSP      │ Docker │ Cloud │ Package Manager │ APIs            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SECURITY / EXECUTION PLANE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ Sandbox │ Permissions │ Approval Engine │ Network Policy │ Secrets │ Audit  │
│ Process Isolation │ Resource Limits │ Workspace Isolation │ Rollback        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VERIFICATION PLANE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Unit Tests │ Integration Tests │ E2E │ Lint │ Typecheck │ Build            │
│ Diff Review │ Static Analysis │ Security │ Browser Validation │ Benchmarks  │
│ Domain Validators │ Human Approval │ Regression Detection                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXPERIENCE / LEARNING PLANE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ Trajectory Mining │ Memory Extraction │ Skill Extraction │ Failure Mining  │
│ Eval Generation │ Prompt Evolution │ Tool Optimization │ Model Routing     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DATA PLANE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ PostgreSQL │ Object Store │ Vector Index │ FTS │ Graph Store │ Event Store  │
│ Git / Snapshots │ Session Archive │ Eval Dataset │ Telemetry               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 3. THE CORE DESIGN PRINCIPLE

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

For example:

```text
USER:
"Deploy staging."

KNOWLEDGE:
Staging runs on Kubernetes.

ACTION:
helm upgrade staging ...

OBSERVATION:
Pod crash-looped.

VERIFICATION:
Healthcheck failed.

RESOLUTION:
Missing environment variable.

LEARNING:
Staging deployment should validate required env vars before rollout.
```

Only the last item should become a candidate durable procedural memory.

---

# 4. AGENT GATEWAY

The gateway is the single entry point into the agent runtime.

```text
Client
  │
  ▼
Gateway
  ├── authenticate()
  ├── resolve_user()
  ├── resolve_project()
  ├── resolve_workspace()
  ├── resolve_session()
  ├── negotiate_capabilities()
  ├── apply_rate_limits()
  └── open_event_stream()
```

## Responsibilities

### Authentication

Support:

```text
API key
OAuth
local identity
service identity
machine identity
workspace identity
```

### User identity

Every agent invocation should know:

```text
user_id
workspace_id
project_id
session_id
client_id
device_id
```

### Client capabilities

The gateway should know whether the client supports:

```text
streaming
tool cards
approval dialogs
diff rendering
file previews
terminal output
browser previews
agent tree visualization
```

This allows the same core runtime to power CLI, IDE, desktop, and web.

---

# 5. SESSION MODEL

Do not use a single `conversation_id`.

Use:

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
   │      └── SUB-SESSIONS
   │
   └── OTHER SESSIONS
```

Every session should contain:

```text
session_id
project_id
workspace_id
user_id
parent_session_id
parent_turn_id
created_at
updated_at
status
objective
working_directory
git_commit
branch
snapshot_id
model
provider
token_usage
cost
duration
outcome
```

---

# 6. SESSION DAG

Sessions should be forkable.

```text
                     SESSION A
                         │
              ┌──────────┴──────────┐
              │                     │
          SESSION A1             SESSION A2
          JWT approach            OAuth approach
              │                     │
           SUCCESS                SUCCESS
              │                     │
              └──────────┬──────────┘
                         ▼
                 HUMAN / AGENT CHOICE
```

Forking must preserve:

```text
history
context state
workspace snapshot
tool observations
memory references
planning state
```

but allow independent future trajectories.

This is especially useful for:

```text
architecture alternatives
debugging hypotheses
model comparison
research approaches
A/B implementation strategies
```

---

# 7. SESSION STATES

A session should have an explicit finite state machine.

```text
CREATED
  ↓
INITIALIZING
  ↓
UNDERSTANDING
  ↓
PLANNING
  ↓
EXECUTING
  ↓
VERIFYING
  ├───────────────┐
  │               │
  ▼               ▼
SUCCESS         REPAIRING
  │               │
  │               └──→ EXECUTING
  │
  ▼
CLOSING
  ↓
LEARNING
  ↓
COMPLETED
```

Other terminal states:

```text
CANCELLED
FAILED
PAUSED
WAITING_FOR_USER
WAITING_FOR_APPROVAL
BLOCKED
```

---

# 8. ORCHESTRATION CORE

The orchestrator is the brain responsible for deciding:

```text
What needs to happen?
Who should do it?
Which model should do it?
In what order?
How much autonomy is appropriate?
What proves success?
When should execution stop?
```

It must not directly perform all tasks itself.

---

# 9. TASK UNDERSTANDING

Every user request should first become a structured task.

Example:

```json
{
  "objective": "Implement OAuth login",
  "task_type": "coding",
  "project": "neo-web",
  "scope": "authentication",
  "constraints": [
    "TypeScript",
    "existing auth architecture",
    "do not break existing users"
  ],
  "success_criteria": [
    "OAuth login works",
    "existing login works",
    "tests pass",
    "security checks pass"
  ],
  "risk": "high",
  "estimated_complexity": 0.82
}
```

The planner should operate on this representation rather than directly on raw user text.

---

# 10. TASK CLASSIFIER

Classify tasks into:

```text
CODING
DEBUGGING
REFACTORING
RESEARCH
DOCUMENTATION
DATA ANALYSIS
DEVOPS
SECURITY
DESIGN
PLANNING
MULTI-DOMAIN
```

Also classify:

```text
difficulty
risk
ambiguity
time horizon
required tools
required evidence
parallelization potential
```

---

# 11. PLANNER

The planner creates an executable task graph.

```text
USER REQUEST
     │
     ▼
PLANNER
     │
     ├── Goal
     ├── Constraints
     ├── Dependencies
     ├── Files
     ├── Tools
     ├── Agents
     ├── Verification
     └── Stop Conditions
```

Example:

```text
Implement feature
│
├── Understand existing architecture
│
├── Locate auth flow
│
├── Identify affected files
│
├── Design change
│
├── Implement
│
├── Write tests
│
├── Run tests
│
├── Security review
│
├── Diff review
│
└── Final validation
```

The planner must create explicit success conditions.

---

# 12. TASK GRAPH

Represent plans as a DAG rather than a list.

```text
A ───────► C ───────► F
           │
B ─────────┘

D ───────► E ───────► F
```

Where:

```text
A = inspect architecture
B = inspect tests
C = formulate implementation
D = inspect security
E = security constraints
F = implementation
```

Independent tasks can execute in parallel.

---

# 13. MODEL ROUTER

Never hard-code one model.

Use a routing layer:

```text
Task
 │
 ▼
Complexity Estimator
 │
 ├── latency requirement
 ├── reasoning requirement
 ├── coding requirement
 ├── context requirement
 ├── cost budget
 └── reliability requirement
 │
 ▼
MODEL ROUTER
```

Models can be classified as:

```text
FAST
BALANCED
REASONING
CODING
RESEARCH
REVIEW
CHEAP_BACKGROUND
```

Example:

```text
grep/search
    → fast model

simple edit
    → balanced model

complex refactor
    → coding/reasoning model

architecture
    → reasoning model

memory extraction
    → cheap background model

security review
    → independent reviewer model
```

The router itself should be evaluated continuously.

---

# 14. AGENT SWARM

The primary agent should not be responsible for every task.

```text
PRIMARY AGENT
      │
      ├── EXPLORE
      ├── PLAN
      ├── IMPLEMENT
      ├── TEST
      ├── REVIEW
      └── VERIFY
```

Specialized agents:

## Explorer

Purpose:

```text
Understand repository structure
Find files
Trace dependencies
Build code graph
```

Should minimize modification.

---

## Researcher

Purpose:

```text
Search web
Read papers
Read documentation
Inspect GitHub
Compare sources
Collect evidence
```

Output:

```text
claims
sources
evidence
confidence
contradictions
```

---

## Coding Agent

Purpose:

```text
Modify code
Create files
Refactor
Implement features
```

---

## Debugger

Purpose:

```text
reproduce
localize
hypothesize
test hypotheses
fix
re-run verification
```

---

## Reviewer

Purpose:

```text
Read diff
Find bugs
Find regressions
Question assumptions
Challenge implementation
```

The reviewer should ideally have a separate context from the implementer.

---

## Security Agent

Purpose:

```text
dependency risks
injection
secrets
permissions
network
filesystem
authentication
authorization
```

---

## Verification Agent

Purpose:

```text
Determine whether success criteria were actually satisfied.
```

It should be allowed to reject the primary agent's result.

---

# 15. AGENT COMMUNICATION

Agents should communicate through structured messages rather than raw conversational text.

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

This allows automated orchestration.

---

# 16. CONTEXT ENGINE

The context engine is one of the most important components.

The model should never simply receive:

```text
all previous messages
```

Instead:

```text
MODEL CONTEXT
├── SYSTEM POLICY
├── CURRENT TASK
├── ACTIVE PLAN
├── RELEVANT PROJECT KNOWLEDGE
├── RELEVANT USER KNOWLEDGE
├── RELEVANT SKILLS
├── RELEVANT CODE
├── RECENT TRAJECTORY
├── RELEVANT HISTORICAL EXPERIENCE
├── TOOL STATE
└── VERIFICATION REQUIREMENTS
```

---

# 17. CONTEXT BUDGET

Treat context like memory bandwidth.

Example:

```text
100% CONTEXT BUDGET

20% system / policies
20% current task + plan
25% relevant code
10% recent trajectory
10% project knowledge
5% user memory
5% skills
5% historical evidence
```

These allocations should be dynamic.

For coding:

```text
more code
less historical chat
```

For research:

```text
more evidence
less code
```

For debugging:

```text
more logs
more recent tool observations
```

---

# 18. CONTEXT RETRIEVAL

Use multiple retrieval mechanisms.

```text
                QUERY
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
   VECTOR        FTS        GRAPH
 SEARCH         SEARCH      SEARCH
       │          │           │
       └──────────┼───────────┘
                  ▼
             RERANKER
                  │
                  ▼
           CONTEXT SELECTOR
```

Use:

```text
Vector search
→ semantic similarity

FTS
→ exact concepts / identifiers / error messages

Graph
→ structural relationships

SQL filters
→ project/session/user/scope

Recency
→ recent relevant information
```

---

# 19. CONTEXT RELEVANCE SCORE

Every candidate context item should receive:

```text
relevance =
semantic_similarity
+ lexical_match
+ graph_relevance
+ recency
+ task_type_match
+ project_match
+ user_match
+ success_history
- redundancy
- contradiction
```

Only high-value items enter the model context.

---

# 20. COMPACTION

Never simply summarize the conversation.

Compaction should produce several artifacts:

```text
COMPACTION
├── current objective
├── current plan
├── decisions
├── completed work
├── unresolved problems
├── important observations
├── active constraints
├── tool state
└── evidence references
```

Example:

```text
Objective:
Implement OAuth.

Completed:
Auth provider integrated.

Decision:
Use PKCE.

Remaining:
Refresh token rotation.

Important:
Existing users use password auth.

Evidence:
tests/auth/oauth.spec.ts
```

The original trajectory must remain durable.

---

# 21. MEMORY OS

Memory should be divided into:

```text
USER MEMORY
PROJECT MEMORY
SESSION MEMORY
FACT MEMORY
PROCEDURAL MEMORY
FAILURE MEMORY
EXPERIENCE MEMORY
```

---

# 22. USER MEMORY

Store:

```text
preferences
working style
preferred technologies
communication preferences
recurring constraints
long-term goals
```

Example:

```text
User prefers TypeScript for web backends.
User prefers direct technical explanations.
User usually deploys with Docker.
```

Only persistent, repeatedly validated facts should become durable.

---

# 23. PROJECT MEMORY

Store:

```text
architecture
conventions
commands
deployment process
database structure
test strategy
known constraints
important dependencies
```

Example:

```text
API uses FastAPI.
Frontend uses Next.js.
Redis stores temporary job state.
Deployment uses Docker Compose.
```

---

# 24. FACT MEMORY

Facts should be represented as structured knowledge.

```json
{
  "subject": "project.neo",
  "predicate": "uses_framework",
  "object": "FastAPI",
  "scope": "project",
  "source": "repo-analysis-2026-08-17",
  "confidence": 0.98,
  "verified_at": "2026-08-17"
}
```

---

# 25. PROCEDURAL MEMORY

Procedural memory is different.

It represents:

```text
HOW TO DO SOMETHING
```

Example:

```text
Skill: deploy-neo-staging

1. Check branch
2. Pull latest
3. Run tests
4. Build image
5. Validate environment variables
6. Deploy
7. Check health endpoint
8. Verify logs
```

Skills should be versioned.

---

# 26. SKILL OBJECT

Every skill should contain:

```text
skill_id
name
description
version
scope
instructions
required_tools
examples
known_failures
dependencies
success_rate
usage_count
last_verified
eval_suite
status
```

Possible statuses:

```text
CANDIDATE
EXPERIMENTAL
ACTIVE
DEPRECATED
QUARANTINED
```

---

# 27. FAILURE MEMORY

The system must learn from failures.

Each failure should store:

```text
task
assumption
action
error
root cause
fix
verification
frequency
scope
related skills
```

Example:

```text
Failure:
Deployment failed.

Wrong assumption:
Environment variable existed.

Observed:
Container crashed.

Root cause:
Variable missing.

Fix:
Validate required environment variables.

Future prevention:
Pre-deployment configuration check.
```

---

# 28. EXPERIENCE GRAPH

The central long-term representation should be a graph.

```text
TASK
 │
 ├── USED → MODEL
 ├── USED → SKILL
 ├── TOUCHED → FILE
 ├── CAUSED → ERROR
 ├── FIXED_BY → ACTION
 ├── VERIFIED_BY → TEST
 ├── GENERATED → MEMORY
 └── GENERATED → SKILL
```

This allows queries such as:

```text
"How did we fix this before?"
"What usually breaks after changing auth?"
"Which model is best for this project?"
"Which skill has the highest success rate?"
```

---

# 29. MEMORY WRITE PIPELINE

Memory must never be written blindly.

```text
SESSION
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
MEMORY PROMOTION
```

---

# 30. MEMORY PROMOTION RULE

A candidate memory should only become durable when:

```text
repeated observation
OR
strong direct evidence
OR
explicit user instruction
```

A memory should be downgraded when:

```text
contradicted
stale
repeatedly unsuccessful
project changed
user explicitly corrects it
```

---

# 31. MEMORY DECAY

Every memory should have:

```text
confidence
last_verified
success_count
failure_count
scope
expiry
```

High-risk facts should expire faster.

Example:

```text
"User prefers dark mode."
→ long-lived

"Current deployment uses cluster X."
→ frequently revalidated

"Dependency version Y is installed."
→ immediately tied to repository state
```

---

# 32. TOOL RUNTIME

Tools should have a unified interface.

```text
Tool
├── name
├── description
├── input schema
├── output schema
├── permissions
├── cost
├── latency
├── risk
├── side effects
└── verification requirements
```

---

# 33. TOOL CATEGORIES

```text
Filesystem
Terminal
Git
Search
Browser
HTTP
Database
Package Manager
Docker
Cloud
MCP
LSP
Debugger
Image
Computer Control
```

---

# 34. TOOL SELECTION

The agent should not invoke tools arbitrarily.

It should estimate:

```text
What information do I need?
Which tool provides it?
What is the cheapest safe way to obtain it?
```

Example:

```text
Need to know where AuthService is used.

Bad:
run entire repository build.

Good:
ripgrep →
LSP references →
dependency graph.
```

---

# 35. TOOL RESULT NORMALIZATION

Every tool result should become:

```text
result_id
tool
input
output
duration
exit_code
files_changed
risk
stdout
stderr
structured_observations
```

Tool observations become part of the trajectory.

---

# 36. TERMINAL EXECUTION

Terminal execution should support:

```text
foreground
background
streaming
timeout
cancellation
resource limits
interactive process
PTY
log capture
exit status
```

The agent should be able to:

```text
start server
continue coding
poll server
inspect logs
stop server
```

without blocking the entire session.

---

# 37. SECURITY PLANE

Security must be independent from agent reasoning.

```text
AGENT REQUEST
     │
     ▼
POLICY ENGINE
     │
     ├── allowed?
     ├── requires approval?
     ├── sandbox?
     ├── network?
     └── secret access?
     │
     ▼
EXECUTION SANDBOX
```

---

# 38. PERMISSION LEVELS

Use:

```text
READ
WRITE
EXECUTE
NETWORK
SECRETS
PROCESS_CONTROL
SYSTEM
```

Each capability should be separately controllable.

---

# 39. RISK LEVELS

Every tool action gets:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

Examples:

```text
read file               LOW
edit source             MEDIUM
install package         MEDIUM
network request         MEDIUM
delete database         CRITICAL
push to production      CRITICAL
```

---

# 40. APPROVAL ENGINE

Approval should be contextual.

Instead of:

```text
Allow bash? yes/no
```

use:

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
Approve this package only
Approve this host
Approve all package installs
Deny
```

Approved policies can become reusable policy rules.

---

# 41. SANDBOX

The agent workspace should be isolated.

```text
HOST
 │
 ├── AGENT SANDBOX
 │      ├── workspace
 │      ├── tmp
 │      ├── tools
 │      ├── caches
 │      └── processes
 │
 └── USER DATA
```

Default:

```text
no host filesystem access
no unrestricted network
no arbitrary secrets
no privileged process
```

---

# 42. NETWORK POLICY

Network permissions should support:

```text
deny all
allow domain
allow hostname
allow port
allow temporary request
allow project policy
```

Record:

```text
domain
port
purpose
timestamp
approval
response
```

---

# 43. SECRET MANAGEMENT

Secrets should never enter model context unless explicitly required.

Use:

```text
secret reference
    ↓
tool runtime
    ↓
secret injection
    ↓
process
```

Never:

```text
API_KEY=abc123
```

inside the language-model context.

The model should see:

```text
SECRET_REF: STRIPE_API_KEY
```

where possible.

---

# 44. WORKSPACE MANAGEMENT

Every coding session should have:

```text
workspace
branch
snapshot
working tree
execution environment
dependency state
```

Before risky changes:

```text
snapshot
 ↓
execute
 ↓
verify
 ↓
commit / rollback
```

---

# 45. GIT INTEGRATION

Git should be a first-class tool.

The agent should understand:

```text
status
diff
history
branches
worktrees
commit
rebase
merge
stash
rollback
```

For experimental sub-agents:

```text
primary workspace
      │
      ├── worktree A
      ├── worktree B
      └── worktree C
```

This allows parallel implementation attempts.

---

# 46. VERIFICATION PLANE

No meaningful task should be considered complete merely because the model claims success.

The verification system should ask:

```text
Did it build?
Did tests pass?
Did behavior change correctly?
Did regression occur?
Did security remain intact?
Did the final diff match intent?
```

---

# 47. VERIFICATION LEVELS

```text
LEVEL 0
Model confidence

LEVEL 1
Static validation

LEVEL 2
Unit tests

LEVEL 3
Integration tests

LEVEL 4
End-to-end tests

LEVEL 5
Independent reviewer

LEVEL 6
Domain-specific evaluator

LEVEL 7
Human approval
```

Different task risk levels require different verification depth.

---

# 48. CODING COMPLETION PROTOCOL

For coding:

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
FINAL VERIFIER
```

The verifier can return:

```text
PASS
FAIL
PARTIAL
UNCERTAIN
```

---

# 49. FAILURE RECOVERY

When verification fails:

```text
FAILURE
   │
   ▼
CLASSIFY
   │
   ├── syntax
   ├── type
   ├── test
   ├── dependency
   ├── environment
   ├── logic
   ├── architecture
   └── external
   │
   ▼
ROOT CAUSE ANALYSIS
   │
   ▼
REPAIR STRATEGY
   │
   ▼
RETRY
```

The agent should not blindly retry the same action.

It needs a changed hypothesis.

---

# 50. RETRY POLICY

Retries should be bounded.

```text
retry_count
failure_similarity
strategy_change
time_budget
cost_budget
```

Example:

```text
Attempt 1 → failed test

Attempt 2 → changed implementation

Attempt 3 → changed architecture

Attempt 4 → escalate to reviewer

Attempt 5 → stop and ask user
```

Do not perform:

```text
same action
same error
same assumption
same tool
```

repeatedly.

---

# 51. RESEARCH ENGINE

Research should be a distinct subsystem.

```text
RESEARCH TASK
      │
      ▼
QUERY DECOMPOSITION
      │
      ├── question A
      ├── question B
      ├── question C
      └── question D
      │
      ▼
PARALLEL RESEARCHERS
      │
      ├── web
      ├── papers
      ├── GitHub
      ├── documentation
      └── benchmark data
      │
      ▼
EVIDENCE STORE
      │
      ▼
CONTRADICTION CHECK
      │
      ▼
SYNTHESIS
      │
      ▼
CITATION VERIFIER
```

---

# 52. RESEARCH EVIDENCE OBJECT

Each claim:

```text
claim_id
claim
source_url
source_type
published_at
retrieved_at
excerpt
source_authority
confidence
supporting_evidence
contradicting_evidence
freshness
```

Research responses should be generated from these evidence objects.

---

# 53. RESEARCH SOURCE RANKING

Rank sources by:

```text
primary source
official documentation
original paper
repository
benchmark
expert analysis
news
community discussion
```

Recency should be task-dependent.

For current information:

```text
freshness weight HIGH
```

For historical information:

```text
source authority HIGH
```

---

# 54. LONG-RUNNING TASKS

Long tasks need durable execution.

```text
TASK
 │
 ▼
JOB
 │
 ├── checkpoint
 ├── progress
 ├── child sessions
 ├── logs
 ├── artifacts
 └── status
```

The process should survive:

```text
terminal close
client disconnect
network reconnect
context compaction
agent restart
```

---

# 55. BACKGROUND AGENTS

Allow scheduled and event-triggered execution.

Examples:

```text
Every morning:
Check GitHub issues.

After PR:
Run regression analysis.

Every night:
Evaluate failed agent sessions.

After deployment:
Monitor service.

Every week:
Review learned skills.
```

These should create independent sessions rather than mutating the interactive chat session.

---

# 56. EVENT BUS

Every major system action emits an event.

```text
SessionCreated
TaskStarted
PlanCreated
ToolRequested
ApprovalRequested
ToolExecuted
FileChanged
TestStarted
TestFailed
TestPassed
AgentSpawned
AgentCompleted
MemoryCandidateCreated
SkillCandidateCreated
EvalCreated
SessionCompleted
```

This provides observability and enables hooks.

---

# 57. HOOK SYSTEM

Hooks should exist at:

```text
SessionStart
PromptReceived
TaskClassified
PlanCreated
BeforeModelCall
AfterModelCall
BeforeTool
AfterTool
BeforeCompaction
AfterCompaction
AgentStart
AgentStop
VerificationStart
VerificationComplete
SessionClose
MemoryWrite
SkillPromotion
EvalPromotion
```

Hooks can:

```text
observe
modify
block
augment
route
```

but privileged hooks must be policy controlled.

---

# 58. OBSERVABILITY

Every session should produce:

```text
trajectory
metrics
events
cost
latency
tool usage
model usage
verification
errors
memory writes
skill writes
```

Metrics:

```text
time_to_first_token
time_to_first_action
task_duration
tokens_in
tokens_out
tool_latency
model_latency
cost
retry_count
verification_pass_rate
```

---

# 59. AGENT QUALITY METRICS

Track:

```text
task_success_rate
first_attempt_success
repair_success
verification_accuracy
tool_efficiency
context_efficiency
memory_precision
memory_recall
skill_success_rate
regression_rate
cost_per_success
time_per_success
```

---

# 60. LEARNING PLANE

The learning plane runs after successful and failed sessions.

```text
TRAJECTORY
    │
    ▼
OUTCOME ANALYZER
    │
    ├── what worked?
    ├── what failed?
    ├── what surprised us?
    ├── what was inefficient?
    └── what was reusable?
    │
    ▼
CANDIDATE GENERATION
    │
    ├── memory
    ├── skill
    ├── failure pattern
    ├── eval
    ├── routing rule
    └── prompt improvement
```

---

# 61. SELF-IMPROVEMENT MUST BE GATED

Never directly modify the production agent.

Use:

```text
CURRENT AGENT
     │
     ▼
OBSERVATIONS
     │
     ▼
HYPOTHESIS
     │
     ▼
CANDIDATE CHANGE
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
     │
     └── better → candidate promotion
                         │
                         ▼
                     shadow mode
                         │
                         ▼
                     production
```

---

# 62. WHAT CAN SELF-IMPROVE?

The system should be capable of optimizing:

```text
system prompts
planning strategies
tool descriptions
tool selection
model routing
skills
retrieval ranking
context allocation
memory extraction
verification strategies
research strategies
retry strategies
```

Later:

```text
agent code
tool implementations
orchestration algorithms
```

but code evolution should require significantly stronger evaluation gates.

---

# 63. EVAL SYSTEM

Every meaningful agent capability should have an eval.

```text
EVAL
├── dataset
├── task
├── expected behavior
├── success criteria
├── grader
├── baseline
├── candidate
└── regression threshold
```

---

# 64. EVAL TYPES

```text
Unit Eval
Behavioral Eval
Coding Eval
Research Eval
Tool Eval
Memory Eval
Skill Eval
Security Eval
Long-Horizon Eval
Cost Eval
Latency Eval
Regression Eval
```

---

# 65. MEMORY EVAL

Test:

```text
Did the agent remember the fact?
Did it retrieve the fact?
Did it retrieve it at the correct time?
Did it avoid irrelevant memories?
Did it respect scope?
Did it update stale memory?
Did memory improve task success?
```

---

# 66. SKILL EVAL

For every skill:

```text
baseline
vs
skill-enabled
```

Measure:

```text
success rate
latency
cost
tool calls
failure rate
regression rate
```

A skill that does not improve outcomes should not remain active.

---

# 67. MODEL ROUTER EVAL

Track model performance by task class:

```text
task_class
model
success
cost
latency
verification
```

Then periodically retrain or update routing policies.

---

# 68. FAILURE BANK → EVAL GENERATION

This is one of the most important loops.

```text
REAL FAILURE
    │
    ▼
ABSTRACT FAILURE PATTERN
    │
    ▼
GENERATE EVAL
    │
    ▼
ADD TO REGRESSION SUITE
    │
    ▼
FUTURE AGENT
```

Therefore every serious failure makes the system harder to fool again.

---

# 69. PROJECT BOOTSTRAPPING

When entering an unknown repository:

```text
PROJECT INIT
   │
   ├── detect language
   ├── detect framework
   ├── detect package manager
   ├── detect test framework
   ├── inspect git
   ├── inspect CI
   ├── inspect deployment
   ├── build dependency graph
   ├── detect architecture
   ├── discover conventions
   └── create project knowledge
```

Generate a machine-readable project manifest.

---

# 70. PROJECT MANIFEST

```yaml
project:
  name: neo

stack:
  backend: python
  frontend: nextjs
  database: postgres

commands:
  test: pytest
  lint: ruff
  typecheck: mypy
  build: ...

architecture:
  backend: ...
  frontend: ...

deployment:
  platform: ...

conventions:
  ...

critical_files:
  ...
```

This replaces repeatedly rediscovering repository information.

---

# 71. CODE GRAPH

Build a graph:

```text
FILE
 ├── IMPORTS → FILE
 ├── DEFINES → FUNCTION
 ├── CALLS → FUNCTION
 ├── EXTENDS → CLASS
 ├── TESTED_BY → TEST
 ├── CONFIGURED_BY → CONFIG
 └── DEPLOYED_BY → SERVICE
```

The context engine queries this graph when selecting code.

---

# 72. REPOSITORY INDEX

Maintain:

```text
AST index
symbol index
dependency graph
semantic embeddings
FTS index
git history
test mapping
ownership mapping
```

This allows extremely targeted retrieval.

---

# 73. USER ONBOARDING

The first interaction should create:

```text
User Profile
Workspace
Projects
Preferences
Permissions
Model defaults
Privacy settings
Memory policy
```

Ask only high-value questions.

Everything else should be learned gradually.

---

# 74. FIRST PROJECT ONBOARDING

The agent should perform:

```text
scan
→ summarize
→ map architecture
→ detect commands
→ detect tests
→ inspect git
→ detect conventions
→ propose project memory
```

Then show:

```text
I understand this project as:

Backend: FastAPI
Frontend: Next.js
Database: PostgreSQL
Tests: pytest
Deployment: Docker

I found 3 critical architectural areas:
...
```

The user can correct the agent.

Corrections become strong memory signals.

---

# 75. CHAT EXPERIENCE

The user should be able to talk naturally.

Examples:

```text
"Fix the login bug."

"Research whether Redis Streams are better here."

"Try another architecture."

"Do the implementation but don't commit."

"Run three approaches and compare them."

"Remember this."

"Forget what you learned about deployment."

"Why did you make this decision?"

"What did we learn from the previous attempt?"
```

The system must translate natural language into operational state changes.

---

# 76. EXPLICIT USER CONTROL OF MEMORY

Commands:

```text
remember ...
forget ...
show memory
show project knowledge
show learned skills
disable memory
disable learning
explain why you remembered this
```

Memory must remain inspectable and editable.

---

# 77. EXPLAINABILITY

The agent should be able to answer:

```text
Why did you choose this model?
Why did you modify this file?
Why did you retrieve this memory?
Why did you distrust this source?
Why did you retry?
Why did you stop?
Why did you promote this skill?
```

This should come from recorded structured state, not fabricated explanations.

---

# 78. COST CONTROL

The orchestrator should continuously track:

```text
token budget
time budget
tool budget
model budget
network budget
compute budget
```

Example:

```text
Task budget:
$1.00
10 minutes
100 tool calls
```

The agent should optimize within those constraints.

---

# 79. SPEED OPTIMIZATION

The agent should reduce latency through:

```text
parallel search
parallel sub-agents
cached project graph
cached retrieval
persistent sessions
background indexing
streaming
incremental tool results
cheap-model classification
warm execution environments
```

Never use a frontier reasoning model for trivial classification.

---

# 80. PARALLELIZATION POLICY

Only parallelize when tasks are independent.

Good:

```text
Research A ─┐
Research B ─┼→ synthesis
Research C ─┘
```

Bad:

```text
three agents editing same file
```

For conflicting edits:

```text
separate worktrees
```

---

# 81. AGENT HANDOFF

Every sub-agent must return:

```text
objective
actions
findings
artifacts
files_changed
tests
failures
confidence
recommendation
```

Not an unstructured essay.

---

# 82. FINAL ANSWER GENERATION

The conversational response should be generated from the final structured state.

For coding:

```text
Outcome
Changes
Verification
Files
Tests
Known limitations
Next action
```

For research:

```text
Answer
Evidence
Sources
Confidence
Contradictions
Open questions
```

---

# 83. SESSION CLOSEOUT

Every session should automatically run:

```text
SESSION CLOSE
    │
    ├── summarize outcome
    ├── persist trajectory
    ├── record artifacts
    ├── record failures
    ├── extract memory candidates
    ├── extract skill candidates
    ├── generate eval candidates
    ├── update project graph
    ├── update model statistics
    └── finalize session
```

---

# 84. SESSION CLOSEOUT EXAMPLE

```text
Session completed.

Objective:
Implement OAuth login.

Result:
SUCCESS

Changed:
- auth/oauth.ts
- auth/callback.ts
- tests/oauth.spec.ts

Verification:
✓ lint
✓ typecheck
✓ unit tests
✓ integration tests
✓ security review

Learned:
- OAuth callbacks require PKCE verification.

Memory candidate:
Project-level OAuth policy.

Skill candidate:
oauth-debugging-v2.

Eval candidate:
Concurrent refresh-token scenario.

No deployment performed.
```

---

# 85. CONTINUOUS AGENT LOOP

The whole system becomes:

```text
┌───────────────┐
│ USER / EVENT  │
└───────┬───────┘
        ▼
┌───────────────┐
│ TASK MODEL    │
└───────┬───────┘
        ▼
┌───────────────┐
│ CONTEXT       │
│ RETRIEVAL     │
└───────┬───────┘
        ▼
┌───────────────┐
│ PLAN          │
└───────┬───────┘
        ▼
┌───────────────┐
│ ROUTE         │
│ MODEL/AGENT   │
└───────┬───────┘
        ▼
┌───────────────┐
│ EXECUTE       │◄─────────────┐
└───────┬───────┘              │
        ▼                      │
┌───────────────┐              │
│ VERIFY        │              │
└───────┬───────┘              │
        │                      │
    FAIL│                      │
        ▼                      │
┌───────────────┐              │
│ DIAGNOSE      │──────────────┘
└───────┬───────┘
        │
     SUCCESS
        ▼
┌───────────────┐
│ CLOSEOUT      │
└───────┬───────┘
        ▼
┌───────────────────────────┐
│ EXPERIENCE MINING         │
├───────────────────────────┤
│ Memory                    │
│ Skills                    │
│ Failures                  │
│ Evals                     │
│ Routing                   │
│ Tool performance          │
└──────────────┬────────────┘
               ▼
┌───────────────────────────┐
│ EVALUATION                │
└──────────────┬────────────┘
               ▼
┌───────────────────────────┐
│ PROMOTION                 │
│ only if verified better   │
└──────────────┬────────────┘
               │
               └──────────────► FUTURE TASKS
```

---

# 86. THE AGENT'S INTERNAL DECISION LOOP

Every meaningful action should conceptually follow:

```text
OBSERVE
  ↓
UNDERSTAND
  ↓
PLAN
  ↓
PREDICT
  ↓
ACT
  ↓
OBSERVE RESULT
  ↓
VERIFY
  ↓
UPDATE BELIEF
  ↓
ACT AGAIN OR FINISH
```

This is more important than the prompt itself.

---

# 87. THE COMPLETE DATA MODEL

Core entities:

```text
User
Workspace
Project
Repository
Session
Turn
Agent
Task
Plan
TaskNode
Tool
ToolCall
ToolResult
Approval
Policy
Artifact
File
Snapshot
Commit
Memory
MemoryEvidence
Skill
SkillVersion
Failure
Experience
Eval
EvalRun
Model
ModelRoute
Event
Metric
ResearchClaim
ResearchSource
```

Relations:

```text
User → Workspace
Workspace → Project
Project → Repository
Project → Session
Session → Turn
Turn → ToolCall
Session → Experience
Experience → Memory
Experience → Skill
Failure → Eval
Skill → Eval
Model → ModelRoute
```

---

# 88. DATA STORAGE

Use specialized stores rather than forcing everything into one database.

```text
PostgreSQL
→ authoritative metadata

Object Storage
→ large artifacts / logs / datasets

FTS
→ exact historical search

Vector DB / pgvector
→ semantic retrieval

Graph
→ code / experience relationships

Git
→ source control and snapshots

Event Store
→ agent telemetry / trajectory

Redis
→ queues / locks / ephemeral state
```

A PostgreSQL + pgvector + FTS implementation can be the initial deployment without immediately introducing a separate graph database.

---

# 89. RECOMMENDED INITIAL STACK

For a production-grade implementation:

```text
Core runtime:
Rust

Agent orchestration:
Python or TypeScript service layer

API:
gRPC / WebSocket / HTTP

Database:
PostgreSQL

Semantic retrieval:
pgvector

Full text:
PostgreSQL FTS

Queue:
Redis / NATS

Object storage:
S3-compatible

Execution:
Docker / Firecracker / isolated workers

Git:
native Git

Observability:
OpenTelemetry

Metrics:
Prometheus

Logs:
structured JSON

Tracing:
OpenTelemetry
```

The most security-sensitive execution layer should remain strongly isolated from the higher-level agent logic.

---

# 90. RECOMMENDED PROCESS MODEL

```text
Gateway
   │
   ▼
Orchestrator
   │
   ├── Agent worker
   ├── Research worker
   ├── Verification worker
   ├── Background learning worker
   └── Evaluation worker
            │
            ▼
       Execution Sandbox
```

Workers should be disposable.

The durable state lives outside the worker.

---

# 91. CRITICAL DESIGN RULE

The LLM must be treated as:

```text
probabilistic reasoning component
```

not:

```text
source of truth
```

Source of truth comes from:

```text
repository
database
tool result
test
external source
human instruction
verified memory
```

The model proposes.

The environment verifies.

---

# 92. TRUST HIERARCHY

Use:

```text
HUMAN EXPLICIT INSTRUCTION
        ↓
SYSTEM POLICY
        ↓
VERIFIED SOURCE
        ↓
CURRENT TOOL OBSERVATION
        ↓
VERIFIED MEMORY
        ↓
HIGH-CONFIDENCE SKILL
        ↓
HISTORICAL EXPERIENCE
        ↓
MODEL ASSUMPTION
```

When these conflict, higher-level evidence wins.

---

# 93. WHAT MAKES THIS AGENT "GROW WITH YOU"

The growth loop is:

```text
YOU
 │
 ▼
TASK
 │
 ▼
AGENT ATTEMPTS
 │
 ▼
FAILURE / SUCCESS
 │
 ▼
EXPERIENCE
 │
 ▼
MEMORY
 │
 ▼
SKILL
 │
 ▼
EVAL
 │
 ▼
VERIFIED IMPROVEMENT
 │
 ▼
BETTER FUTURE PERFORMANCE
 │
 └─────────────────────────► YOU
```

The system should therefore improve in:

```text
knowledge
procedures
routing
planning
tool selection
verification
memory
research
cost efficiency
latency
```

rather than merely getting a larger prompt.

---

# 94. FINAL REFERENCE ARCHITECTURE

```text
                                      USER
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             │                          │                          │
           CLI                         IDE                        WEB
             │                          │                          │
             └──────────────────────────┼──────────────────────────┘
                                        ▼
                              ┌───────────────────┐
                              │ AGENT GATEWAY     │
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ SESSION MANAGER   │
                              │                   │
                              │ sessions          │
                              │ turns             │
                              │ forks             │
                              │ checkpoints       │
                              │ approvals         │
                              └─────────┬─────────┘
                                        ▼
                         ┌────────────────────────────┐
                         │      ORCHESTRATOR          │
                         │                            │
                         │ Task understanding         │
                         │ Planning                   │
                         │ Scheduling                 │
                         │ Model routing              │
                         │ Agent routing              │
                         └─────────────┬──────────────┘
                                       │
              ┌────────────────────────┼───────────────────────┐
              │                        │                       │
              ▼                        ▼                       ▼
     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
     │ CONTEXT ENGINE  │     │ MEMORY OS       │     │ AGENT SWARM    │
     │                 │     │                 │     │                 │
     │ Retrieval       │     │ User            │     │ Planner         │
     │ Compaction      │     │ Project         │     │ Explorer        │
     │ Code graph      │     │ Facts           │     │ Researcher      │
     │ Context budget  │     │ Skills          │     │ Coder           │
     │ Evidence        │     │ Failures        │     │ Debugger        │
     └────────┬────────┘     │ Experience      │     │ Reviewer        │
              │              └────────┬────────┘     │ Verifier        │
              │                       │              └────────┬────────┘
              └───────────────────────┼───────────────────────┘
                                      ▼
                            ┌─────────────────────┐
                            │ MODEL ROUTER        │
                            │                     │
                            │ fast                │
                            │ coding              │
                            │ reasoning           │
                            │ research            │
                            │ reviewer            │
                            │ background          │
                            └─────────┬───────────┘
                                      ▼
                            ┌─────────────────────┐
                            │ MODEL PROVIDERS     │
                            │                     │
                            │ Provider A          │
                            │ Provider B          │
                            │ Provider C          │
                            │ Local Models        │
                            └─────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ TOOL RUNTIME         │
                           │                      │
                           │ Terminal             │
                           │ Filesystem           │
                           │ Git                  │
                           │ Browser              │
                           │ Search               │
                           │ HTTP                 │
                           │ DB                   │
                           │ MCP                  │
                           │ LSP                  │
                           │ Docker               │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ SECURITY RUNTIME     │
                           │                      │
                           │ Sandbox              │
                           │ Permissions          │
                           │ Approval             │
                           │ Network              │
                           │ Secrets              │
                           │ Resource limits      │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ VERIFICATION         │
                           │                      │
                           │ Tests                │
                           │ Build                │
                           │ Lint                 │
                           │ Typecheck            │
                           │ Diff                 │
                           │ Security             │
                           │ Reviewer             │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ TRAJECTORY STORE     │
                           │                      │
                           │ Every action         │
                           │ Every observation    │
                           │ Every failure        │
                           │ Every result         │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ LEARNING ENGINE      │
                           │                      │
                           │ Experience mining    │
                           │ Memory extraction    │
                           │ Skill generation     │
                           │ Failure mining       │
                           │ Eval generation      │
                           │ Routing learning     │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ EVALUATION SYSTEM    │
                           │                      │
                           │ Coding              │
                           │ Research            │
                           │ Memory              │
                           │ Skills              │
                           │ Security            │
                           │ Long horizon        │
                           │ Regression          │
                           └──────────┬───────────┘
                                      ▼
                           ┌──────────────────────┐
                           │ PROMOTION ENGINE     │
                           │                      │
                           │ candidate            │
                           │ shadow               │
                           │ A/B                  │
                           │ production           │
                           └──────────┬───────────┘
                                      │
                                      └──────────────► BETTER AGENT
```

---

# 95. THE FIVE MOST IMPORTANT ENGINEERING PRINCIPLES

```text
1. Durable history ≠ active context.

2. Memory ≠ conversation summary.

3. Agent output ≠ verified truth.

4. Self-improvement ≠ unrestricted self-modification.

5. A skill is only valuable if its eval proves that it improves behavior.
```

---

# 96. FINAL DESIGN TARGET

The finished system should feel to a user like:

```text
"This is the same engineer I have been working with for months."
```

The agent should know:

```text
my projects
my codebase
my conventions
my preferred tools
my previous decisions
my common mistakes
my successful workflows
my research interests
my previous failures
my preferred degree of autonomy
```

But it should never blindly assume those things.

Instead:

```text
REMEMBER
   +
RETRIEVE
   +
VERIFY
   +
ACT
   +
LEARN
```

That is the core operating loop.

The ideal architecture therefore combines:

```text
CODEX
→ execution + sandbox + protocol

CLAUDE CODE
→ agent workflow + hooks + teams + coding UX

OPENCODE
→ session architecture + provider abstraction + extensibility

HERMES
→ memory + skills + persistence + self-improvement + automation
```

and adds the missing layer:

```text
EVIDENCE-BACKED EXPERIENCE GRAPH
+
CONTINUOUS EVALUATION
+
CONTROLLED SELF-IMPROVEMENT
```

That combination is the foundation for a genuinely persistent coding/research agent rather than another model wrapped around a terminal.

