# T10 B5: tier choice at the browser's real PPO budget

Question: B4 measured that headless Chrome gives PPO about 0.73 of the probe's updates (about 1.3 CPU-s per tier second, against 1.79 in `rlTiers.ts`). Does the per-tier learning rate still hold, and does keep-best with 16 held seeds per env help over Live's 4?

## Method

- Probe: `src/rlTiers.ts --cpu-per-second 1.3` (default stays 1.79), new protocols `ppo-hi-h16` and `ppo-mix-h16` (the shipped protocol with `Start.held` 16, same `held` field as the B2 probe). Light = 39 CPU s, Medium = 97.5 CPU s per body.
- 10 B1 bodies from random starts, training seeds 1 and 2, then 3 and 4 for the leaders (Light ppo-hi, ppo-mix30; Medium ppo-mix, ppo-mix1). Scored on the 64-seed battery. Runs and scripts: `runs/b5/` (untracked), analysis `probes/b1-analyze.py` with `B1_BASE=<shipped protocol>`.
- Light: ppo-hi (shipped, lr 0.01, 30 s cap), ppo-mix30 (lr 0.001, 30 s cap), ppo-hi-h16. Medium: ppo-mix (shipped, lr 0.003), ppo-hi, ppo-mix1 (lr 0.001), ppo-mix-h16.

## Levels (median over the 10 bodies of the seed-mean)

Light, 4 seeds for ppo-hi and ppo-mix30, 2 seeds for ppo-hi-h16 (their 2-seed ppo-hi row: bigger food 5.21, surv 0.71).

| protocol   | bigger surv | bigger food | bigger poison | held2 surv | held2 food | held2 poison | long surv | long food |
|------------|------------:|------------:|--------------:|-----------:|-----------:|-------------:|----------:|----------:|
| untrained  |        0.94 |        0.26 |          0.42 |       0.91 |       0.15 |         0.79 |      0.52 |      0.33 |
| ppo-hi     |        0.72 |        4.62 |          1.34 |       0.60 |       3.51 |         2.29 |      0.55 |      6.33 |
| ppo-mix30  |        0.71 |        6.28 |          1.58 |       0.58 |       5.08 |         2.58 |      0.57 |      7.81 |
| ppo-hi-h16 |        0.81 |        3.20 |          0.90 |       0.72 |       2.48 |         1.72 |      0.49 |      4.28 |

Medium, 4 seeds for ppo-mix and ppo-mix1, 2 seeds for ppo-hi and ppo-mix-h16 (their 2-seed ppo-mix row: bigger food 9.12, surv 0.76).

| protocol    | bigger surv | bigger food | bigger poison | held2 surv | held2 food | held2 poison | long surv | long food |
|-------------|------------:|------------:|--------------:|-----------:|-----------:|-------------:|----------:|----------:|
| ppo-mix     |        0.76 |        8.56 |          1.11 |       0.67 |       7.29 |         1.90 |      0.73 |     11.35 |
| ppo-mix1    |        0.74 |        7.97 |          1.16 |       0.63 |       6.54 |         2.00 |      0.70 |     10.77 |
| ppo-hi      |        0.68 |        8.02 |          1.69 |       0.54 |       6.50 |         2.79 |      0.58 |     10.97 |
| ppo-mix-h16 |        0.75 |        7.55 |          1.36 |       0.61 |       6.34 |         2.26 |      0.68 |      9.61 |

## Against the shipped protocol (median paired difference over bodies; up/down = bodies with the pooled 95% CI above/below 0; agree = bodies where the seeds agree in sign)

| tier   | protocol    | seeds | bigger food (up/down, agree) | held2 surv (up/down) | held2 poison (up/down) | long surv (up/down) |
|--------|-------------|------:|-----------------------------:|---------------------:|-----------------------:|--------------------:|
| light  | ppo-mix30   | 4     | +1.5 (7/2, 5/10)             | -0.01 (2/4)          | +0.40 (5/2)            | +0.02 (5/4)         |
| light  | ppo-hi-h16  | 2     | -1.5 (0/10, 10/10)           | +0.13 (6/1)          | -0.76 (1/5)            | -0.06 (0/7)         |
| medium | ppo-mix1    | 4     | +0.5 (7/1, 4/10)             | 0.00 (2/4)           | +0.02 (4/1)            | -0.02 (0/2)         |
| medium | ppo-hi      | 2     | -0.6 (3/5, 6/10)             | -0.07 (2/5)          | +0.67 (5/2)            | -0.17 (0/8)         |
| medium | ppo-mix-h16 | 2     | -0.7 (0/7, 7/10)             | 0.00 (4/2)           | +0.06 (2/3)            | -0.03 (1/4)         |

## Findings

- Fewer updates do not favour a larger step. Medium ppo-hi (lr 0.01, 30 s episodes) makes about 1.6x the updates of ppo-mix (219 against 137 in 98 CPU s) but loses survival (long -0.17, 8/0 down) and gains poison. Medium ppo-mix1 ties ppo-mix, with seed agreement 0 to 4 of 10 bodies on every cell, so it is noise.
- Light ppo-mix30 (lr 0.001) is not clearly better than ppo-hi. Food is up on 7 bodies in the 4-seed pool, but only 5/10 bodies agree between seeds, survival is flat and poison is up. At 2 seeds it looked better (food +0.8), which the seeds 3 and 4 did not confirm.
- 16 held seeds hurt. Each keep-best check costs 4x, so Light makes 46 updates instead of 83 and Medium 79 instead of 137. Food falls on all bodies (Light 0/10 up, Medium 0/7 up). Light survival and poison improve (held2 surv +0.13, poison -0.76) mostly because the brains learn less. B2's noisy 4-seed keep-best is cheaper than a better-measured one at this budget.
- Against B1 at 1.79 (bigger food, B1 table): Light ppo-hi falls from 6.99 to 4.6 (5.2 on seeds 1 and 2), Medium ppo-mix stays at 8.56 against 8.45. Every learned protocol is still far above untrained (0.26).

## Verdict

No change to `trainTiers.ts`. Light lr 0.01, Medium lr 0.003 and Strong lr 0.001 stay, and Live keeps its default of 4 held seeds. No candidate was up on most bodies with seed agreement and survival and poison not worse. Strong was not rerun.
