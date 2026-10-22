#!/bin/bash
# T7: runs "cfg seed" jobs from a list file in 2 single-thread lanes, under the heavy lock. Run from src/typescript:
# flock "$HEAVY_LOCK" nice -n 19 ionice -c3 chrt --idle 0 bash ../../docs/rl-notes/probes/t7-batch.sh JOBS.txt CFG_DIR OUT_DIR
# A job line is "cfg seed [name [args...]]"; PROBE picks the probe (default t7-run.ts). Skips jobs whose output exists; stops starting jobs when free memory is under 3 GB.
jobs=$1; cfgdir=$2; out=$3
mkdir -p "$out"
lane() {
  while read -r cfg seed name args; do
    o="$out/${name:-$cfg}-s$seed.json"; [ -e "$o" ] && continue
    while [ "$(free -g | awk '/Mem:/{print $7}')" -lt 3 ]; do sleep 30; done
    node "../../docs/rl-notes/probes/${PROBE:-t7-run.ts}" --cfg "$cfgdir/$cfg.json" --seed "$seed" $args --out "$o.tmp" >> "$out/log.txt" 2>&1 && mv "$o.tmp" "$o"
  done
}
awk 'NR%2==1' "$jobs" | lane &
awk 'NR%2==0' "$jobs" | lane &
wait
