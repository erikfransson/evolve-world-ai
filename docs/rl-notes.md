# RL training notes (C1)

How to train creatures in RL envs so they get better systematically.
Append-only: mark items done, do not rewrite. Track files in `docs/rl-notes/` are merged here.

## Results

| id  | question | finding | evidence |
|-----|----------|---------|----------|
| C1a | backprop learns little? | No. From a fresh design it learns fast (nibble 0.13 to 3.04 in 45 s). From founders it starts near the ceiling (+0.05 to +0.14 in 60 s, any mode). The low training curve came from the 3-tick action hold (training score 1 to 1.5 below held-out); everyTick keeps them within 0.2. | t1-backprop.md, 128 held-out seeds |
| C1a | KL stop | targetKl 0.02 stops the minefield damage (-0.47 to -0.09), no gain | t1-backprop.md |
| C1b | good env | Criteria E1 to E8 (SNR at least 1.5, trivial policy at most 30% of best, per-bite time pressure, ...). Fail: aggressor, poison-field, endurance (standing still wins), forage-sparse, toll-road, glimpse, truffles | t3-envs.md, probes/t3-snr.ts |
| C1b | held-out size | Compare paired on the same seeds; 64 seeds track 128 fresh ones (r 0.96); 12 or 4 per env are too few for claims | t2-es.md, t3-envs.md |
| C1c | ES best line | Luck: best candidate equals the mean on fresh seeds (1.88 vs 1.91); one episode separates candidates by 0 to 20% of its variance | t2-es.md |
| C1c | ES split from founders | 10 pairs x 5 episodes beats 50 x 1 (far-food 0.87 vs 0.61 in 4 of 4 seeds, corridor 1.45 vs 1.26); minefield stuck at 0.5 | t2-es.md, 128 fresh seeds |
| C1c | RL score predicts Live? | No (dying lean 4.63, survivors 3.74). Lab pools rank noise (rank vs fresh score r -0.33 to 0.16) | t4-recipe.md, t2-es.md |
| C1c | speed | Arena envs teach speed 60 to 72 (rl-54-56 bfe0375); slow lean founders came from the lean lab recipe. lg4 (fast, v 73 in Live) wins Live at bonus 10 (1283, 1286 at +60) while slow lg8v2 died. Speed decides survival, so the lean recipe must keep it | l10-lg4-*.log in agg runs/agg |
| C2  | learning beyond luck | Yes on nibble, far-food and fading from fresh designs, ES and PPO: every gain and slope 95% CI above 0, 3 of 3 runs (e.g. fading PPO 0.13 to 4.52, +4.39 [3.31, 5.37]; far-food weakest, one PPO run +0.19). Run-to-run spread is large; PPO last iterate can drop | t5-proof.md, src/rlProof.ts, 64 paired seeds |
| C3  | ceiling, env side | A rotated mix of six envs beats far-food alone on 8 unseen envs: +0.20 +-0.10 (Explorer = 1), 7 of 8 seeds, at -0.53 raw on far-food itself. No gain: Nibble-then-far-food curriculum (6 losses, 1 tie over 7 seeds), early reward on the mix, net-income reward (stand-still farms it), brain size or memory (within +-0.06), PBT. 900 vs 300 iterations: +0.11 trained, +0.04 unseen | t7-ceiling-env.md, 64 paired seeds |
| C3  | ceiling, learner side | Stalls are not the learner. Fresh body 1 on fading is capped by sight (56 vs 212 units): same brain with long rays +3.09 [1.90, 4.29], 3x budget +0.06. Far-food founder ceiling was budget: 3x ES 1.44 to 2.78, +1.34 [0.34, 2.34], still rising. No gain: sigma annealing, population 200, 10x5 on fresh bodies, ES then PPO (-1.29 fading), PPO then ES. PPO alone wins at 60 s but stalls or collapses by 180 s | t6-ceiling-learner.md, 64 paired seeds |
| C4  | efficiency | Small envs 3 to 5.5 ms per episode (E8 met), Live-like 14 to 26 ms (rivals take 9 in 10 sense and brain calls). Settle and birth scans in JS for worlds of at most 32 members: rlBench -12% (fading -28%), fingerprints unchanged, big worlds not slower. Successive halving lost to fixed 10x5 in 7 of 8 seeds (far-food 0.0247 vs 0.0116 held-out gain per CPU s) | t8-efficiency.md, 7158909 |

## Questions

- C1a: Why does backprop seem to learn little?
- C1b: What makes an env well suited for training?
- C1c: A systematic recipe (ES vs backprop vs hybrid, curricula, held-out measure, feed to founders).

Tracks: T1 backprop diagnosis, T2 ES learner quality, T3 env trainability, T4 recipe and transfer.

## Log

- 2026-10-21. Started from development 7df22c7. Prior work: docs/rl-grad-notes.md (PPO beats ES on nibble, corridor, minefield from random at equal wall time), docs/rl-algo-notes.md, docs/rl-envs.md. bp-investigate: no bug, gradient check passes; from a founder PPO starts near the ceiling and training scores look lower due to exploration noise.
- 2026-10-21. rl-54-56 speed check (bfe0375) narrows T4's speed claim. Creatures trained on Fading, Race or Nibble move at 60 to 72 in their own env, in Nibble and in Far food (untrained 0 to 7), as fast as Live survivors (63 to 77). So Arena envs in general do not teach slow play. T4's slow lean founders (lg8, lg8v2, la6 at 17 to 43 in envs) come from the lean lab recipe (lean-grazer and lean-aggr env sets, rivals, from random), not from envs in general. lg4 (63 to 65 in envs) is the test of whether speed alone decides Live (l10lg4, queued).
- 2026-10-22. All four tracks reported (see table). lg4 screen: fast lean Grazer takes over Live in 60 min, so speed matters and balance is now the open problem. Recipe draft: backprop (everyTick, targetKl 0.02) or ES 100x1 from random for basics; ES 10x5 with sigma 0.08 to fine-tune founders; judge on 64+ paired held-out seeds of envs not trained on; a speed gate; then a short Live screen. Pools: pick by Live screen survival, not by env held-out rank.
- 2026-10-22. Raw probe logs live in the lab worktree, agg/src/typescript/runs/agg/rl-notes-logs/.
- 2026-10-22. Round 2 (C2 to C5) started on Erik's brief: T5 proof protocol, T6 learner ceiling, T7 env ceiling, T8 efficiency. T5 done: rlProof.ts shows learning beyond luck on all three envs with both learners.
- 2026-10-22. Round 2 C2 to C4 done. Recipe now: founders ES 10x5, sigma 0.08, several times longer than 60 iterations, on a rotated env mix, judged on unseen envs with 64 paired seeds (rlProof.ts). Fresh bodies ES 50x1 and long sight. Open: plateau past about 500 CPU s, PPO collapse, C5 Live screens of the winners.
- 2026-10-22 review fixes. The C3 learner row had a typo in the long-rays CI, now [1.90, 4.29] as in t6-ceiling-learner.md.
