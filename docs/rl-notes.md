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

## Questions

- C1a: Why does backprop seem to learn little?
- C1b: What makes an env well suited for training?
- C1c: A systematic recipe (ES vs backprop vs hybrid, curricula, held-out measure, feed to founders).

Tracks: T1 backprop diagnosis, T2 ES learner quality, T3 env trainability, T4 recipe and transfer.

## Log

- 2026-10-21. Started from development 7df22c7. Prior work: docs/rl-grad-notes.md (PPO beats ES on nibble, corridor, minefield from random at equal wall time), docs/rl-algo-notes.md, docs/rl-envs.md. bp-investigate: no bug, gradient check passes; from a founder PPO starts near the ceiling and training scores look lower due to exploration noise.
- 2026-10-21. rl-54-56 speed check (bfe0375) narrows T4's speed claim. Creatures trained on Fading, Race or Nibble move at 60 to 72 in their own env, in Nibble and in Far food (untrained 0 to 7), as fast as Live survivors (63 to 77). So Arena envs in general do not teach slow play. T4's slow lean founders (lg8, lg8v2, la6 at 17 to 43 in envs) come from the lean lab recipe (lean-grazer and lean-aggr env sets, rivals, from random), not from envs in general. lg4 (63 to 65 in envs) is the test of whether speed alone decides Live (l10lg4, queued).
- 2026-10-22. All four tracks reported (see table). lg4 screen: fast lean Grazer takes over Live in 60 min, so speed matters and balance is now the open problem. Recipe draft: backprop (everyTick, targetKl 0.02) or ES 100x1 from random for basics; ES 10x5 with sigma 0.08 to fine-tune founders; judge on 64+ paired held-out seeds of envs not trained on; a speed gate; then a short Live screen. Pools: pick by Live screen survival, not by env held-out rank.
Raw probe logs live in the lab worktree, agg/src/typescript/runs/agg/rl-notes-logs/.
