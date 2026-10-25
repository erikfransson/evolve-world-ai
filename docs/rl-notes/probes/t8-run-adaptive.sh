#!/bin/bash
# T8: fixed 10x5, fixed 50x1 and successive halving (20 pairs x 1 episode, best 10 pairs by |r+ - r-| get 3 more) from pool:0,
# 60 iterations (100 episodes each), seeds 1-4, scored on 128 fresh seeds. Usage (from src/typescript): bash t8-run-adaptive.sh ENV OUTDIR
# One lock hold per env; finished runs are skipped.
env=$1; out=$2; P=../../docs/rl-notes/probes
mkdir -p "$out"
for seed in 1 2 3 4; do
  for s in "fixed --pairs 10 --episodes 5" "fixed --pairs 50 --episodes 1" "sh --pairs1 20 --eps1 1 --keep 10 --eps2 3"; do
    set -- $s; tag=$1-$3$5
    [ -s "$out/$env-s$seed-$tag.json" ] && continue
    node $P/t8-adaptive.ts --env "$env" --seed $seed --scheme $s --threads 2 --out "$out/$env-s$seed-$tag.json" >> "$out/log.txt" 2>&1
  done
done
