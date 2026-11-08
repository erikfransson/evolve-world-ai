#!/bin/bash
# B4 driver: [TIERS="light strong"] LOCK=path run-all.sh DIST OUT.jsonl [REPS]. One job per lock hold so other agents interleave; needs 3 GB available.
DIST=$1; OUT=$2; REPS=${3:-2}; HERE=$(cd "$(dirname "$0")" && pwd); LOCK=${LOCK:?set LOCK to the shared heavy.lock path}
for rep in $(seq 1 "$REPS"); do
 for tier in ${TIERS:-light medium strong}; do
  for job in "p3 fresh" "p6 fresh" "grazer es" "p3 es"; do
   set -- $job
   while [ "$(free -m | awk '/Mem:/{print $7}')" -lt 3072 ]; do sleep 30; done
   flock "$LOCK" nice -n 19 ionice -c3 chrt --idle 0 node "$HERE/run.mjs" "$DIST" "$tier" "$1" "$2" "$OUT"
  done
 done
done
