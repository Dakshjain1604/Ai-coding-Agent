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

## 📄 Files in This Repository

- `src/core/agents/` - The core `UniversalAgent` and specialized toolsets.
- `src/core/orchestrator/` - The parallel execution engine and multi-step planners.
- `src/core/tools/` - Built-in secure tools (shell execution, workspace verification, diff merging).
- `src/memory/` - SQLite context window manager.
- `src/providers/` - Multi-provider routing and resilient fallback logic.

---

*Built for developers who demand robust, autonomous, and resilient AI coding assistance.*
