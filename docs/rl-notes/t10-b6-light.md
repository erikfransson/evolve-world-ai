# T10 B6: Light tier, less overhead and more learning

Question: at the browser's real PPO budget (1.3 CPU-s per tier second, B5) Light gets about 83 updates and only 4.6 bigger-scope food. Can it spend less on overhead?

## Which levers are data and which need code

| lever                          | where it lives                                                         | kind                                      |
|--------------------------------|------------------------------------------------------------------------|-------------------------------------------|
| episodes per update (8 or 16)  | `TrainPhase.backprop.episodes` (worker clamps 4 to 320)                | data                                      |
| learning rate                  | `TrainPhase.backprop.lr` (worker clamps 0.0005 to 0.01)                | data                                      |
| episode cap (20 s, 30 s)       | `TrainPhase.seconds`, applied to the training and held-out envs        | data                                      |
| held seeds per check           | `Start.held` exists, but `live/training.ts` sends none (4)             | code: forward `held` from the phase       |
| check interval                 | `HELD_EVERY = 5` constant in `worker/arenaRun.ts`                      | code: `Start` field and `training.ts`     |
| checks only in the last third  | not expressible                                                        | code: same field plus a start-after rule  |
| dropping the initial check     | `ArenaRun.run` always scores the start brain before `ready`            | moot, see below                           |

The initial check is free in Live: the clock starts when the worker sends `ready` (`begin()` in `training.ts`), after the start brain is scored. The B5 probe charged it to the budget. `rlTiers.ts --clock-at-ready` now starts the clock at `ready`. On the same seeds it changes nothing visible (Light ppo-hi, seeds 1 and 2: median paired difference 0.00, at most 3 of 10 bodies differ on any cell), so B5's rows stay valid.

## Probe changes (`src/rlTiers.ts`)

- `--clock-at-ready`, as above.
- `runLoop`, a copy of `ArenaRun`'s loop with a check interval (`every`) and a late-only window (`late`), for the code levers. `held` goes through `Start.held` as in B5.
- Protocols: data `hi-e8`, `hi-c20`, `hi-c15`, `hi-c10`; code `hi-k10` (check every 10), `hi-h2` (2 held seeds), `hi-late` (checks in the last third only), `hi-e8-k10`, `hi-c20-k10`. `ppo-hi` is the former Light recipe. `hi-e8-lr7` (lr 0.007) was dropped unrun, see the load note.

## Load note (changes how to read every row)

The budget is CPU seconds of the probe process, and the work per CPU second depends on the machine load. The same `ppo-hi` Light run gave a median of 81 updates on seeds 1 and 2 (heavy load from other sessions) and 123 to 133 on seeds 3 to 10. Rows from different times are therefore not comparable in updates. From seed 5 on, base and candidate ran side by side in one lock hold (`runs/b6/qpair.sh`, same load, same seed). Seeds 1 and 2 are a screen only.

## Screen: seeds 1 and 2, Light, 10 bodies, 64-seed battery

Median over bodies of the seed mean; differences against `ppo-hi` are medians of paired body differences, (up/down) = bodies with the pooled 95% CI above/below 0. Updates = median per run.

| protocol   | updates | bigger food / surv | d bigger food | d held2 surv | d held2 poison | d long surv |
|------------|--------:|-------------------:|--------------:|-------------:|---------------:|------------:|
| ppo-hi     |      81 | 5.11 / 0.74        | -             | -            | -              | -           |
| hi-e8      |     133 | 6.73 / 0.73        | +0.36 (4/3)   | +0.00 (3/3)  | +0.11 (3/4)    | -0.04 (2/3) |
| hi-c20     |     113 | 6.83 / 0.72        | +1.39 (7/3)   | +0.01 (2/4)  | -0.07 (3/2)    | +0.02 (5/4) |
| hi-c15     |     156 | 5.28 / 0.79        | +0.63 (5/2)   | +0.05 (4/4)  | -0.26 (4/5)    | -0.04 (2/4) |
| hi-c10     |     227 | 6.29 / 0.68        | +0.48 (5/3)   | -0.05 (4/5)  | +0.06 (4/3)    | -0.04 (4/5) |
| hi-k10 *   |      90 | 5.70 / 0.71        | +0.05 (3/1)   | -0.05 (3/5)  | +0.59 (5/3)    | +0.00 (3/2) |
| hi-h2 *    |      89 | 5.63 / 0.73        | +0.45 (5/1)   | -0.02 (0/3)  | +0.17 (2/1)    | +0.00 (2/1) |
| hi-late *  |      95 | 5.70 / 0.71        | +0.28 (4/2)   | -0.07 (4/6)  | +0.69 (5/3)    | -0.02 (1/1) |
| hi-e8-k10 *|     162 | 5.09 / 0.72        | +0.24 (4/3)   | -0.01 (4/1)  | +0.28 (1/2)    | -0.02 (1/3) |

