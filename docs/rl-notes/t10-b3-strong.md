# T10 B3: Strong tier with 6 training seeds (2026-11-11)

Same method as `t10-b1-tiers.md`: Strong (200 s, 357 CPU s), 10 bodies, random-brain start, scored with `probes/b1-score.ts` (64 test seeds), analysed with `probes/b1-analyze.py`.
Training seeds 3 to 6 were added for current, ppo-mix1 (lr 0.001, shipped), ppo-mix (lr 0.003).
ppo-mix also got seeds 1 and 2 (it had none at Strong).
ppo-mix30 has seeds 1 to 3 only (stopped early, it was not competitive).
The Live check (`b1-live.ts`) was not run.

## Levels (median over the 10 bodies of the seed-mean)

| protocol  | seeds | bigger surv | bigger food | bigger poison | held2 surv | held2 food | held2 poison | long surv | long food | long poison |
|-----------|------:|------------:|------------:|--------------:|-----------:|-----------:|-------------:|----------:|----------:|------------:|
| untrained |     - |        0.94 |        0.26 |          0.42 |       0.91 |       0.15 |         0.79 |      0.52 |      0.33 |        0.04 |
| current   |     6 |        0.62 |        7.85 |          1.97 |       0.48 |       6.09 |         3.12 |      0.48 |     10.17 |        0.79 |
| ppo-mix1  |     6 |        0.72 |       11.33 |          1.15 |       0.62 |       9.84 |         1.94 |      0.82 |     15.40 |        0.35 |
| ppo-mix   |     6 |        0.77 |       11.16 |          1.02 |       0.69 |       9.77 |         1.72 |      0.83 |     15.92 |        0.34 |
| ppo-mix30 |     3 |        0.72 |       11.00 |          1.23 |       0.62 |       9.23 |         2.07 |      0.76 |     14.54 |        0.40 |

## ppo-mix1 minus current (min / median / max over bodies of the paired difference, bodies with the CI above / below 0, bodies where all 6 seeds agree in sign)

| scope  | metric | min   | median | max   | up | down | seeds agree |
|--------|--------|------:|-------:|------:|---:|-----:|------------:|
| bigger | surv   | -0.16 |  +0.13 | +0.35 |  6 |    4 |        3/10 |
| bigger | food   | +1.00 |  +3.69 | +5.91 | 10 |    0 |        9/10 |
| bigger | poison | -2.60 |  -0.92 | +0.85 |  4 |    6 |        3/10 |
| held2  | food   | +0.81 |  +3.22 | +6.12 | 10 |    0 |        9/10 |
| long   | surv   | -0.03 |  +0.26 | +0.51 |  8 |    2 |        6/10 |
| long   | food   | +0.85 |  +5.39 | +8.50 | 10 |    0 |        7/10 |

ppo-mix minus current is the same picture (bigger food +4.03 with 9 up and 1 down, long surv +0.27 with 8 up and 2 down, held2 poison -1.40 with 2 up and 7 down).

## ppo-mix minus ppo-mix1 (paired over all seeds and test seeds)

| scope  | metric | min   | median | max   | up | down | seeds agree |
|--------|--------|------:|-------:|------:|---:|-----:|------------:|
| bigger | surv   | -0.04 |  +0.02 | +0.13 |  5 |    1 |        1/10 |
| bigger | food   | -3.59 |  -0.06 | +1.25 |  4 |    4 |        0/10 |
| bigger | poison | -1.00 |  -0.16 | +0.24 |  3 |    5 |        1/10 |
| held2  | surv   | -0.07 |  +0.05 | +0.23 |  6 |    1 |        1/10 |
| held2  | food   | -3.71 |  -0.09 | +1.23 |  4 |    3 |        0/10 |
| held2  | poison | -1.84 |  -0.20 | +0.44 |  1 |    5 |        2/10 |
| long   | surv   | -0.21 |  -0.00 | +0.08 |  4 |    1 |        0/10 |
| long   | food   | -6.12 |  -0.03 | +2.65 |  4 |    2 |        1/10 |
| small  | surv   | -0.05 |  +0.03 | +0.11 |  7 |    1 |        1/10 |
| small  | food   | -2.64 |  +1.08 | +2.31 |  7 |    1 |        3/10 |

## Verdict

Strong stays at PPO lr 0.001, 16 episodes, recommended mix (no code change).
- 6 seeds confirm the B1 result against current: ppo-mix1 has more food on 10/10 bodies (median +3.7 bigger, +5.4 long) and more long survival (+0.26, 8 up and 2 down).
- ppo-mix (lr 0.003) is not distinguishable from ppo-mix1. Medians of the food and long differences are about 0. Its small edge in survival (bigger +0.02, held2 +0.05, small +0.03) and poison (about -0.2 per minute) has seed agreement of 0 to 2 bodies out of 10, so it does not hold across training seeds. Medium's reason for lr 0.003 (poison, survival) shows only as a hint here and with a few bodies worse in food (min -3.6).
- ppo-mix30 (3 seeds) is not better than either on any column.
- Poison versus current is not settled at Strong: bigger poison 4 up and 6 down, only 3/10 seeds agree.
- Open: a Live survival check of ppo-mix against ppo-mix1 would be the tie-breaker if one is wanted. The B1 Live check (2 seeds) favoured ppo-mix1 (life 227 s).

Run files: `src/typescript/runs/b1/t-strong-*-s*.json` (untracked), queue `runs/b1/queue-b3.sh`.
