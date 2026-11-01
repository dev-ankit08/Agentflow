#!/usr/bin/env bash
# Runs once when the codespace is created: install dependencies, write .env and build for production.
set -euo pipefail
cd "$(dirname "$0")/.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

corepack pnpm install --frozen-lockfile
node .devcontainer/write-env.mjs
corepack pnpm build
echo "Setup done. The app starts automatically; run 'bash .devcontainer/start.sh' to restart it."
