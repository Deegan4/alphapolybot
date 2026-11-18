#!/usr/bin/env bash
# Preflight for the dry-run checklist (docs/DRY_RUN_CHECKLIST.md, steps 0-2).
#
#   npm run preflight             install, smoke-test the API, start the app
#   npm run preflight -- --no-dev same, but do not start the app
#
# Read-only: the smoke test never places an order. The authenticated checks run
# only when POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY are in the repo-root .env.
set -euo pipefail
cd "$(dirname "$0")/.."

START_DEV=1
for arg in "$@"; do
  [ "$arg" = "--no-dev" ] && START_DEV=0
done

step() { printf '\n== %s ==\n' "$1"; }

step "Installing dependencies"
[ -d node_modules ] || npm install
[ -d mcp-server/node_modules ] || (cd mcp-server && npm install)

# Behind an HTTPS proxy Node needs this to use it
if [ -n "${HTTPS_PROXY:-}" ] && [ -z "${NODE_USE_ENV_PROXY:-}" ]; then
  export NODE_USE_ENV_PROXY=1
fi

has_key() {
  [ -f .env ] && grep -Eq '^(POLYMARKET_KEY_ID|PM_US_KEY_ID)=.+' .env && grep -Eq '^(POLYMARKET_SECRET_KEY|PM_US_SECRET_KEY)=.+' .env
}

SMOKE_OK=1
if has_key; then
  step "Smoke test: public + account checks (read-only)"
  (cd mcp-server && npm run --silent smoke -- --auth) || SMOKE_OK=0
else
  step "Smoke test: public checks only"
  echo "No API key in .env, so balance, positions and order preview are skipped."
  echo "To include them, add POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY to .env and rerun."
  (cd mcp-server && npm run --silent smoke) || SMOKE_OK=0
fi

if [ "$SMOKE_OK" -ne 1 ]; then
  step "Smoke test failed"
  echo "Fix this before going further. A 429 or an HTML response means the gateway"
  echo "rate-limited this IP: wait 5-10 minutes and rerun. Anything else: see"
  echo "docs/DRY_RUN_CHECKLIST.md section 1 and report the failing check."
  exit 1
fi

step "Next: docs/DRY_RUN_CHECKLIST.md section 2"
echo "1. In the app, open Settings -> Trading and confirm Dry Run is ON."
echo "2. Connect your key in Settings -> Wallet."
echo "3. Work through the section 2 boxes (balance, feeds, signals)."

if [ "$START_DEV" -eq 1 ]; then
  step "Starting the app (Ctrl+C to stop)"
  exec npm run dev
fi
