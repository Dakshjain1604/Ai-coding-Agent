#!/usr/bin/env python3
"""Summarize Harbor job runs of CodingAgent: outcome, timing breakdown,
model latency and retries, tool behavior, and verifier results per trial.

Reads the harness's own trajectory.jsonl when present (runs of
`coding-agent exec`); falls back to the HTTP trace for older runs of the
legacy agent (which had no trajectory).

Usage: python3 bench/analyze.py bench/jobs/<job> [bench/jobs/<job> ...] [--json]
"""

import json
import re
import statistics
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

LLM_HOSTS = ("api.groq.com", "openrouter.ai", "api.openai.com")


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def span(part):
    part = part or {}
    a, b = ts(part.get("started_at")), ts(part.get("finished_at"))
    return round((b - a).total_seconds(), 1) if a and b else None


def pct(values, p):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def read_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def trajectory_stats(events):
    responses = [e for e in events if e["type"] == "model_response"]
    tools = [e for e in events if e["type"] == "tool_result"]
    end = next((e for e in events if e["type"] == "run_end"), {})
    latencies = [e["latency_ms"] / 1000 for e in responses]
    bash = [e for e in tools if e["name"] == "bash"]
    retry_wait = sum(e["wait_ms"] for e in events if e["type"] == "model_retry") / 1000
    return {
        "source": "trajectory",
        "status": end.get("status", "incomplete (no run_end — killed?)"),
        "error_category": end.get("error_category"),
        "turns": end.get("turns", len(responses)),
        "models": sorted({e.get("served_by") for e in responses}),
        "model_time_s": round(sum(latencies), 1),
        "latency_p50_s": round(statistics.median(latencies), 2) if latencies else None,
        "latency_p95_s": round(pct(latencies, 95), 2) if latencies else None,
        "first_chunk_p50_s": round(statistics.median([e["first_chunk_ms"] / 1000 for e in responses]), 2) if responses else None,
        "retry_wait_s": round(retry_wait, 1),
        "retries": dict(Counter(e["category"] for e in events if e["type"] == "model_retry")),
        "model_errors": dict(Counter(e["category"] for e in events if e["type"] == "model_error")),
        "notices": dict(Counter(e["message"] for e in events if e["type"] == "notice")),
        "compactions": [e.get("outcome") for e in events if e["type"] == "compaction"],
        "prompt_tokens": sum(e.get("prompt_tokens") or 0 for e in responses),
        "completion_tokens": sum(e.get("completion_tokens") or 0 for e in responses),
        "max_prompt_tokens": max((e.get("prompt_tokens") or 0 for e in responses), default=0),
        "cost_usd": round(sum(e.get("cost_usd") or 0 for e in responses), 4),
        "finish_reasons": dict(Counter(e["finish_reason"] for e in responses)),
        "tool_calls": len(tools),
        "tool_time_s": round(sum(e["duration_ms"] for e in tools) / 1000, 1),
        "tool_histogram": dict(Counter(e["name"] for e in tools)),
        "tool_failures": sum(1 for e in tools if not e["ok"]),
        "bash_nonzero_exit": sum(1 for e in bash if (e.get("meta") or {}).get("exitCode") not in (0, None)),
        "bash_timeouts": sum(1 for e in bash if (e.get("meta") or {}).get("timedOut")),
        "truncated_outputs": sum(1 for e in tools if e.get("omitted_chars")),
        "final_message": (end.get("final_message") or "")[:300],
    }


def http_trace_stats(calls):
    calls = [c for c in calls if c.get("host") in LLM_HOSTS and (c.get("request") or {}).get("model")]
    ok = [c for c in calls if c.get("status") == 200 and c.get("outcome") == "complete" and not (c.get("response") or {}).get("error")]
    latencies = [c["total_ms"] / 1000 for c in ok]
    return {
        "source": "http_trace",
        "models": sorted({(c.get("request") or {}).get("model") for c in calls}),
        "http_requests": len(calls),
        "http_ok": len(ok),
        "http_429": sum(1 for c in calls if c.get("status") == 429),
        "model_time_s": round(sum(latencies), 1),
        "latency_p50_s": round(statistics.median(latencies), 2) if latencies else None,
        "latency_p95_s": round(pct(latencies, 95), 2) if latencies else None,
    }


