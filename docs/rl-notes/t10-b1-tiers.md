# T10 B1: training tiers for "Add your creature"

Question: the best protocol per budget for training a random brain on the Live page. Tiers are TOTAL seconds: Light 30, Medium 75, Strong 200 (today: 30 s per kind, 60 s in all, ES on far-food, patch, minefield, then crowd, rivals).
Result is `TRAIN_TIERS` in `src/sim/rl/trainTiers.ts` (plain data, no imports). Probe: `src/rlTiers.ts` (`--list`, `--calibrate`, `--tier T --protocol P --designs p1,p2 --seed S --out DIR`, `--final` for the table).

## Method

- Budget match: `rlTiers.ts` runs the Arena's own `ArenaRun` with one in-process helper, keeps the best brain on the held-out checks (every 5 iterations, 4 seeds per env) as `live/training.ts` does, and drops anything after the budget as the browser timer would. A tier's seconds become CPU seconds of one thread: 3 helpers x 0.85 efficiency x 0.7 for a mid laptop core against this machine = 1.79, so Light 54, Medium 134, Strong 357 CPU seconds. These factors are assumptions, no browser was measured.
- Cost seen (this machine, one thread): current protocol 0.59 CPU s per ES iteration on the small rooms, 1.9 on crowd and rivals; ES on the recommended mix 16 s per iteration (so it never reaches a keep-best check in Light or Medium); PPO 0.75 to 0.9 s per update of 16 episodes.
- Start: random brains (primary), the 8 panel designs plus p9 (16 rays, 4x32) and p10 (2 rays, 1x4, memory 8+8), `src/sim/rl/b1Bodies.ts`; the panel itself is unchanged. Training seeds 1 and 2 for every protocol, seeds 3 to 6 added for the leading ones (Light: ppo-hi, ppo-mix1; Medium: ppo-mix1, ppo-mix). Strong only has seeds 1 and 2.
- Score: the transfer battery, 64 test seeds, scopes bigger, held2 (live-poison, live-commons), long (240 s), small. Live check: `probes/b1-live.ts` seeds the server's LiveWorld (800 copies of each founder, 4900 creatures at the end), inserts 2 copies of every body of every set, runs 240 s, 2 training seeds x 3 world seeds.
- Not run: the founder and reshaped starts (secondary check), re-scoring the top 3 checkpoints, shortened-copy ES beyond `live30-es`, Strong beyond 2 seeds.

## Protocols (names in `rlTiers.ts`)

current = ES 24 pairs, sigma 0.05, lr 0.02, 50/50 pretrain (far-food, patch, minefield) and fine-tune (crowd, rivals). pre-only = the pretrain alone. hyperA = current with 12 pairs, sigma 0.08, lr 0.03. live30-es / hyperA-live = ES on live-now, live-patch, live-famine capped at 30 s. ppo-mix = PPO lr 0.003 on RECOMMENDED_MIX; ppo-mix1 = lr 0.001; ppo-mix30 = lr 0.001 with every episode capped at 30 s; ppo-hi = lr 0.01 capped at 30 s; ppo-hi8 = as ppo-hi with 8 episodes per update.

## Levels (median over the 10 bodies of the mean over training seeds)

Surv = survival share, food = food per minute. Poison per minute for the chosen rows is in the Live-like scopes below.

| tier   | protocol  | bigger surv | bigger food | held2 surv | held2 food | long surv | long food |
|--------|-----------|------------:|------------:|-----------:|-----------:|----------:|----------:|
| all    | untrained |        0.94 |        0.26 |       0.91 |       0.15 |      0.52 |      0.33 |
| light  | current   |        0.81 |        1.97 |       0.72 |       1.49 |      0.42 |      2.43 |
| light  | hyperA    |        0.62 |        5.48 |       0.48 |       3.97 |      0.42 |      7.35 |
| light  | ppo-mix1  |        0.74 |        5.91 |       0.59 |       4.84 |      0.58 |      7.17 |
| light  | ppo-hi    |        0.71 |        6.99 |       0.58 |       5.75 |      0.61 |      8.97 |
| medium | current   |        0.71 |        4.59 |       0.56 |       3.76 |      0.39 |      5.99 |
| medium | hyperA    |        0.60 |        6.98 |       0.47 |       5.38 |      0.42 |      9.08 |
| medium | ppo-mix   |        0.76 |        8.45 |       0.66 |       7.11 |      0.74 |     11.40 |
| medium | ppo-mix1  |        0.71 |        9.81 |       0.59 |       8.47 |      0.76 |     12.45 |
| strong | current   |        0.66 |        7.23 |       0.53 |       5.63 |      0.44 |      8.94 |
| strong | ppo-mix1  |        0.72 |       11.55 |       0.61 |       10.17 |      0.85 |     15.93 |
| strong | ppo-mix30 |        0.70 |       11.12 |       0.59 |        9.49 |      0.76 |     14.43 |

