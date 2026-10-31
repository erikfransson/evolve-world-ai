# T10 S1: procedural self-play worlds

Does training on a new random crowded world every episode, with the learner's genome playing several bodies next to league snapshots, give survival skill that transfers?
Append-only: mark items done, do not rewrite.
Code: `src/sim/rl/procEnv.ts` (generator, episode, reward), `rlTrain.ts --selfplay`, probes in `docs/rl-notes/probes/t10-s1-*`.

## Results

Compared on the M1 battery (`rlTransfer.ts`, 64 held-out seeds, rates per minute really played, rescored after commit 363ddf6) with three contrasting fresh designs from `designPanel.ts`: p1-tiny (3 short rays, 1x8), p5-many-rays (16 long rays, 2x16, memory 2+2), p7-big-memory (12 rays all round, 2x24, memory 4+4).
Equal training time: 300 s per run on 2 threads, ES 10 pairs, sigma 0.08, lr 0.02, 3 training seeds per cell (18 + 9 runs).
Fixed = current recipe (5 episodes per candidate, one env per step rotated over nibble, far-food, corridor, patch, minefield; 1600 to 2200 steps).
S1 = self-play, 2 episodes per candidate, crowd 5 to 50, 130 to 350 steps; food weight 0.25 (first try) or 3.
Cells are the mean over the 3 training seeds and the scope's envs. Delta is S1 food weight 3 minus fixed, paired over the 64 eval seeds (95% CI).

Scope long (live-now at 240 s, regrowing food, 20 rivals), the survival goal:

| design        | measure           | untrained | fixed | S1 w=0.25 | S1 w=3 | delta w=3 minus fixed   |
|---------------|-------------------|-----------|-------|-----------|--------|-------------------------|
| p1-tiny       | survival (share)  | 0.52      | 0.23  | 0.55      | 0.34   | +0.11 +-0.02            |
| p5-many-rays  |                   | 0.39      | 0.36  | 0.41      | 0.82   | +0.46 +-0.04            |
| p7-big-memory |                   | 0.45      | 0.37  | 0.45      | 0.68   | +0.31 +-0.04            |
| p1-tiny       | food per min      | 0.33      | 3.53  | 0.37      | 6.46   | +2.93 +-0.58            |
| p5-many-rays  |                   | 0.58      | 7.72  | 0.09      | 17.33  | +9.61 +-0.78            |
| p7-big-memory |                   | 0.06      | 8.18  | 0.41      | 12.84  | +4.66 +-0.76            |
| p1-tiny       | poison bites /min | 0.07      | 0.57  | 0.01      | 1.21   | +0.64 +-0.16            |
| p5-many-rays  |                   | 0.11      | 0.58  | 0.00      | 0.96   | +0.37 +-0.14            |
| p7-big-memory |                   | 0.00      | 0.50  | 0.00      | 0.64   | +0.14 +-0.13            |
| p1-tiny       | s to first food   | 142       | 49    | 145       | 15     | -34 +-14                |
| p5-many-rays  |                   | 121       | 15    | 206       | 3      | -12 +-6                 |
| p7-big-memory |                   | 214       | 12    | 165       | 5      | -7 +-6                  |

Spread of the w=3 minus fixed delta over the three designs (min / median / max): survival +0.11 / +0.31 / +0.46, food per min +2.9 / +4.7 / +9.6, poison bites per min +0.14 / +0.37 / +0.64 (more stings, worse), first food -34 / -12 / -7 s.

Scope bigger (90 s Live-like envs with rivals), same delta: survival -0.02 / -0.02 / +0.01 (no change), food per min +2.0 / +3.1 / +6.8, poison per min +0.9 / +1.2 / +1.3 (worse), first food -16 / -13 / -8 s.

Verdict:
- With the first reward (life + 0.25 x food share) S1 learns nothing useful in 300 s. The genomes stay untrained: food per min 0.1 to 0.4, survival high only because they stand still (long survival 0.41 to 0.55 against 0.23 to 0.37 for the fixed recipe, bigger scope 1.0). Standing still lives long on start energy, so lifetime alone pays idleness.
- With food weight 3 (reward below) S1 beats the fixed recipe on the 240 s Live-like scope for all three designs, with 5 to 12 times fewer steps: it forages as fast or faster and survives longer (p5 0.82 against 0.36). On the 90 s scope it matches fixed survival and forages more. It stings itself more than the fixed recipe (poison per min up 0.1 to 1.3). It is one training run per cell of 300 s and three designs, so call it a promising result, not a proven recipe. Not tested: longer budgets, the other five panel designs, a mix of S1 with the small envs, lineage weight above 0, PPO.
- Caveat: S1 is trained on the Live-like regime (regrowing food, collision damage, crowds) that the long scope measures, while the fixed mix has no regrowth and no crowd. Part of the gap is that match, not self-play itself. A fixed-env arm on Live-like envs (live-now, live-patch) at equal CPU was not run.

