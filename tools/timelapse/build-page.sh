#!/bin/bash
# Builds the Live page of this checkout into tools/timelapse/page (or $1) and stamps the commit and protocol version it was built for.
# Build from the same commit the server runs (a promote to main: check out that commit, then run this). Wrap in flock/nice as the project rules say.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=$(realpath -m "${1:-$HERE/page}")
cd "$REPO/src/typescript"
npx vite build --outDir "$OUT" --emptyOutDir
PROTOCOL=$(grep -oP 'PROTOCOL_VERSION\s*=\s*\K[0-9]+' src/live/protocol.ts | head -1)
printf '{"commit":"%s","protocol":%s,"builtAt":"%s"}\n' "$(git rev-parse --short HEAD)" "$PROTOCOL" "$(date -u +%FT%TZ)" > "$OUT/timelapse-build.json"
cat "$OUT/timelapse-build.json"
