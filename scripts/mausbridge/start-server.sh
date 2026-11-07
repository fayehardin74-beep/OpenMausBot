#!/bin/sh
# mausbridge: start the OpenMausBot server (127.0.0.1:8799) with the desktop apps' CLIs on PATH.
cd "$(dirname "$0")/../.." || exit 1
. scripts/mausbridge/env.sh
exec pnpm dev:server
