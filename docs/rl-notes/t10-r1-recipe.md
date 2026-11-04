# T10 R1: candidate default recipe (mix + per-bite poison cost)

Append-only. Question: does a poison cost in every env of the rotated half-small, half-Live-like mix make training better for any design, without per-design tuning?

## Results

ES, 8 designs of the panel (p1 to p8), 2 training seeds, 300 s, 2 threads, 10 pairs, sigma 0.08, lr 0.02, 5 episodes per candidate. M1 battery, 64 seeds. Arm a = mix without poison term (S3 mix arm; 4 designs reused from the S3 outputs, same settings, 4 rerun). Arm b = `reward.poison` 1, arm c = 3, on every env of the mix. Cells: difference to a, min / median / max over the 8 designs of the mean over both training seeds. Up/down = designs whose paired 95% CI is above/below 0.

| arm minus a | scope | metric       |    min | median |    max | up | down |
|-------------|-------|--------------|-------:|-------:|-------:|---:|-----:|
| b (poison 1) | small | food/min     |  -5.40 |  +0.52 |  +1.04 | 1 | 3 |
| b            | small | poison/min   |  -1.39 |  -0.69 |  +0.28 | 0 | 7 |
| b            | small | first food s |  -1.95 |  -0.25 |  +3.17 | 1 | 2 |
| b            | small | survival     |  -0.07 |  +0.02 |  +0.10 | 3 | 1 |
| b            | held2 | food/min     |  -1.62 |  -0.15 |  +0.84 | 2 | 2 |
| b            | held2 | poison/min   |  -1.44 |  -0.13 |  +0.42 | 0 | 3 |
| b            | held2 | first food s |  -5.98 |  -1.32 |  +4.31 | 1 | 1 |
| b            | held2 | survival     |  -0.04 |  +0.03 |  +0.08 | 2 | 0 |
| b            | long  | food/min     |  -2.81 |  -0.80 |  +0.78 | 0 | 4 |
| b            | long  | poison/min   |  -0.33 |  -0.14 |  +0.44 | 1 | 4 |
| b            | long  | first food s |  -0.45 |  +0.58 |  +1.29 | 1 | 0 |
| b            | long  | survival     |  -0.09 |  -0.01 |  +0.07 | 0 | 2 |
| c (poison 3) | small | food/min     |  -5.67 |  -1.22 |  -0.68 | 0 | 7 |
| c            | small | poison/min   |  -3.66 |  -2.05 |  -0.89 | 0 | 8 |
| c            | small | first food s |  -0.73 |  +0.27 |  +1.61 | 1 | 0 |
| c            | small | survival     |  +0.04 |  +0.09 |  +0.17 | 8 | 0 |
| c            | held2 | food/min     |  -4.36 |  -0.92 |  -0.24 | 0 | 7 |
| c            | held2 | poison/min   |  -3.17 |  -1.35 |  -0.52 | 0 | 7 |
| c            | held2 | first food s |  -7.48 |  +2.60 |  +5.84 | 2 | 1 |
| c            | held2 | survival     |  +0.06 |  +0.16 |  +0.43 | 8 | 0 |
| c            | long  | food/min     |  -7.23 |  -2.44 |  -1.71 | 0 | 8 |
| c            | long  | poison/min   |  -0.89 |  -0.46 |  -0.11 | 0 | 7 |
| c            | long  | first food s |  +0.35 |  +5.91 |  +8.34 | 4 | 0 |
| c            | long  | survival     |  -0.26 |  +0.01 |  +0.05 | 2 | 4 |

Level of arm a (median over designs): small food 12.5, poison 5.4, survival 0.47; held2 food 8.5, poison 4.1, survival 0.39; long food 14.7, poison 1.05, survival 0.67.

Backprop (rlGrad, 2000 updates = 32000 episodes, lr 1e-3, logStdMin -1, same mix), 3 designs (p1, p3, p6), 1 seed. p8 was dropped to free the lock. Difference to a, per design p1 / p3 / p6:

