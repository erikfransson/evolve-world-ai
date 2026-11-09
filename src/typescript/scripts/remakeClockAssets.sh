#!/bin/sh
# Remakes everything that depends on the content of src/sim/maps/clock.ts: the prebuilt map file, the test pins
# (tests/typescript/clockPins.json) and the ground pictures with their hashes (src/live/maps/clock-*). Needs Chrome.
# Run from anywhere: src/typescript/scripts/remakeClockAssets.sh
set -e
cd "$(dirname "$0")/.."
N="nice -n 19 ionice -c3 chrt --idle 0"
$N node scripts/buildMapAsset.ts
MAP=clock $N node scripts/buildMapImage.ts
