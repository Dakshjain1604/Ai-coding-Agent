"""Harbor installed-agent adapter for CodingAgent.

Uploads the prebuilt linux bundle (see build_bundle.sh) into the task
container and runs the harness (`coding-agent exec`) through runner.mjs.
The harness writes its trajectory, result and progress log into /logs/agent.

Usage (from bench/):
    PYTHONPATH=. harbor run -p tasks -i fix-git \
        -a harbor_agent.coding_agent:CodingAgent \
        -m openrouter/nvidia/nemotron-3-ultra-550b-a55b:free \
        -o jobs --env-file ../.env
Optional: --ak timeout_sec=600 (otherwise derived from the task's agent timeout),
          --ak reasoning_effort=high,
          --ak max_turns=24 (caps model requests per task, e.g. under a daily quota).
"""

import json
import os
import shlex
import tomllib
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BUILD_DIR = Path(__file__).resolve().parent.parent / "build"
INSTALL_ROOT = "/installed-agent"
AGENT_DIR = f"{INSTALL_ROOT}/coding-agent"
NODE_BIN = f"{INSTALL_ROOT}/node/bin/node"

# Only the model credential is forwarded into the container — never the host env.
FORWARDED_ENV_KEYS = ("OPENROUTER_API_KEY",)

DEFAULT_TIMEOUT_SEC = 900
# Harness deadline = Harbor's agent timeout minus this, so the harness ends
# its own run (and writes result.json) before Harbor cancels the exec.
TIMEOUT_MARGIN_SEC = 45
MIN_TIMEOUT_SEC = 60


class CodingAgent(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        timeout_sec: int | str | None = None,
        reasoning_effort: str | None = None,
        reasoning_max_tokens: int | str | None = None,
        max_turns: int | str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._explicit_timeout_sec = int(timeout_sec) if timeout_sec is not None else None
        self._reasoning_effort = reasoning_effort
        self._reasoning_max_tokens = int(reasoning_max_tokens) if reasoning_max_tokens is not None else None
        self._max_turns = int(max_turns) if max_turns is not None else None

    @staticmethod
    @override
    def name() -> str:
        return "coding-agent"

    @override
    def get_version_command(self) -> str | None:
        return f"{NODE_BIN} -p \"require('{AGENT_DIR}/package.json').version\""

    async def _container_arch(self, environment: BaseEnvironment) -> str:
        result = await environment.exec(command="uname -m", user="root")
        machine = (result.stdout or "").strip()
        return "arm64" if machine in ("aarch64", "arm64") else "amd64"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        arch = await self._container_arch(environment)
        bundle = BUILD_DIR / f"coding-agent-linux-{arch}.tar.gz"
        if not bundle.exists():
            raise FileNotFoundError(
                f"{bundle} missing — run bench/harbor_agent/build_bundle.sh {arch}"
            )
        remote = f"/tmp/{bundle.name}"
        await environment.upload_file(bundle, remote)
        await self.exec_as_root(
            environment,
            command=(
                f"set -e; mkdir -p {INSTALL_ROOT} && tar -xzf {remote} -C {INSTALL_ROOT} "
                f"&& rm -f {remote} && {NODE_BIN} --version"
            ),
        )

    def _extra_exec_args(self) -> str:
        """Optional `coding-agent exec` flags from agent kwargs, shell-quoted, with a leading space."""
        args = ""
        if self._reasoning_effort:
            args += f" --reasoning-effort {shlex.quote(self._reasoning_effort)}"
        if self._reasoning_max_tokens is not None:
            args += f" --reasoning-max-tokens {self._reasoning_max_tokens}"
        if self._max_turns is not None:
            args += f" --max-turns {self._max_turns}"
        return args

    def _harness_timeout_sec(self) -> int:
        """Explicit kwarg, else the task's agent timeout (with job multipliers) from the trial config."""
        agent_timeout = self._explicit_timeout_sec or self._task_agent_timeout_sec() or DEFAULT_TIMEOUT_SEC
        return max(MIN_TIMEOUT_SEC, int(agent_timeout) - TIMEOUT_MARGIN_SEC)

    def _task_agent_timeout_sec(self) -> float | None:
        try:
            trial_config = json.loads((self.logs_dir.parent / "config.json").read_text())
            task_path = Path(trial_config["task"]["path"])
            task_toml = tomllib.loads((task_path / "task.toml").read_text())
            base = trial_config["agent"].get("override_timeout_sec") or task_toml["agent"]["timeout_sec"]
            multiplier = trial_config.get("agent_timeout_multiplier") or trial_config.get("timeout_multiplier") or 1.0
            limit = trial_config["agent"].get("max_timeout_sec")
            timeout = float(base) * float(multiplier)
            return min(timeout, float(limit)) if limit else timeout
        except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError):
            return None

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        logs = str(self.environment_logs_dir)
        instruction_file = f"{INSTALL_ROOT}/instruction.md"
        env = {k: os.environ[k] for k in FORWARDED_ENV_KEYS if os.environ.get(k)}
        env["CA_LOG_DIR"] = logs
        if self.model_name:  # harbor -m "openrouter/<model id>"
            env["CODING_AGENT_MODEL"] = self.model_name

        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=instruction_file,
            filename="instruction.md",
        )
        timeout_sec = self._harness_timeout_sec()
        extra_args = self._extra_exec_args()
        await self.exec_as_agent(
            environment,
            command=(
                f"{NODE_BIN} {AGENT_DIR}/runner.mjs {shlex.quote(instruction_file)} {timeout_sec}{extra_args} "
                f"> /dev/null 2>&1"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result_file = self.logs_dir / "result.json"
        if not result_file.exists():
            return
        result = json.loads(result_file.read_text())
        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("promptTokens")
        context.n_output_tokens = usage.get("completionTokens")
        context.n_cache_tokens = usage.get("cachedTokens")
        context.cost_usd = usage.get("costUsd")
        context.metadata = {
            "status": result.get("status"),
            "error_category": result.get("errorCategory"),
            "turns": result.get("turns"),
            "tool_calls": result.get("toolCalls"),
            "duration_ms": result.get("durationMs"),
        }