## S2: control, poison term, all 8 designs (2026-10-31)

Raw outputs: `runs/s1/`, `runs/s2/` in the worktree (git-ignored); comparisons in `runs/s2/cmp_*.txt`, made by `probes/t10-s1-agg.py`.
Same setup as above (300 s, 2 threads, ES 10 pairs, sigma 0.08, lr 0.02, M1 battery with 64 seeds, paired over eval seeds, CIs 95%).
Arms: livefixed = fixed recipe on Live-like envs (live-now, live-patch, live-poison, live-famine, live-commons rotated, 5 episodes per candidate, 160 to 195 steps); sp3p0 = S1 with food weight 3; sp3p1 = S1 with food weight 3 and poison weight 1 (reward minus P x poison bites / supply, the same supply as the food share). Caveat: livefixed trains on the same env ids the battery scores (different seeds), which favours it.

Step 1, Live-like control (3 designs, 3 seeds), sp3p0 minus livefixed. The control is much stronger than the small-env fixed recipe (long survival 0.45 / 0.72 / 0.56 against 0.23 / 0.36 / 0.37 for p1 / p5 / p7).
- long survival -0.11 / +0.10 / +0.11, food per min +1.0 / +2.0 / +0.8, poison per min +0.4 / +0.5 / -0.2.
- bigger survival -0.15 / -0.14 / +0.01, food per min +1.1 / +0.9 / -0.2, poison per min +1.0 / +1.4 / +0.2.
So most of the first S1 gain was the Live-like regime, not self-play. What remains is a small edge in food and in long survival for two designs, and a loss in bigger survival and in stings.

Step 2, poison term, sp3p1 minus sp3p0 (same 3 designs and seeds), P = 1 against P = 0:
- long survival +0.01 / +0.07 / +0.16, food per min -0.7 / +2.2 / +3.7, poison per min -0.30 / -0.24 / +0.11.
- bigger survival +0.09 / +0.07 / +0.02, food per min -0.5 / +1.1 / +1.8, poison per min -0.85 / -0.71 / -0.03.
P = 1 helps in nearly every cell (CI above 0 or level), so P = 1 is the S1 setting.
Against livefixed (3 designs): long survival -0.10 / +0.17 / +0.28, food per min +0.3 / +4.2 / +4.5; bigger survival -0.06 / -0.08 / +0.03, food per min +0.6 / +2.0 / +1.6. S1 still beat the control on long for 2 of 3 designs, so step 3 ran.

Step 3, all 8 panel designs, 2 training seeds, sp3p1 minus livefixed (paired over the 64 eval seeds, mean of both seeds; up / down = designs whose CI lies above / below 0):

| scope  | measure           | min    | median | max    | up | down |
|--------|-------------------|--------|--------|--------|----|------|
| long   | survival (share)  | -0.13  | +0.11  | +0.29  | 4  | 2    |
| long   | food per min      | -2.94  | +2.60  | +3.77  | 5  | 2    |
| long   | poison per min    | -0.51  | -0.01  | +0.35  | 2  | 2    |
| long   | s to first food   | -9.0   | +0.4   | +7.7   | 0  | 2    |
| bigger | survival (share)  | -0.09  | +0.01  | +0.13  | 2  | 2    |
| bigger | food per min      | -1.74  | +1.12  | +2.42  | 6  | 2    |
| bigger | poison per min    | -0.67  | +0.20  | +0.67  | 2  | 3    |
| bigger | s to first food   | -7.6   | -0.3   | +6.3   | 2  | 2    |

Per design, long survival / food per min (sp3p1 minus livefixed): p1-tiny -0.09 / +0.1, p2-narrow-long +0.03 / -2.9, p3-mid +0.17 / +3.2, p4-wide-short -0.01 / +2.9, p5-many-rays +0.11 / +2.6, p6-big-brain +0.14 / +1.1, p7-big-memory +0.29 / +3.8, p8-few-wide-mem -0.13 / -2.7. Both losses on long food are the two designs with few or very wide rays (p2, p8); p1 (3 short rays) has no gain either.

