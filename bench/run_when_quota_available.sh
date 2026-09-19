#!/usr/bin/env bash
# Waits until the OpenRouter key has enough free-model requests left for today,
# then runs a Harbor job. Polling the key endpoint does not consume model requests.
# The Docker VM (Colima) is stopped while waiting and started only when the job
# is about to run: on an 8 GB host an idle 5 GB VM starves everything else for
# hours (the first watcher was killed by the OS for low memory).
#
# Usage: bench/run_when_quota_available.sh <min-free-requests> <job-name> <harbor run args...>
# Example:
#   bench/run_when_quota_available.sh 48 exp2 -i fix-git -i openssl-selfsigned-cert \
#     -m openrouter/nvidia/nemotron-3-ultra-550b-a55b:free --ak max_turns=24
set -euo pipefail

MIN_REQUESTS="$1"; JOB_NAME="$2"; shift 2
POLL_SEC=300
MAX_WAIT_SEC=$((16 * 3600))
BENCH="$(cd "$(dirname "$0")" && pwd)"

set -a; . "$BENCH/../.env"; set +a

remaining_free_requests() {
  curl -s --max-time 20 -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["free_model_daily_requests"]["remaining"])' 2>/dev/null ||
    echo -1
}

COLIMA_START_ARGS=(--cpu 4 --memory 5 --disk 80 --vm-type vz --vz-rosetta)
if colima status >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) stopping Colima while waiting for quota"
  colima stop
fi

waited=0
while :; do
  remaining="$(remaining_free_requests)"
  echo "$(date -u +%FT%TZ) free-model requests remaining: $remaining (need $MIN_REQUESTS)"
  if [ "$remaining" -ge "$MIN_REQUESTS" ]; then break; fi
  if [ "$waited" -ge "$MAX_WAIT_SEC" ]; then echo "gave up waiting after ${MAX_WAIT_SEC}s"; exit 1; fi
  sleep "$POLL_SEC"; waited=$((waited + POLL_SEC))
done

echo "$(date -u +%FT%TZ) starting Colima"
colima start "${COLIMA_START_ARGS[@]}"
docker info >/dev/null

cd "$BENCH"
PYTHONPATH=. harbor run -p tasks -a harbor_agent.coding_agent:CodingAgent \
  -o jobs --job-name "$JOB_NAME" -n 1 -y -q --env-file ../.env "$@"
python3 analyze.py "jobs/$JOB_NAME"
