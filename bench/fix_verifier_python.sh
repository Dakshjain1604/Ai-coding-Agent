#!/usr/bin/env bash
# Local-only workaround for running python:3.13-slim task verifiers on an ARM
# Mac. Their test.sh runs `uvx -p 3.13 ... pytest`, which makes uv download a
# standalone x86 CPython that intermittently segfaults or times out under
# QEMU/Rosetta emulation (see bench/README.md, experiment 6). These images
# already ship a working system Python 3.13, so we tell uv to use it instead.
#
# This does NOT change what is graded: same Python version, same pytest, same
# tests — only where the interpreter comes from. It applies ONLY to
# python:3.13-slim tasks (ubuntu:24.04 tasks have system 3.12 and cannot use
# only-system for a -p 3.13 verifier). Edits the gitignored local task copies
# under bench/tasks, and is idempotent.
#
# Usage: bench/fix_verifier_python.sh
set -euo pipefail
TASKS_DIR="$(cd "$(dirname "$0")/tasks" && pwd)"
MARKER='UV_PYTHON_PREFERENCE = "only-system"'
patched=0 skipped=0

for toml in "$TASKS_DIR"/*/task.toml; do
  dockerfile="$(dirname "$toml")/environment/Dockerfile"
  grep -qi "^FROM python:3.13" "$dockerfile" 2>/dev/null || continue
  if grep -qE "^\[environment\.env\]" "$toml"; then
    skipped=$((skipped + 1))
    continue
  fi
  # Append an [environment.env] table. TOML allows a table after the
  # [environment] table's key/values; putting it at end-of-file is valid
  # because nothing else follows [environment] in these task files.
  printf '\n[environment.env]\n%s\n' "$MARKER" >> "$toml"
  patched=$((patched + 1))
done

echo "patched $patched python:3.13-slim task(s), $skipped already patched"
