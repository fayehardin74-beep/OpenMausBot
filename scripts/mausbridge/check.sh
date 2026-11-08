#!/bin/sh
# mausbridge: everything to run after merging an upstream release (docs/mausbridge/README.md).
set -e
cd "$(dirname "$0")/../.."
. scripts/mausbridge/env.sh
echo "== the four mausbridge hooks are still in place"
test "$(grep -c 'mausbridge hook [1-4]/4' server/index.ts server/drivers/acp/core.ts | awk -F: '{s+=$2} END {print s}')" -eq 4
echo "== typecheck"
pnpm exec tsc -p tsconfig.server.json
echo "== unit tests (mausbridge + the ACP driver it hooks)"
pnpm exec vitest run server/mausbridge server/drivers/acp
echo "== smoke: bind -> send -> wait on a disposable fixture"
node --experimental-strip-types scripts/mausbridge/smoke.ts
