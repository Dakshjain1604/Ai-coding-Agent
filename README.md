# Coding Agent

An advanced, autonomous, production-grade AI coding agent featuring parallel orchestration, intelligent context management, dynamic provider fallbacks, and multi-model routing.

## 🚀 Features

- **Universal Agent Mode**: Automatically detects the task type (coding, reviewing, planning, debugging) and switches toolsets on the fly.
- **Parallel Orchestration**: Spin up multiple sub-agents in parallel to execute complex, multi-step plans concurrently.
- **Dynamic Provider Fallbacks**: Seamlessly recovers from API rate limits and server outages by dynamically routing to alternative AI providers.
- **Intelligent Context Management**: Proactively compacts conversational context (70% threshold, 100% hard cap) while preserving critical system prompts, powered by SQLite.
- **Strict Security Guardrails**: Actively intercepts and blocks potentially destructive shell commands (like `rm -rf`, `sudo`, piping to `bash`) from being blindly executed by the AI.
- **AST Dependency Graphs**: Automatically scans your project's syntax tree to map out file dependencies, ensuring full-project awareness during refactors.
- **Git Rollback System**: Provides instant snapshots before complex changes and visual diff previews to prevent destructive edits.
- **Multi-Model Routing**: Intelligently routes tasks to the best, most cost-effective models (Ollama, Claude, OpenRouter, Groq, etc.) based on task complexity.

## 🤖 Powered By

This tool integrates natively with top-tier LLM providers:
- **Anthropic Claude** (Opus, Sonnet, Haiku)
- **OpenAI** (GPT-4o, etc)
- **OpenRouter & Groq**
- **Ollama** (Local execution for private, offline AI capabilities)
- **NVIDIA NIM API** 

## 📦 Installation

```bash
# Clone or download this repository
git clone <repository-url>
cd coding-agent

# Install dependencies
npm install

# Build the TypeScript project
npm run build
```

## 💡 Usage

You can run the agent by executing the CLI binary:

```bash
# Launch interactive mode
node bin/run.js -i

# Run a specific task directly
node bin/run.js run "Refactor the authentication controller to use JWTs"

# Run a workspace verification task
node bin/run.js run "Verify workspace integrity" --no-confirm
```

## ⚙️ Configuration

Configure your API keys by setting them in your environment variables:

```bash
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
export GROQ_API_KEY="your-key"
export OPENROUTER_API_KEY="your-key"
export NVIDIA_API_KEY="your-key"
```

## 🛡️ Fault Tolerance & Guardrails

Coding Agent is built for production robustness:
- **Action Cycle Detector**: Prevents infinite tool loops by intercepting repetitive LLM actions and forcing it to rethink its approach.
- **Self-Healing Loop**: If a tool fails (e.g. compilation error or testing failure), the agent receives the error directly and iteratively self-corrects the code.

## 🏆 Terminal-Bench 2.0 Benchmark Results

