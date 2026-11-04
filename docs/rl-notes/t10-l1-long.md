# T10 L1: does the recipe keep improving with long training?

Append-only. Question: with the candidate recipe (8-env mix, `--poison 1`), does held-out competence keep rising with budget, or plateau or collapse, and does the backprop log-std floor prevent the wall?

## Results (interim, 2026-11-04: 2k and 6k backprop updates, 300 s and 900 s ES; 18k, 50k, 2700 s and 8100 s not run)

Designs p1-tiny, p3-mid, p6-big-brain, training seed 1, M1 battery (`rlTransfer.ts`, 64 seeds). Cells are means per real minute (food, poison) or fraction (surv). small = minefield, stings, patch, far-food, islands. held2 = live-poison and live-commons (never trained on). long = live-long. Points: ES in 2-thread CPU seconds, backprop in updates (16 episodes each). Arms: es (10 pairs, 5 episodes, sigma 0.08, lr 0.02), bp-nofloor (lr 1e-3), bp-floor (lr 1e-3, `--logstd-min=-1`).

p1-tiny

| arm        | point | small food | small poison | small surv | held2 food | held2 poison | held2 surv | long food | long poison | long surv |
|------------|------:|-----------:|-------------:|-----------:|-----------:|-------------:|-----------:|----------:|------------:|----------:|
| untrained  |     0 |       0.32 |         0.78 |       0.77 |       0.17 |         1.02 |       0.86 |      0.33 |        0.07 |      0.52 |
| es         |   300 |       6.02 |         5.83 |       0.37 |       3.60 |         5.20 |       0.26 |      7.37 |        1.35 |      0.32 |
| es         |   900 |       6.26 |         3.47 |       0.44 |       4.83 |         3.73 |       0.40 |      7.26 |        1.08 |      0.33 |
| bp-nofloor |  2000 |       4.67 |         3.02 |       0.44 |       1.95 |         2.16 |       0.48 |      3.60 |        0.41 |      0.27 |
| bp-nofloor |  6000 |       4.99 |         2.90 |       0.45 |       2.65 |         1.93 |       0.50 |      4.40 |        0.44 |      0.29 |
| bp-floor   |  2000 |       4.85 |         1.55 |       0.53 |       4.26 |         2.08 |       0.57 |      6.26 |        0.29 |      0.41 |
| bp-floor   |  6000 |       6.67 |         1.02 |       0.49 |       5.74 |         0.94 |       0.67 |      8.59 |        0.22 |      0.40 |

p3-mid

| arm        | point | small food | small poison | small surv | held2 food | held2 poison | held2 surv | long food | long poison | long surv |
|------------|------:|-----------:|-------------:|-----------:|-----------:|-------------:|-----------:|----------:|------------:|----------:|
| untrained  |     0 |       0.35 |         0.09 |       0.77 |       0.67 |         0.41 |       0.93 |      1.05 |        0.01 |      0.51 |
| es         |   300 |      12.58 |         4.01 |       0.53 |       8.53 |         3.40 |       0.45 |     13.42 |        0.80 |      0.63 |
| es         |   900 |      13.63 |         5.03 |       0.51 |       9.31 |         4.08 |       0.43 |     15.97 |        1.00 |      0.83 |
| bp-nofloor |  2000 |      14.55 |         2.94 |       0.65 |       9.56 |         2.37 |       0.66 |     15.77 |        0.33 |      0.83 |
| bp-nofloor |  6000 |      13.79 |         2.23 |       0.64 |       9.48 |         1.47 |       0.69 |     14.89 |        0.29 |      0.73 |
| bp-floor   |  2000 |      16.49 |         1.26 |       0.74 |      12.09 |         0.36 |       0.92 |     18.02 |        0.07 |      0.97 |
| bp-floor   |  6000 |      15.80 |         1.23 |       0.73 |      11.60 |         0.58 |       0.89 |     18.20 |        0.07 |      0.91 |

p6-big-brain

