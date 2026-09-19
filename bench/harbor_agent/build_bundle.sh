#!/usr/bin/env bash
# Builds a self-contained linux bundle of CodingAgent (node binary + dist +
# production node_modules) so each Harbor trial installs with a single upload
# and no network access to nodejs.org or the npm registry.
#
# Output: bench/build/coding-agent-linux-<arch>.tar.gz
# Usage:  bench/harbor_agent/build_bundle.sh [amd64|arm64]   (default: amd64)
set -euo pipefail

ARCH="${1:-amd64}"
NODE_IMAGE="node:22-bookworm-slim" # Debian bookworm glibc, same as TB's python:3.13-slim-bookworm images
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$REPO/bench/build"
STAGE="$OUT_DIR/stage-$ARCH"

cd "$REPO"
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE/coding-agent" "$STAGE/node/bin"
cp -R dist bin package.json package-lock.json "$STAGE/coding-agent/"
cp bench/harbor_agent/runner.mjs bench/harbor_agent/http-trace.mjs "$STAGE/coding-agent/"

# Production deps compiled for the target platform (better-sqlite3 is native),
# plus the node binary itself copied out of the same image.
docker run --rm --platform "linux/$ARCH" \
  -v "$STAGE:/stage" -w /stage/coding-agent "$NODE_IMAGE" \
  sh -c 'npm ci --omit=dev --no-audit --no-fund >/dev/null && cp "$(command -v node)" /stage/node/bin/node'

COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf "$OUT_DIR/coding-agent-linux-$ARCH.tar.gz" coding-agent node
rm -rf "$STAGE"
ls -lh "$OUT_DIR/coding-agent-linux-$ARCH.tar.gz"