Other Light and Medium protocols (pre-only, live30-es, hyperA-live, ppo-hi8, ppo-mix30) are in the run files; none beat the rows above. Tables with min, median, max, up/down and seed agreement per body: `probes/b1-analyze.py`.

## Chosen protocol against current (median over bodies of the paired difference, bodies with the CI above / below 0)

| tier   | protocol | bigger food | held2 food | long surv | long food | held2 poison |
|--------|----------|------------:|-----------:|----------:|----------:|-------------:|
| light  | ppo-hi   | +3.9 (10/0) |  +3.5 (10/0) | +0.18 (7/1) | +5.1 (10/0) | +0.3 (3/3) |
| medium | ppo-mix  | +4.3 (9/1)  |  +3.8 (9/1)  | +0.24 (7/2) | +5.2 (9/1)  | -0.9 (2/6) |
| strong | ppo-mix1 | +4.0 (10/0) |  +3.5 (10/0) | +0.28 (8/0) | +6.5 (9/0)  | -0.8 (3/5) |

Light and Medium cells are from the 2-seed screen (6-seed runs agree in sign and size, see the levels table). Training seed agreement is 7/10 to 10/10 bodies on these cells.

## Live survival check (median over the 10 bodies of the per-body mean; life in seconds of 240, censored at the horizon)

| set (training seed 1 and 2 pooled) | life s | children | bodies with longer life than untrained |
|------------------------------------|-------:|---------:|--------------------------------------:|
| untrained                          |  129.7 |     0.00 |                                  - |
| Light current                      |  126.8 |     0.17 |                                 5/10 |
| Light ppo-hi                       |  197.3 |     2.50 |                                 9/10 |
| Light ppo-mix1                     |  196.3 |     1.17 |                                 9/10 |
| Medium current                     |  147.5 |     0.83 |                                 7/10 |
| Medium ppo-mix                     |  207.3 |     1.67 |                                 8/10 |
| Medium ppo-mix1                    |  201.6 |     1.38 |                                 9/10 |
| Strong current                     |  159.6 |     0.71 |                                 7/10 |
| Strong ppo-mix1                    |  226.9 |     1.88 |                                10/10 |
| Strong ppo-mix30                   |  206.8 |     1.00 |                                 9/10 |

All sets share one world per run (2 copies per body per set, so 200 inserted creatures among about 2400), so they compete with each other. Offspring counts are small numbers.

## Choice

PPO on the recommended mix wins every tier on food and on Live lifespan and offspring; ES (current or retuned) is behind at all three budgets. The learning rate is the one setting that moves with the budget.

| tier   | seconds | protocol                                                              |
|--------|--------:|-----------------------------------------------------------------------|
| Light  |      30 | PPO lr 0.01, 16 episodes per update, every episode capped at 30 s      |
| Medium |      75 | PPO lr 0.003, 16 episodes per update                                   |
| Strong |     200 | PPO lr 0.001, 16 episodes per update                                   |

Why: Light has about 150 updates, so it needs the large step and short Live-like episodes (ppo-hi has the most food, and Live life 197 s against 130 untrained and 127 current). Medium picks lr 0.003 over 0.001 for lower poison and higher survival (bigger 0.76 against 0.71, poison per minute 1.05 against 1.39) at 1.4 food per minute less. Strong picks lr 0.001 (Live life 227 s, long survival 0.85).

## Caveats

- Training lowers survival on the short Live-like scopes against the untrained random brain (bigger 0.94 untrained, 0.70 to 0.76 trained): a random brain mostly sits still and keeps its starting energy. It eats more than 20 times as much and survives much longer in the 240 s runs and in the Live check, but it also bites poison more (bigger poison per minute 0.4 untrained, about 1.1 to 1.7 trained).
- Spread: bodies differ a lot (the cells above list min and max in the analysis tables), and the screen has only 2 training seeds for most protocols, 6 for the leaders at Light and Medium, 2 at Strong.
- The budget conversion rests on the assumed browser factor 1.79 (see Method). If the browser is slower the tiers get fewer updates; the PPO ranking at Light and Medium would need a recheck.
- The held-out keep-best uses 4 seeds per env and the best of many checks (winner's curse); not re-scored here.
- Founder and reshaped starts were not tested. Earlier notes found PPO from a trained brain flat or collapsing, so if "Add your creature" starts from a founder, check this before shipping the PPO tiers there.