| arm        | point | small food | small poison | small surv | held2 food | held2 poison | held2 surv | long food | long poison | long surv |
|------------|------:|-----------:|-------------:|-----------:|-----------:|-------------:|-----------:|----------:|------------:|----------:|
| untrained  |     0 |       0.05 |         0.07 |       0.68 |       0.03 |         0.00 |       1.00 |      0.07 |        0.00 |      0.45 |
| es         |   300 |      14.62 |         4.73 |       0.52 |       9.69 |         3.38 |       0.45 |     17.94 |        0.78 |      0.78 |
| es         |   900 |      13.14 |         5.33 |       0.49 |       9.85 |         4.21 |       0.41 |     16.40 |        0.95 |      0.71 |
| bp-nofloor |  2000 |      14.72 |         2.05 |       0.67 |       9.53 |         1.74 |       0.66 |     14.39 |        0.27 |      0.70 |
| bp-nofloor |  6000 |      11.71 |         2.57 |       0.63 |       8.81 |         2.21 |       0.58 |     13.05 |        0.45 |      0.75 |
| bp-floor   |  2000 |      17.37 |         1.67 |       0.71 |      13.81 |         0.59 |       0.87 |     21.11 |        0.10 |      0.93 |
| bp-floor   |  6000 |      16.13 |         1.90 |       0.66 |      12.30 |         1.36 |       0.79 |     20.66 |        0.17 |      0.92 |

Log-std (turn, thrust), from `runs/l1/*.trace.jsonl`:

| arm / design     | 250         | 1000        | 2000        | 6000        |
|------------------|-------------|-------------|-------------|-------------|
| nofloor p1       | -1.14 -1.29 | -2.99 -2.98 | -2.99 -2.97 | -3.00 -2.99 |
| nofloor p3       | -1.73 -1.73 | -2.98 -2.89 | -2.99 -2.99 | -3.00 -3.00 |
| nofloor p6       | -1.59 -1.42 | -2.81 -2.70 | -2.96 -2.96 | -3.00 -2.98 |
| floor (all three)| -1.00 ..    | -1.00 ..    | -1.00 ..    | -1.00 ..    |

## Reading

- Without the floor, log-std hits the -3 clamp by update 1000 on all three designs and stays there. Held-out competence stops rising after 2000 updates: p3 and p6 held2 survival, long survival and food are flat or slightly lower at 6000 (p6 small food 14.7 to 11.7, held2 poison 1.74 to 2.21), p1 creeps up slightly. This is a plateau with a mild decline, not a collapse, and not yet "noise" in 6000 updates. Erik's wall appears later or in a harder setting (50k not tested).
- With the floor (-1) the std stays at the floor. It is better than no floor at 2000 and at 6000 on every design (held2 survival p3 0.92 vs 0.66, p6 0.87 vs 0.66, long food +2 to +7, stings down by about half or more). But it does not keep rising either: from 2000 to 6000 p3 and p6 are flat to slightly lower (p6 held2 poison 0.59 to 1.36, held2 survival 0.87 to 0.79), only p1 (tiny brain) keeps improving (held2 food 4.3 to 5.7, poison 2.1 to 0.9). The floor lifts the level, it does not remove the plateau within 6000 updates.
- ES (recipe): 300 to 900 s changes little (small food +0.2 to -1.5, poison up on p3 and p6, held2 survival 0.43 to 0.45 flat). ES stings far more than backprop (small poison 3.5 to 5.3 vs 1.0 to 2.9) and has the lowest held2 survival. Backprop with the floor is the best arm on every design and scope at 2000 and 6000, except p1 long.
- Caveat: one training seed, three designs, the p3 second seed was not run. Single-seed food moves by about 4 per design (E1), so differences under that are noise: the floor effect on held2 survival and stings (large, same sign on 3 of 3) is outside it, the 2000 to 6000 changes mostly are not.

## Not done

18k and 50k updates, 2700 s and 8100 s ES, p3 second seed. Backprop at about 0.5 (p1), 0.7 (p3) and 1.0 (p6) seconds per update means 18k is roughly 2.5, 3.5 and 5 hours per arm and 50k about 3x that, under the lock with other sessions waiting. Ready to continue: `src/typescript/runs/drive.sh 3` then `4`, `runs/score.sh` (git-ignored; they resume from the saved states, rerun until the stage log line appears).

## Tools and log

- `rlGrad.ts` and `rlTrain.ts`: opt-in `--state FILE` (save and resume), `--ckpt N,N --ckpt-dir DIR`, rlGrad `--trace FILE`, rlTrain `--chunk SECONDS`. Defaults unchanged. rlTrain checkpoints are in CPU seconds divided by threads.
- Resume test `tests/typescript/rlResume.test.ts`: PPO and ES, stop, save through JSON, load, carry on, equals the uninterrupted run bit for bit. Fails (both) when the rng state is not restored, checked.
- Tables: `probes/l1-tables.py`. Raw outputs in git-ignored `src/typescript/runs/l1/`.
- 2026-11-04. rl, ppo, arena tests pass (184), rlBench fingerprint 1301207144.
