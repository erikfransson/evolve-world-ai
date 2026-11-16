#!/bin/bash
# Builds the replay page (replay/) into tools/timelapse/replay-page: the Live page's drawing code fed by replay.mjs instead of a WebSocket.
# Build from the checkout whose map the state log was recorded with (replay.mjs refuses another map version). Wrap in flock/nice as the project rules say.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../../src/typescript"
npx vite build --config "$HERE/replay/vite.config.mjs"
printf '{"commit":"%s","builtAt":"%s"}\n' "$(git rev-parse --short HEAD)" "$(date -u +%FT%TZ)" > "$HERE/replay-page/replay-build.json"
cat "$HERE/replay-page/replay-build.json"