def analyze_trial(trial_dir: Path) -> dict:
    result = json.loads((trial_dir / "result.json").read_text())
    agent_dir = trial_dir / "agent"
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    row = {
        "task": result["task_name"],
        "reward": rewards.get("reward"),
        "exception": (result.get("exception_info") or {}).get("exception_type"),
        "total_s": span(result),
        "env_setup_s": span(result.get("environment_setup")),
        "agent_setup_s": span(result.get("agent_setup")),
        "agent_s": span(result.get("agent_execution")),
        "verifier_s": span(result.get("verifier")),
    }
    run_file = agent_dir / "run.json"
    if run_file.exists():
        run = json.loads(run_file.read_text())
        row["runner"] = {k: run.get(k) for k in ("status", "exit_code", "signal", "timeout_sec")}

    events = read_jsonl(agent_dir / "trajectory.jsonl")
    row["agent"] = trajectory_stats(events) if events else http_trace_stats(read_jsonl(agent_dir / "http.jsonl"))
    http = http_trace_stats(read_jsonl(agent_dir / "http.jsonl"))
    row["http_cross_check"] = {k: http[k] for k in ("http_requests", "http_ok", "http_429")}

    stdout = trial_dir / "verifier" / "test-stdout.txt"
    if stdout.exists():
        v = stdout.read_text(errors="replace")
        row["tests_passed"] = len(re.findall(r"^PASSED ", v, re.M))
        row["tests_failed"] = len(re.findall(r"^FAILED ", v, re.M))
        row["failed_tests"] = re.findall(r"^FAILED \S+::(\S+)", v, re.M)
        # A reward of 0 with NO tests parsed usually means the verifier itself
        # never ran (e.g. it failed to download its own Python toolchain). That
        # is an infrastructure false-negative, not an agent failure, and must
        # not be counted against the agent.
        row["verifier_infra_error"] = classify_verifier_error(v, row)
    return row


# Signatures of the verifier failing to set itself up, not of the agent's work.
VERIFIER_INFRA_SIGNATURES = (
    ("python-build-standalone", "uv could not download its Python toolchain (slow/blocked network)"),
    ("Failed to download", "a verifier dependency download failed"),
    ("Could not find a version that satisfies", "a verifier pip dependency was unavailable"),
    ("Temporary failure in name resolution", "verifier DNS/network failure"),
    # The standalone CPython downloads fine but crashes when run under QEMU x86
    # emulation on an ARM host — the verifier never gets a working interpreter.
    ("failed with exit status signal: 11 (SIGSEGV)", "verifier's downloaded Python segfaulted under QEMU emulation"),
    ("unknown platform bitness", "uv installer misread the platform under QEMU emulation"),
    ("Illegal instruction", "verifier toolchain hit an illegal instruction under QEMU emulation"),
)


def classify_verifier_error(stdout_text: str, row: dict) -> str | None:
    if row.get("tests_passed") or row.get("tests_failed"):
        return None  # the verifier ran; any reward=0 is a real result
    for signature, reason in VERIFIER_INFRA_SIGNATURES:
        if signature in stdout_text:
            return reason
    return None


def print_row(r):
    a = r["agent"]
    print(f"\n=== {r['task']}  reward={r['reward']}  exception={r['exception']}  runner={r.get('runner')}")
    print(f"  time: total={r['total_s']}s env={r['env_setup_s']}s setup={r['agent_setup_s']}s agent={r['agent_s']}s verifier={r['verifier_s']}s")
    if a["source"] == "trajectory":
        print(f"  run: status={a['status']} error={a['error_category']} turns={a['turns']} models={a['models']}")
        print(f"  model: time={a['model_time_s']}s p50/p95={a['latency_p50_s']}/{a['latency_p95_s']}s first_chunk_p50={a['first_chunk_p50_s']}s "
              f"retry_wait={a['retry_wait_s']}s retries={a['retries']} errors={a['model_errors']}")
        print(f"  tokens: prompt={a['prompt_tokens']} completion={a['completion_tokens']} max_prompt={a['max_prompt_tokens']} "
              f"cost=${a['cost_usd']} finish={a['finish_reasons']}")
        print(f"  tools: {a['tool_calls']} calls in {a['tool_time_s']}s {a['tool_histogram']} failures={a['tool_failures']} "
              f"bash_nonzero={a['bash_nonzero_exit']} bash_timeouts={a['bash_timeouts']} truncated={a['truncated_outputs']}")
        if a["notices"] or a["compactions"]:
            print(f"  notices={a['notices']} compactions={a['compactions']}")
        print(f"  final: {a['final_message']!r}")
    else:
        print(f"  (legacy run, http trace only) {a}")
    print(f"  http cross-check: {r['http_cross_check']}")
    if r.get("verifier_infra_error"):
        print(f"  VERIFIER DID NOT RUN (infra, not the agent): {r['verifier_infra_error']}")
    elif "tests_passed" in r:
        print(f"  tests: passed={r['tests_passed']} failed={r['tests_failed']} {r['failed_tests']}")


def main():
    jobs = [a for a in sys.argv[1:] if not a.startswith("--")]
    rows = [
        analyze_trial(trial)
        for job in jobs
        for trial in sorted(Path(job).iterdir())
        if trial.is_dir() and (trial / "result.json").exists() and (trial / "config.json").exists()
    ]
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2))
        return
    for r in rows:
        print_row(r)
    if len(rows) > 1:
        solved = sum(1 for r in rows if r["reward"] == 1)
        infra = [r["task"] for r in rows if r.get("verifier_infra_error")]
        scored = len(rows) - len(infra)
        print(f"\n=== SCORED: {solved}/{scored} solved (of {len(rows)} run; {len(infra)} excluded — verifier did not run) | "
              f"agent time {sum(r['agent_s'] or 0 for r in rows):.0f}s | "
              f"model time {sum(r['agent'].get('model_time_s') or 0 for r in rows):.0f}s")
        if infra:
            print(f"    verifier-infra failures (re-run these): {', '.join(infra)}")


if __name__ == "__main__":
    main()
