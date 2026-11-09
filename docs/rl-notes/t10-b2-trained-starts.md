# T10 B2: training tiers for a trained start (founder or upload)

Question: for "Add your creature" from a founder or an uploaded trained brain, does any protocol beat no training and the shipped scaled ES at Light 30 s, Medium 75 s and Strong 200 s, with Live survival weighted as much as food?
Result: `TRAIN_TIERS_TRAINED` in `src/sim/rl/trainTiers.ts`. It uses PPO lr 0.0005 on the recommended mix at every tier, then a re-score on 32 held seeds that keeps the start unless the trained brain wins. This is data only, and Live is not wired.

## Method

- Probe: `rlTiers.ts --from SPEC` (starts from `rlStarts.ts`: `founders` = the 3 Live founders of `public/live-founders.json`, `NAME=FILE` = a learner file), the B1 budget model (1.79 CPU s per browser second, keep-best on 4 held seeds every 5 iterations), and `--rescore 32`. Scoring: `probes/b2-score.ts` (the 64-seed transfer battery), `probes/b2-live.ts` (the B1 Live check), tables by `probes/b2-analyze.py` and `probes/b2-live-analyze.py`.
- Starts (8): founders Juggernaut, Oracle, Grazer. Uploads are B1 outputs: Strong ppo-mix1 seed 1 for p5, p3, p4 and p10 (Live-long food per minute 21, 15, 8, 18), and Light ppo-hi p6, the weaker start (7).
- Re-score (protocol (d)): the start and the kept brain on 32 held seeds of the mix, scored as the worker's "ready" score of a 0-iteration ES run (so poison costs 1 per bite, as in ES rewards). It costs about 6 CPU s per brain. `X+r` is that choice made after the run, outside the budget. `X+rb` pays it inside the budget: the start is re-scored first and training gets the budget less twice that cost (Light 41 of 54 CPU s, Medium 122 of 134, Strong 343 of 357).
- Training seeds 1 and 2 for the screen, and 3 to 6 for ppo05 at each tier. Paired differences against the start (a) on the same 64 test seeds.

Protocols: current = the shipped ES (pretrain far-food, patch, minefield, then crowd, rivals, half the seconds each, 24 pairs, sigma 0.05, lr 0.02). es-s02 = current with sigma 0.02. es-h16 = current with keep-best on 16 held seeds. ppo05 / ppo-mix1 = PPO lr 0.0005 / 0.001 on RECOMMENDED_MIX, 16 episodes per update. ppo05-h16 = ppo05 with keep-best on 16 seeds. Light and Medium ran all of these. Strong ran current and ppo05 only, because the ES variants and ppo-mix1 had already lost at Light and Medium.

## Screen: protocol minus start (2 training seeds, 8 starts)

Median over starts of the seed-mean difference (min, max), then the starts whose pooled 95% CI is above / below 0. Long = 240 s live-now, bigger = the five live-* envs, held2 = live-poison and live-commons.

| tier   | protocol  | long food            | long surv            | bigger surv          | held2 poison/min     |
|--------|-----------|----------------------|----------------------|----------------------|----------------------|
| light  | current   | -2.65 (-5.99, +0.54) 0/6 | -0.08 (-0.38, +0.05) 2/6 | -0.02 (-0.13, +0.17) 2/4 | -0.18 0/3 |
| light  | es-s02    | -2.44 (-6.86, +1.55) 1/6 | -0.10 (-0.26, +0.07) 1/6 | -0.02 (-0.13, +0.17) 2/3 | +0.29 4/2 |
| light  | es-h16    | -1.89 (-7.30, +1.59) 1/4 | -0.07 (-0.47, +0.05) 2/4 | -0.04 (-0.12, +0.16) 2/5 | +0.07 1/2 |
| light  | ppo-mix1  | +0.06 (-0.62, +3.08) 2/0 | -0.00 (-0.03, +0.08) 2/0 | -0.01 (-0.06, +0.09) 2/2 | +0.02 0/2 |
| light  | ppo05     | +0.71 (-0.53, +2.98) 3/0 | +0.03 (-0.02, +0.09) 4/0 | +0.00 (-0.05, +0.08) 2/2 | -0.08 1/3 |
| light  | ppo05-h16 | +0.78 (-0.18, +1.92) 3/0 | +0.03 (-0.00, +0.07) 3/0 | -0.00 (-0.07, +0.10) 3/2 | -0.07 1/2 |
| light  | ppo05+rb  | +0.30 (+0.00, +1.92) 2/0 | +0.02 (+0.00, +0.07) 2/0 | +0.00 (-0.03, +0.10) 2/1 | +0.00 2/2 |
| medium | current   | -0.66 (-3.41, +0.99) 0/3 | -0.04 (-0.19, +0.07) 1/4 | -0.06 (-0.18, +0.11) 2/5 | +0.37 4/1 |
| medium | ppo-mix1  | +0.25 (-2.07, +6.12) 2/1 | -0.02 (-0.05, +0.20) 1/1 | -0.00 (-0.05, +0.11) 3/2 | -0.23 0/2 |
| medium | ppo05     | +0.88 (-0.76, +4.86) 4/0 | +0.03 (-0.03, +0.14) 2/0 | +0.00 (-0.03, +0.08) 2/1 | +0.01 1/3 |
| medium | ppo05-h16 | +0.89 (-0.65, +4.42) 3/0 | +0.03 (-0.02, +0.13) 1/0 | +0.00 (-0.04, +0.08) 2/2 | -0.05 0/2 |
| medium | ppo05+rb  | +0.88 (+0.00, +4.86) 4/0 | +0.03 (+0.00, +0.14) 2/0 | +0.00 (-0.03, +0.08) 3/1 | +0.00 1/2 |
| strong | current   | -0.61 (-4.35, +8.08) 2/4 | -0.04 (-0.20, +0.11) 2/4 | -0.07 (-0.24, +0.14) 2/5 | +0.67 5/2 |
| strong | ppo05     | +0.64 (-0.98, +6.25) 4/0 | +0.02 (-0.03, +0.11) 2/0 | +0.01 (-0.05, +0.07) 3/1 | -0.12 0/2 |
| strong | ppo05+rb  | +0.32 (+0.00, +6.25) 3/0 | +0.00 (-0.01, +0.11) 2/0 | +0.01 (-0.02, +0.07) 3/1 | +0.00 0/3 |

