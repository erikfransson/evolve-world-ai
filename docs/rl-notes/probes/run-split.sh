#!/bin/bash
# Budget split at 100 episodes per iteration: pairs x episodes = 50x1, 25x2, 10x5. rlTrain, 60 iterations, held-out 32 seeds.
# Reads "env from seed" lines on stdin. Logs to probes/logs/split-*.log.
cd "$(dirname "$0")/../../../src/typescript"
L=../../docs/rl-notes/probes/logs
while read -r env from seed; do
  [ -z "$env" ] && continue
  for pe in "50 1" "25 2" "10 5"; do
    set -- $pe
    flock /home/erik/progs/evolve-world-ai/.claude/heavy.lock nice -n 19 ionice -c3 chrt --idle 0 node src/rlTrain.ts --env $env --from $from --seed $seed --iters 60 --pairs $1 --episodes $2 --eval 32 --every 20 --threads 2 > $L/split-$env-${from/:/}-s$seed-p$1e$2.log 2>&1
  done
done
