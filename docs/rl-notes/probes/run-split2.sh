#!/bin/bash
# Budget split at 100 episodes per iteration (50x1, 10x5, 5x10), founders pool:0 on far-food, minefield, corridor, 4 seeds.
# rlTrain 60 iterations, held-out 64 seeds; the final genome goes to logs/split2-*.json for fresh-seed scoring (score-final.ts).
cd "$(dirname "$0")/../../../src/typescript"
L=../../docs/rl-notes/probes/logs
# One lock hold per seed (9 runs, a few minutes), since the shared lock queues each acquisition for minutes; finished runs are skipped.
for seed in 1 2 3 4; do
  SEED=$seed flock "${HEAVY_LOCK:-/tmp/heavy.lock}" nice -n 19 ionice -c3 chrt --idle 0 bash -c '
    L=../../docs/rl-notes/probes/logs
    for env in far-food minefield corridor; do for pe in "50 1" "10 5" "5 10"; do
      set -- $pe
      n=split2-$env-s$SEED-p$1e$2
      [ -s $L/$n.json ] && continue
      node src/rlTrain.ts --env $env --from pool:0 --seed $SEED --iters 60 --pairs $1 --episodes $2 --eval 64 --every 30 --threads 2 --out $L/$n.json > $L/$n.log 2>&1
    done; done'
done