Start levels (median over starts): long food 17.8 per min, long survival 0.86, bigger survival 0.69.

## Leader at 6 training seeds

| tier   | protocol | long food            | long surv            | bigger food          | held2 food           | kept / cells |
|--------|----------|----------------------|----------------------|----------------------|----------------------|-------------:|
| light  | ppo05    | +0.50 (-0.30, +4.23) 5/0 | +0.02 (-0.00, +0.13) 4/0 | +0.27 (-0.10, +3.01) 5/0 | +0.12 (-0.18, +2.44) 3/0 | - |
| light  | ppo05+r  | +0.42 (-0.24, +4.23) 4/0 | +0.02 (-0.01, +0.13) 5/0 | +0.29 (-0.01, +3.01) 5/0 | +0.12 (-0.18, +2.44) 3/0 | 31/48 |
| medium | ppo05    | +0.90 (-0.54, +5.27) 5/0 | +0.01 (-0.02, +0.13) 3/0 | +0.48 (-0.08, +3.70) 6/0 | +0.47 (-0.11, +2.85) 4/0 | - |
| medium | ppo05+r  | +0.81 (-0.11, +5.27) 6/0 | +0.01 (-0.01, +0.13) 3/0 | +0.42 (+0.00, +3.70) 6/0 | +0.32 (-0.01, +2.85) 5/0 | 33/48 |
| strong | ppo05    | +0.72 (-0.62, +6.50) 5/1 | +0.01 (-0.01, +0.13) 2/0 | +0.28 (-0.12, +4.44) 5/0 | +0.37 (-0.66, +3.60) 4/1 | - |
| strong | ppo05+r  | +0.77 (-0.04, +6.50) 6/0 | +0.02 (-0.00, +0.13) 4/0 | +0.36 (-0.03, +4.44) 5/0 | +0.28 (-0.10, +3.60) 4/0 | 32/48 |

Per start (ppo05, 6 seeds, long food per minute): the weak upload L-p6 gains +4.2 / +5.3 / +6.5 at Light / Medium / Strong. The other uploads and Grazer gain +0.4 to +1.4. Juggernaut and Oracle lose -0.2 to -0.6, with survival -0.00 to -0.02. In the 2-seed `+rb` runs the re-score kept Juggernaut and Oracle in every cell, at every tier.
Training-seed agreement is low (2/8 to 4/8 at 6 seeds): beyond L-p6 the gains are about the size of the seed-to-seed spread.

## Live check (b2-live, 2 training seeds x 3 worlds, 2 copies per set and start, life of 240 s)

| set              | life s, median over starts (min, max) | children | starts longer / shorter than start |
|------------------|--------------------------------------:|---------:|-----------------------------------:|
| start (a)        | 215.0 (159, 240)                      |     1.67 | -                                  |
| Light current    | 211.5 (112, 240)                      |     1.67 | 3/5                                |
| Light ppo05      | 223.4 (143, 238)                      |     1.96 | 5/3                                |
| Light ppo05+r    | 222.1 (181, 237)                      |     1.79 | 4/2                                |
| Medium current   | 213.5 (98, 240)                       |     1.67 | 4/4                                |
| Medium ppo05     | 229.5 (163, 240)                      |     1.92 | 5/3                                |
| Medium ppo05+r   | 224.9 (163, 236)                      |     1.75 | 4/2                                |
| Strong current   | 206.6 (149, 234)                      |     1.62 | 3/5                                |
| Strong ppo05     | 220.5 (114, 236)                      |     1.79 | 5/3                                |
| Strong ppo05+r   | 219.6 (136, 230)                      |     1.75 | 3/3                                |

All sets share a world, 12 copies per cell in all. The direction agrees with the battery (ppo05 above start, current at or below it), but a single cell moves by 20 to 50 s between worlds. In this check S-p4 and S-p5 lived shorter after ppo05 at Strong.