| arm minus a  | scope | survival              | food/min              | poison/min            |
|--------------|-------|-----------------------|-----------------------|-----------------------|
| b (poison 1) | small | +0.14 / +0.05 / +0.03 | -2.7 / +2.6 / -1.1    | -3.5 / -0.1 / -0.9    |
| b            | held2 | +0.21 / +0.08 / +0.22 | +0.7 / +3.2 / -0.2    | -1.6 / -0.3 / -1.4    |
| b            | long  | +0.12 / +0.10 / -0.04 | +0.1 / +2.5 / -1.6    | -0.6 / -0.05 / -0.3   |
| c (poison 3) | small | +0.14 / +0.03 / +0.07 | -1.2 / -0.1 / -3.2    | -4.3 / -0.9 / -2.1    |
| c            | held2 | +0.14 / +0.10 / +0.23 | -1.1 / +2.8 / -2.6    | -2.2 / -0.4 / -1.5    |
| c            | long  | -0.01 / +0.05 / -0.08 | -2.1 / +2.7 / -4.0    | -0.7 / -0.1 / -0.3    |

## Reading

- Poison cost 3 (ES): fewer stings in 8 of 8 designs on small and 7 of 8 on held2 and long, survival up in 8 of 8 designs on small and held2 (median +0.09, +0.16). Cost: food/min down 1 to 2.4 at the median (7 or 8 of 8 down), and long survival down in 4 of 8 designs (p5 -0.26, p7 -0.19, p8 -0.09, p6 -0.07). So it clearly hurts some designs on the long scope.
- Poison cost 1 (ES): same direction, much smaller. Stings down on small (7 of 8, median -0.69), survival flat to slightly up on small and held2, food within the noise floor on small and held2 (median +0.5 and -0.15) but down on long (median -0.8, 4 of 8). Worst single cell: long survival p5 -0.09. No design is clearly hurt on small or held2.
- Backprop: poison cost 1 helps held2 survival on all 3 designs (+0.08 to +0.22) and cuts stings, with food mixed in sign (p3 up, p1 and p6 slightly down). Cost 3 is similar but takes more food. One seed, 3 designs: a lead, not proof.
- Noise: one training seed moves food/min by about 4 per design (E1), so food cells of b are inside the floor, while the survival and sting effects of c are consistent in sign across designs.
- The reward only changes the training signal. The battery itself does not apply the cost.

## Recommendation

Use the S3 mix (nibble, live-now, far-food, live-patch, minefield, live-famine, stings, live-now, rotated) with `reward.poison` = 1 as the default. It lowers stings on most designs, does not clearly hurt any on small or held2, and costs a little long-scope food. Use 3 only as an opt-in "careful forager" preset, since it trades 1 to 2.4 food/min and long survival on four designs for 8 of 8 survival gains on held-out Live-like envs. Untested: a value between (about 2), more training seeds, backprop with p8 and the other four designs.

## Log

- 2026-10-31. Merged rl-selfplay and rl-diag into rl-recipe (rl-diag conflicted only in this folder's t10-m1-transfer.md, development's version kept). rl, ppo, arena tests pass (182), rlBench fingerprint 1301207144.
- 2026-10-31. Added `reward.poison` to EnvSpec (applied in runEpisode, so ES and PPO see it; PPO also charges it on the bite's step). `rlTrain --poison W`, `rlGrad --poison W` set it on all envs. PPO `poisonPenalty` stays a separate training-only shaping (it does not change the reported reward); the two add up. The S1 proc env keeps its own `poisonWeight` (scaled by food supply, so not the same unit) and ignores `reward.poison`. Tests (rl.test.ts, ppo.test.ts) fail without the term, checked by removing it.
- 2026-10-31. Runs and scoring as in Results. Raw outputs in git-ignored `runs/r1/`, tables from `probes/t10-s1-agg.py`.
- UI hook (not done, Arena files off limits): a "poison cost" field in the env editor (arenaPick reward weights; checkEnv already accepts `poison`), and a "Mix" preset for the 8 env ids.