Verdict S2: after the control, S1 with P = 1 is a modest gain, not a clear win. Median over 8 designs: long survival +0.11, long food +2.6 per min, bigger food +1.1 per min, bigger survival level, stings level to slightly up on bigger (+0.2 per min, 3 designs better, 2 worse). It helps most for designs with enough rays and memory (p3, p5, p6, p7) and hurts p2 and p8. About half of the designs win by CI on each measure, two lose, so it is not reliably better than training on Live-like envs. The fixed recipe on Live-like envs is the strong baseline to use (it beats the small-env recipe by a wide margin), and procedural worlds plus self-play add something on top for some bodies. Limits: 300 s runs, 2 training seeds for 5 of 8 designs, the control sees the battery's env ids, no repeat of the whole 8-design set.
- Raw numbers per run in `runs/s2/*.log` (training held-out is on each arm's own scale).

## Generator and reward (procEnv.ts, PROC_DEFAULTS)

Every value is drawn from the episode seed, so a seed is one world and training seeds never repeat.
- Crowd N: log-uniform 5 to 50 (the Arena limit would allow more; see cost). The learner's genome plays round(N/2) bodies (at least 1, always at least 1 league body); the other bodies play genomes drawn from the league at random (the SELF library: current weights plus the 4 best candidates of recent steps; a mirror of the learner when empty).
- World area: N x log-uniform 40 000 to 120 000 per creature (Live now: 68 000), short side over long side 0.6 to 1, sides clamped to 200 to 3000.
- Start food N x log-uniform 1.5 to 4.5, regrowth N x log-uniform 0.01 to 0.06 items per second (Live now: 2.9 and 0.03), poison N x uniform 0.1 to 1.2, sting uniform 20 to 50 energy (20% of worlds: lethal), kill bonus 5, bumps hurt.
- Layout: open scatter 50%, else patch, islands, rooms or fence (12.5% each), sizes scaled to the world; bodies start at random spots off the poison walls.
- Start energy for every body uniform 100 to 300, episode length uniform 40 to 90 s; the episode ends early when all the learner's bodies are dead.
- Reward of an episode: mean over the learner's bodies of life + w x bites / supply, with life = seconds lived / episode length (1 when alive at the end), bites = food eaten, supply = (start food + regrowth x length) / N, w = 3 (`--foodw`). Optional `--lineage L` adds L x (learner share of the creatures alive at the end), default 0 and not tested. Lineage here is the genome group, since births are off in RL worlds.
- ES gets one scalar per episode: the mean over bodies, so a 50-body world is one sample with less noise rather than 50 samples.

## Cost per episode (Grazer, 6 to 12 seeds, default ranges, CPU ms, load average 5 to 10)

| crowd | ms per episode | ticks played | learner life share | bites per body | learner bodies alive at end | peak RSS MB |
|-------|----------------|------------------------------|--------------------|----------------|-----------------------------|-------------|
| 5     | 79             | 1536                         | 0.70               | 3.4            | 0.21                        | 108         |
| 10    | 64             | 1756                         | 0.70               | 3.7            | 0.28                        | 111         |
| 25    | 127            | 1727                         | 0.66               | 3.2            | 0.18                        | 115         |
| 50    | 190            | 1674                         | 0.66               | 3.5            | 0.22                        | 121         |
| 100   | 277            | 1793                         | 0.67               | 3.6            | 0.21                        | 129         |

Cost grows far slower than the crowd (100 bodies cost 3.5 times 5 bodies) because most bodies die within the episode. A fixed small env costs 3 to 6 ms, so one S1 episode costs 15 to 60 small episodes; one S1 step (20 candidates x 2 episodes) took 1.2 to 2.3 s on 2 threads at crowd 5 to 50. Training uses 5 to 50 for that reason; 100 is affordable for a final polish but memory stays near 130 MB so it is not the limit. The Grazer lives 66 to 70% of the episode and the learner's bodies are mostly dead at the end (alive 0.2), so the reward is not saturated.

## Log

- 2026-10-30 to 31. Built generator, `runEpisode` dispatch on `EnvSpec.proc`, `rlTrain --selfplay --crowd LO,HI --foodw W --lineage L --mix a,b --budget SEC --from design:ID|founder:ID`. Default paths are unchanged: rlBench fingerprint 1301207144 before and after, tests `rl*`, `arena` pass, new `rlSelfplay.test.ts` (determinism, ranges, league use, reward).
- 2026-10-31. The shared lock queue was the main delay (14 min to 3 h per job), not compute. Training per cell is 5 min.
- Self-play held-out numbers printed by rlTrain are on the self-play reward scale and not comparable to the fixed recipe's; only the battery numbers above compare them.
- Open: Grazer start (optional point in the brief) not run; p1 trained with w=3 in a separate run from p5 and p7, same settings; the 5 remaining panel designs; fixed arm on Live-like envs at equal CPU; longer budgets; whether the extra stings (poison per min) can be cut by a poison term in the reward.
