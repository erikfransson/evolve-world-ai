#!/bin/bash
# T6 runner: each line of the job file is "name t6-train-args..."; finished jobs (name.json) are skipped.
# Holds the heavy lock for jobs until about HOLD seconds (default 240) have passed, then lets the other sessions in.
# Usage: docs/rl-notes/probes/t6-run.sh jobs.txt   (output in $T6_OUT, default src/typescript/runs/t6, which git ignores)
JOBS=$(realpath "$1")
cd "$(dirname "$0")/../../../src/typescript"
export OUT=${T6_OUT:-runs/t6} JOBS HOLD=${HOLD:-240}
mkdir -p "$OUT"
pending() { while read -r name args; do [ -z "$name" ] || [ "${name:0:1}" = "#" ] || [ -s "$OUT/$name.json" ] || echo "$name"; done < "$JOBS"; }
while [ -n "$(pending)" ]; do
  flock "${HEAVY_LOCK:-/tmp/heavy.lock}" nice -n 19 ionice -c3 chrt --idle 0 bash -c '
    t0=$SECONDS
    while read -r name args; do
      [ -z "$name" ] || [ "${name:0:1}" = "#" ] || [ -s "$OUT/$name.json" ] && continue
      [ $((SECONDS - t0)) -ge $HOLD ] && break
      node ../../docs/rl-notes/probes/t6-train.ts $args --out "$OUT/$name.json" > "$OUT/$name.log" 2>&1 || { echo "$name failed"; exit 1; }
      echo "$name $(tail -n 1 "$OUT/$name.log")"
    done < "$JOBS"' || break
done
