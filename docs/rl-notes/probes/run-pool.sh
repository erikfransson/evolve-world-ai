#!/bin/bash
# Winner's-curse check of the agg lab founder pools (read-only inputs). Logs to probes/logs/pool-*.log.
cd "$(dirname "$0")/../../../src/typescript"
L=../../docs/rl-notes/probes/logs
D="${AGG_RUNS:?set AGG_RUNS to the lab runs/agg directory}"
P="flock ${HEAVY_LOCK:-/tmp/heavy.lock} nice -n 19 ionice -c3 chrt --idle 0 node ../../docs/rl-notes/probes/pool-curse.ts --dir $D --threads 2"
$P --name lg8 > $L/pool-lg8.log 2>&1
$P --name lg8v2 --library lib-lean.json --held inland-02,inland-10,inland-11,inland-14,inland-16,inland-17,inland-18,inland-20 > $L/pool-lg8v2.log 2>&1
$P --name la6 --envfile lean-aggr.json --held inland-00,inland-11,inland-12,agg-03,agg-14,agg-15,duel-cross,duel-mixed > $L/pool-la6.log 2>&1
