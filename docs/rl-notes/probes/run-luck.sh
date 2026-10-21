#!/bin/bash
# Runs es-luck.ts over a list of "env from seed" cases, one at a time, under the shared heavy lock. Logs to probes/logs/.
cd "$(dirname "$0")/../../../src/typescript"
L=../../docs/rl-notes/probes/logs
while read -r env from seed extra; do
  [ -z "$env" ] && continue
  name="luck-$env-${from/:/}-s$seed${extra:+-x}"
  flock /home/erik/progs/evolve-world-ai/.claude/heavy.lock nice -n 19 ionice -c3 chrt --idle 0 node ../../docs/rl-notes/probes/es-luck.ts --env $env --from $from --seed $seed $extra > $L/$name.log 2>&1
done
