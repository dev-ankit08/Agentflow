#!/usr/bin/env bash
# Starts (or restarts) AgentFlow in a codespace: database, demo model and orders server, API, worker and builder,
# then makes the app's ports public and prints the link and trial access code to share.
# Logs: .data/logs/<service>.log. Runs on every codespace start; safe to run again by hand.
set -uo pipefail
cd "$(dirname "$0")/.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p .data/logs .data/pids

node .devcontainer/write-env.mjs

# Each service runs in its own process group so a restart stops pnpm and the node process under it.
run() {
  local name=$1
  shift
  local pidfile=".data/pids/$name"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill -- "-$(cat "$pidfile")" 2>/dev/null
    sleep 1
  fi
  setsid nohup "$@" >".data/logs/$name.log" 2>&1 &
  echo $! >"$pidfile"
}

wait_port() {
  for _ in $(seq 1 120); do
    (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    sleep 1
  done
  echo "Port $1 did not open in time; check .data/logs." >&2
  return 1
}

if [ ! -d apps/builder/.next ]; then
  echo "No production build yet; building (a few minutes)…"
  corepack pnpm build || exit 1
fi

run db corepack pnpm db:start
wait_port 5433 || exit 1
corepack pnpm db:migrate || exit 1
if [ ! -f .data/.seeded ]; then
  corepack pnpm db:seed && touch .data/.seeded
fi

run mock-llm corepack pnpm --filter @agentflow/llm-gateway demo
run demo-mcp corepack pnpm --filter @agentflow/mcp-client demo
run api corepack pnpm --filter @agentflow/api start
run worker corepack pnpm --filter @agentflow/worker start
run builder corepack pnpm --filter @agentflow/builder start
wait_port 4000 && wait_port 3100 || exit 1

link=$(grep '^AUTH_URL=' .env | cut -d= -f2-)
code=$(grep '^TRIAL_ACCESS_CODE=' .env | cut -d= -f2-)

public="no"
if [ -n "${CODESPACE_NAME:-}" ] && command -v gh >/dev/null; then
  gh codespace ports visibility 3100:public 4000:public -c "$CODESPACE_NAME" >/dev/null 2>&1 && public="yes"
fi

echo
echo "AgentFlow is running."
echo "  Link to share:      $link"
echo "  Trial access code:  $code"
if [ "$public" = "yes" ]; then
  echo "  Ports 3100 and 4000 are public."
else
  echo "  Make the link public: Ports tab → right-click ports 3100 and 4000 → Port Visibility → Public."
fi
echo "  Testers sign in with their own email and the code. Logs: .data/logs/"
