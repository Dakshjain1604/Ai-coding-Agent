"""Tests for the adapter's harness time budget.

Run with Harbor's Python (the adapter imports harbor):
    ~/.local/share/uv/tools/harbor/bin/python -m unittest bench/harbor_agent/test_coding_agent.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harbor_agent.coding_agent import (  # noqa: E402
    DEFAULT_TIMEOUT_SEC,
    MIN_TIMEOUT_SEC,
    TIMEOUT_MARGIN_SEC,
    CodingAgent,
)


def make_trial(tmp: Path, task_timeout: float | None, **trial_overrides) -> CodingAgent:
    task_dir = tmp / "tasks" / "demo"
    task_dir.mkdir(parents=True)
    agent_section = f"[agent]\ntimeout_sec = {task_timeout}\n" if task_timeout is not None else ""
    (task_dir / "task.toml").write_text(f'version = "1.0"\n{agent_section}')
    trial_dir = tmp / "jobs" / "job" / "demo__abc"
    (trial_dir / "agent").mkdir(parents=True)
    config = {"task": {"path": str(task_dir)}, "agent": {}, "timeout_multiplier": 1.0}
    for key, value in trial_overrides.items():
        if key.startswith("agent_") and key != "agent_timeout_multiplier":
            config["agent"][key.removeprefix("agent_")] = value
        else:
            config[key] = value
    (trial_dir / "config.json").write_text(json.dumps(config))

    agent = CodingAgent.__new__(CodingAgent)  # the budget logic needs only these attributes
    agent.logs_dir = trial_dir / "agent"
    agent._explicit_timeout_sec = None
    return agent


class HarnessTimeoutTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_derives_from_task_timeout_minus_margin(self):
        agent = make_trial(self.tmp, 900.0)
        self.assertEqual(agent._harness_timeout_sec(), 900 - TIMEOUT_MARGIN_SEC)

    def test_applies_agent_timeout_multiplier_over_global_multiplier(self):
        agent = make_trial(self.tmp, 600.0, agent_timeout_multiplier=2.0, timeout_multiplier=3.0)
        self.assertEqual(agent._harness_timeout_sec(), 1200 - TIMEOUT_MARGIN_SEC)

    def test_applies_global_multiplier_when_no_agent_multiplier(self):
        agent = make_trial(self.tmp, 600.0, timeout_multiplier=1.5)
        self.assertEqual(agent._harness_timeout_sec(), 900 - TIMEOUT_MARGIN_SEC)

    def test_override_and_max_timeout(self):
        agent = make_trial(self.tmp, 600.0, agent_override_timeout_sec=3000, agent_max_timeout_sec=2000)
        self.assertEqual(agent._harness_timeout_sec(), 2000 - TIMEOUT_MARGIN_SEC)

    def test_explicit_kwarg_wins(self):
        agent = make_trial(self.tmp, 900.0)
        agent._explicit_timeout_sec = 300
        self.assertEqual(agent._harness_timeout_sec(), 300 - TIMEOUT_MARGIN_SEC)

    def test_falls_back_to_default_without_trial_config(self):
        agent = CodingAgent.__new__(CodingAgent)
        agent.logs_dir = self.tmp / "nowhere" / "agent"
        agent._explicit_timeout_sec = None
        self.assertEqual(agent._harness_timeout_sec(), DEFAULT_TIMEOUT_SEC - TIMEOUT_MARGIN_SEC)

    def test_falls_back_to_default_when_task_has_no_agent_timeout(self):
        agent = make_trial(self.tmp, None)
        self.assertEqual(agent._harness_timeout_sec(), DEFAULT_TIMEOUT_SEC - TIMEOUT_MARGIN_SEC)

    def test_never_below_minimum(self):
        agent = make_trial(self.tmp, 30.0)
        self.assertEqual(agent._harness_timeout_sec(), MIN_TIMEOUT_SEC)


class ExtraExecArgsTest(unittest.TestCase):
    def make(self, **kwargs) -> CodingAgent:
        agent = CodingAgent.__new__(CodingAgent)
        agent._reasoning_effort = kwargs.get("reasoning_effort")
        agent._max_turns = kwargs.get("max_turns")
        return agent

    def test_no_flags_by_default(self):
        self.assertEqual(self.make()._extra_exec_args(), "")

    def test_passes_reasoning_effort_and_max_turns(self):
        self.assertEqual(
            self.make(reasoning_effort="high", max_turns=24)._extra_exec_args(),
            " --reasoning-effort high --max-turns 24",
        )

    def test_quotes_reasoning_effort(self):
        self.assertEqual(self.make(reasoning_effort="high; rm -rf /")._extra_exec_args(), " --reasoning-effort 'high; rm -rf /'")


if __name__ == "__main__":
    unittest.main()