## At B4's browser rates (PPO 1.3 CPU s per second)

ppo05 at 1.3 (`ppo05@1.3`, 2 seeds) against the start:

| tier   | protocol     | long food            | long surv            | bigger food          |
|--------|--------------|----------------------|----------------------|----------------------|
| light  | ppo05@1.3    | +0.42 (-0.53, +1.92) 2/0 | +0.04 (-0.02, +0.07) 4/0 | +0.12 (-0.22, +1.70) 3/0 |
| light  | ppo05@1.3+r  | +0.26 (+0.00, +1.92) 2/0 | +0.02 (+0.00, +0.07) 2/0 | +0.08 (+0.00, +1.70) 3/0 |
| medium | ppo05@1.3    | +0.88 (-0.22, +4.42) 4/0 | +0.03 (-0.03, +0.13) 2/0 | +0.50 (-0.26, +3.20) 5/0 |
| medium | ppo05@1.3+r  | +0.88 (+0.00, +4.42) 4/0 | +0.03 (+0.00, +0.13) 2/0 | +0.50 (+0.00, +3.20) 5/0 |
| strong | ppo05@1.3    | +0.33 (-0.60, +7.06) 2/0 | +0.00 (-0.02, +0.17) 2/0 | +0.12 (-0.23, +5.22) 3/0 |
| strong | ppo05@1.3+r  | +0.32 (+0.00, +7.06) 2/0 | +0.00 (-0.01, +0.17) 2/0 | +0.32 (+0.00, +5.22) 3/0 |

The ranking and sign hold at 1.3. Medium is unchanged, and Light and Strong gain less on 2 seeds (Strong's spread between seeds is as large as the difference).

The shipped ES was not re-run at B4's ES rate of 1.9, because that rate is within 6% of the probe's 1.79.

## Choice

| tier   | seconds | trained start (founder or upload)                                   |
|--------|--------:|---------------------------------------------------------------------|
| Light  |      30 | PPO lr 0.0005, 16 episodes, mix; re-score 32 seeds, keep start unless beaten |
| Medium |      75 | same                                                                |
| Strong |     200 | same                                                                |

- The shipped ES lowers trained starts at every tier: long food -0.6 to -2.7 per minute, long survival -0.04 to -0.08, and 3 to 6 of 8 starts significantly down. Smaller sigma and 16-seed keep-best do not fix it. Its envs (small rooms, then crowd and rivals) are not the mix the starts were trained on, and its keep-best measures only those envs.
- PPO lr 0.0005, the worker's lower clamp (alone, with h16 or with the re-score), is the only protocol family with no start significantly down on long food or long survival at any tier screened. The one exception is a single Strong start on long food at 6 seeds, which the re-score removes. lr 0.001 is flat at Light and mixed at Medium, so a trained brain wants the smallest step the worker allows.
- Keep-best on 16 held seeds (ppo05-h16) equals ppo05 for trained starts. It is not worth the updates it costs (B5 found about 45% fewer updates for Fresh starts).
- The re-score (d) is a safety net, not a gain. It turns the founders' small losses into 0 and lifts the minimum to about 0 on every metric, and the median moves by -0.4 to +0.1. Survival counts as much as food, and the founders are the panel's default start, so the floor wins. At Medium and Strong the in-budget cost is under 10% and leaves the median unchanged. At Light it costs a quarter of the updates (long food +0.30 against +0.71 on the same seeds), and at B4's 1.3 rate the share is larger still. A Light-only alternative is plain ppo05 without the re-score, which risks the founders' -0.2 to -0.5.
- Gains are small except for the weak upload: an already good brain is close to what 200 s of PPO can add. Strong gains no more than Medium.

## For wiring (orchestrator)

- `TrainTier.rescore` (32) is new: after the phases, score the start and the kept brain on `rescore` held seeds per env of the last phase's envs, and keep the start unless the kept brain is higher. The worker already takes `held` (1 to 32) in its start message, and a 0-iteration run's "ready" score is that score. The probe scored it as an ES run (poison cost 1 per bite); a backprop-method run scores without that cost.
- The start's re-score could run in the loading phase, before the clock starts, so only the kept brain's (about 6 CPU s on one thread) is paid inside the tier.
- The Arena worker cannot change PPO's action repeat (3 ticks) or `everyTick`: `backpropOptions` in `worker/arenaRun.ts` passes only lr (clamped to 0.0005 to 0.01) and episodes. Nothing here changed the worker. lr below 0.0005 is clamped, so it was not tested.

## Caveats

- 8 starts. The 3 founders are the Live default, but uploads are only B1 bodies trained on the same mix. An upload trained on other envs might gain more or less.
- Budget model: B1's factor 1.79 for the screen, with only the leader re-run at 1.3. The re-score cost is one-thread CPU; with 3 helpers in a browser it would take less wall time.
- The re-score uses the same held seeds every time (worker `heldSeeds`). Its choice is less noisy than 4-seed keep-best, but still a selection. In 2-seed Strong `+rb` it dropped a +2.7 gain for S-p3.
- The Live check has 12 copies per cell in a fresh world capped at 4900; it supports the direction but cannot rank ppo05 against ppo05+r.