\* needs code changes in Live and the worker.

- Cap 20 is the only lever with food up on most bodies (7/3) and survival and poison not worse. Caps 15 and 10 trade survival and poison back and forth with no food gain.
- 8 episodes per update gives more, noisier updates and does not help (4/3). Check overhead per update doubles, so it only works with a longer interval (hi-e8-k10, no gain).
- The code levers buy at most 10 to 20% more updates (checks cost about 40% of the episodes at 16 per update and interval 5, but the update count rises only to 90 to 95) and cost survival or poison: fewer or later checks pick worse checkpoints.

## Paired runs, `hi-c20` against `ppo-hi`

Seeds 5 to 8 (4 pairs), then 9 and 10; pooled over seeds 1 to 10 (seeds 1 to 4 unpaired).

| seeds        | updates base / c20 | bigger food base / c20 | d bigger food | d held2 surv | d held2 poison | d long surv |
|--------------|-------------------:|-----------------------:|--------------:|-------------:|---------------:|------------:|
| 5 to 8       | 117 / 139          | 4.51 / 6.14            | +0.93 (7/1)   | -0.04 (0/3)  | +0.15 (2/0)    | +0.02 (4/3) |
| 9 and 10     | 123 / 148          | 6.57 / 5.79            | +0.05 (3/4)   | -0.02 (3/3)  | +0.20 (2/3)    | -0.03 (1/3) |
| 1 to 10 pool | 106 / 136          | 5.11 / 6.24            | +0.72 (6/1)   | -0.01 (1/3)  | -0.02 (3/1)    | -0.00 (2/4) |

Other pooled paired medians (1 to 10): held2 food +0.77 (6/1), long food +0.81 (5/1), bigger surv -0.01 (2/5), bigger poison 0.00 (3/2). Per-seed agreement is low (the all-seeds-agree column is 0 or 1 of 10 bodies). The gain is clear when updates are scarce (seeds 1 and 2: +1.39) and gone on seeds 9 and 10, where the baseline itself reached 6.6, so cap 20 helps in proportion to how starved the browser run is.

## Code levers on top of cap 20 (paired, seeds 9 and 10)

| candidate vs hi-c20 | updates   | d bigger food | d held2 surv | d held2 poison |
|---------------------|----------:|--------------:|-------------:|---------------:|
| hi-c20-k10 *        | 148 / 165 | -0.01 (4/3)   | -0.07 (0/6)  | +0.60 (6/0)    |
| hi-k10 * vs ppo-hi  | 123 / 143 | +0.25 (3/4)   | -0.06 (2/5)  | +0.22 (4/1)    |

Checking every 10 updates gives 12 to 16% more updates and loses survival and gains poison on both recipes. No code lever is worth building.

## Live check (`probes/b1-live.ts`)

Server `LiveWorld`, 4 worlds, 2 inserted copies per body and set, seeds 5 to 8 of each recipe (32 per body), 240 s, median over the 10 bodies.

| set                    | lifespan (s) | children | died |
|------------------------|-------------:|---------:|-----:|
| untrained              |        134.2 |     0.00 | 0.95 |
| ppo-hi (30 s cap)      |        180.6 |     1.19 | 0.64 |
| hi-c20 (shipped here)  |        194.9 |     1.28 | 0.61 |

Neutral to slightly better: lifespan +14 s, children and deaths within noise (per world, children go up in 2 of 4 worlds).

## Verdict

- Data-only change made: Light `seconds: 30` becomes `20` (`trainTiers.ts`; `liveTiers.test.ts` cap and env-length asserts updated, changes noted). Light bigger-scope food rises about 20% at no survival or poison cost, the Live check is neutral or better, and it costs nothing. The gain is modest and depends on how few updates the browser gets, so Erik can revert it with one number.
- Episodes 8 per update, lr, caps 15 and 10: no gain. Medium and Strong unchanged.
- Code levers (check interval, 2 held seeds, late-only checks) do not pay: more updates, worse checkpoints. Dropping the initial check does nothing in Live. If wanted anyway: `HELD_EVERY` becomes a `Start` field, `training.ts` forwards a phase's `heldEvery` and `held`, and the keep-best rule in `training.ts` stays as is.
- Probe lesson for later tiers: pair base and candidate in one lock hold, since CPU-second budgets move by 1.6 times with machine load.

Runs and scripts: `runs/b6/` (untracked). Analysis `probes/b1-analyze.py` with `B1_BASE=ppo-hi`.