CodingAgent includes an automated evaluation harness integrated with [Harbor](https://harborframework.com) for rigorous testing on [Terminal-Bench 2.0](https://github.com/laude-ai/terminal-bench), covering complex real-world software engineering, systems administration, cryptography, algorithm design, and reverse-engineering tasks.

### 🌟 Key Solved Challenges (Reward 1.00 / 100% Correctness)

The agent has achieved perfect **Reward 1.00** pass scores across 13 diverse, high-complexity Terminal-Bench challenges with ultra-low token cost and rapid turnaround:

| Benchmark Challenge | Domain | Reward | Turns | Execution Cost | Methodology & Verification |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **`write-compressor`** | Compression & Information Theory | **1.00** | 21 | $0.034 | Reversed adaptive arithmetic decompressor with base-255 interval tracking in C, built matching Python encoder, applied greedy LZ77 ($\ge 3$ nt threshold), achieving 2,476 B ($\le 2,500$ B budget) with 100% byte-exact reconstruction (`cmp` match). |
| **`feal-linear-cryptanalysis`** | Cryptanalysis & SMT Solvers | **1.00** | 33 | $0.076 | Formulated 4-round FEAL Feistel operations and 20-bit seed expansion in Z3 SMT solver using bit-vector constraints over 6 known pairs. Recovered all 4 seeds, matching all 32 pairs and decrypting 100/100 ciphertexts. |
| **`feal-differential-cryptanalysis`** | Cryptography & Security | **1.00** | 7 | $0.008 | Derived differential characteristics over round functions, extracted round subkeys, and decrypted target verification challenges with zero errors. |
| **`polyglot-rust-c`** | Compilers & Arbitrary Precision | **1.00** | 6 | $0.021 | Constructed dual-syntax polyglot exploiting block-comment nesting asymmetry (`/* /* */`) and raw string literals. Implemented arbitrary-precision Fibonacci up to $N=300$, verified byte-identical output across `rustc` and `g++`. |
| **`cancel-async-tasks`** | Async Systems & Concurrency | **1.00** | 4 | $0.0008 | Architected bounded task concurrency via Python 3.11 `asyncio.TaskGroup` paired with `asyncio.Semaphore`. Shielded task cancellation cleanup routines under `SIGINT`, passing 6/6 tests. |
| **`bn-fit-modify`** | Bayesian Statistics & Causal Inference | **1.00** | 10 | $0.003 | Learned DAG structure from 10k continuous samples, estimated BN parameters, applied Pearl's graph mutilation rule ($do(Y=0.0)$) to sever incoming parent edges while keeping child dependencies, passing 9/9 tests. |
| **`sparql-university`** | Semantic Web & Knowledge Graphs | **1.00** | 8 | $0.002 | Wrote multi-condition SPARQL 1.1 query over RDF graph with decoupled existential subqueries across independent academic department relations, achieving 100% recall. |
| **`llm-inference-batching-scheduler`**| Machine Learning Systems | **1.00** | 7 | $0.012 | Designed dynamic request batching engine honoring strict latency budgets, KV-cache memory constraints, and priority preemption rules. |
| **`configure-git-webserver`** | Linux Systems Administration | **1.00** | 16 | $0.005 | Configured multi-user SSH authentication, Git bare repositories, executable post-receive deployment hooks, and Nginx HTTP static serving with strict permissions. |
| **`fix-code-vulnerability`** | Application Security | **1.00** | 12 | $0.003 | Diagnosed buffer overflow and input sanitization vulnerabilities in C/C++ backend, applied secure memory bounds checking, and validated with regression suites. |
| **`model-extraction-relu-logits`** | Machine Learning Security | **1.00** | 15 | $0.019 | Reconstructed 30 hidden neuron hyperplanes of a ReLU network by probing scalar logits and clustering gradient jump discontinuities with cosine similarity $> 0.9999$. |
| **`password-recovery`** | Digital Forensics | **1.00** | 20 | $0.032 | Carved unallocated ext4 filesystem blocks directly from raw block devices (`/dev/...`), parsed deleted credential fragments, and recovered PBKDF2 hash digests. |
| **`db-wal-recovery`** | Database Internals | **1.00** | 18 | $0.025 | Parsed corrupted SQLite write-ahead log (WAL) frames, extracted committed database transactions, and reconstructed state prior to crash truncation. |

### 📊 Benchmark Efficiency Metrics

- **Average Cost Per Challenge**: **<$0.02 USD** (running on cost-effective frontier models such as GLM-5 Flash via OpenRouter).
- **Average Turns to Solution**: **13 turns** (ranging from 4 turns on concurrent systems to 33 turns on SMT cryptanalysis).
- **Telemetry & Tracing**: Every execution captures complete HTTP request traces (`http.jsonl`), turn-by-turn tool inputs/outputs, model latency, token budgets, and step-level diagnostics in `bench/jobs/`.

### 🔬 Reproducing Benchmark Runs

To run the Terminal-Bench evaluation suite using Harbor:

```bash
# 1. Install Harbor framework
uv tool install harbor

# 2. Build the self-contained Linux distribution bundle
./bench/harbor_agent/build_bundle.sh amd64

# 3. Execute the full benchmark suite
cd bench && PYTHONPATH=. harbor run --config exp_hard_all_config.json -o jobs --env-file ../.env

# 4. Generate structured analysis report
python3 analyze.py jobs/exp-hard-all-30
```

## 📄 Files in This Repository

- `src/core/agents/` - The core `UniversalAgent` and specialized toolsets.
- `src/core/orchestrator/` - The parallel execution engine and multi-step planners.
- `src/core/tools/` - Built-in secure tools (shell execution, workspace verification, diff merging).
- `src/memory/` - SQLite context window manager.
- `src/providers/` - Multi-provider routing and resilient fallback logic.
- `bench/` - Terminal-Bench evaluation harness, Harbor adapter, benchmark configs, and telemetry analyzer.

---

*Built for developers who demand robust, autonomous, and resilient AI coding assistance.*

