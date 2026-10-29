# Scout of the perf-live head (study, nothing built)

Branch `pl-scout-head` from `perf-live` 253f894 (ideas 85-99 and 106 merged). All runs `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, one process at a time, 3 GB or more available, load 6-7 (the campaign baseline ran at load 10-12, so ratios below flatter the head by some 10%). Fingerprints equal the baseline: 708687555 (mixed, 60 s) and 10334191 (cap), so everything merged is exact.

## Phase table (liveBench --seconds 60 --profile, ms per steady tick)

| Phase                  | Baseline mixed | Head mixed | Ratio | Baseline cap | Head cap | Ratio |
|------------------------|---------------:|-----------:|------:|-------------:|---------:|------:|
| senser                 | 5.74           | 3.877      | 0.68  | 7.54         | 4.732    | 0.63  |
| brain forward          | 5.23           | 3.901      | 0.75  | 5.17         | 3.771    | 0.73  |
| memory and steer       | 1.26           | 0.939      | 0.75  | 1.59         | 1.111    | 0.70  |
| eat                    | 1.05           | 0.857      | 0.82  | 1.35         | 1.072    | 0.79  |
| slots (prepareRows)    | 1.04           | 0.302      | 0.29  | 1.52         | 0.402    | 0.26  |
| crowd grid             | 0.51           | 0.143      | 0.28  | 0.67         | 0.283    | 0.42  |
| collisions             | 0.18           | 0.171      | 0.95  | 0.27         | 0.246    | 0.91  |
| settle, births, regrow | under 0.2      | 0.189      |       |              | 0.311    |       |
| total (cpuMsPerTick)   | 15.24          | 10.42      | 0.68  | 18.50        | 11.98    | 0.65  |

Peak RSS 215 / 255 MB. Senser and brain forward are 75% (mixed) and 71% (cap) of the tick.
Phase names hide the kernels: "eat" holds the sharedPhase grid rebuild, touch and the eat JS, "memory and steer" is the step kernel, "slots" is prepare.

## Kernel parts (kernelTimers.ts --copies 800 --ticks 400 and --only juggernaut --copies 4900, fixed population, ms per tick)

Baseline column is the mixed table of `scout-open.md` (idea 84, before ideas 85-99 and 106). Timers add about 1 us per call.

| Part                              | Base mixed | Head mixed | Head cap | Calls per tick (mixed / cap) |
|-----------------------------------|-----------:|-----------:|---------:|------------------------------|
| sense kernel                      | 4.27       | 3.30       | 4.54     | 1 / 1                        |
| senser.run wrapper (all below it) |            | 4.16       | 5.76     | 1 / 1                        |
| of it fill kernel                 | 0.50       | 0.275      | 0.395    |                              |
| of it syncItems (patchCell)       | 0.34 (0.235) | 0.272 (0.193) | 0.371 (0.272) | 58 / 79 patches |
| of it pack                        | 0.26       | 0.244      | 0.392    |                              |
| brain forward kernel              | 4.51       | 3.63       | 3.92     | 1 / 1 (forwardRun JS 0.08 / 0.08) |
| step kernel                       | 1.22       | 0.86       | 1.17     |                              |
| prepare                           | 0.31       | 0.274      | 0.445    |                              |
| crowd rebuild                     | 0.65       | 0.442      | 0.690    | 1.30 / 1.36                  |
| crowd refresh                     | 0.09       | 0.063      | 0.103    | 0.70 / 0.67                  |
| crowd sweep (collisions)          | 0.18       | 0.153      | 0.210    | 2.8 / 17                     |
| touch                             | 0.49       | 0.405      | 0.583    | 1 / 1                        |
| eat JS (43 / 64 calls)            | 0.27       | 0.243      | 0.330    | 5.7 / 5.1 us each            |
| giveBirth, birthCandidates        | 0.14       | 0.099, 0.058 | 0.112, 0.087 | 0.43 / 0.57 births  |
| regrow, settle                    | 0.09, 0.08 | 0.080, 0.069 | 0.122, 0.086 |                           |
| JS rest (tick minus the rows above) |          | 0.33       | 0.26     |                              |
| cpuMsPerTick of that run          | 13.7-14.3  | 11.09      | 14.11    |                              |

## cpu-prof (--cpu-prof-interval 250, build and the first quarter dropped)

Mixed: wasm 94.3% of samples, JS and other 5.7%, GC 0.11%. The wasm shares (functions unnamed, mapped by module): sense 32%, brain 30%, step 8%, crowd about 11%, fill and prepare about 8%. JS by file: senser.ts 1.58% (patchCell 1.4%), ecosystem.ts 0.85% (sharedPhase 0.6%), brainKernel.ts 0.59% (forwardRun 0.6%), world.ts 0.51%, crowdKernel.ts 0.32%.
Cap: wasm 93.4%, JS and other 6.6%, GC 0.46%, patchCell 1.0%, forwardRun 0.9%, sharedPhase 0.6%. (The cap window was cut by wall time, so wasm shares there are rough.)
No JS function except `patchCell` and `forwardRun` is above 0.15 ms per tick.

## New measurements

- Rock stage of the sense kernel (`S_ROCK_COLS` forced to 0, timing only, 3 pairs): sense kernel 3.397 / 3.369 / 3.123 with rock, 2.940 / 2.888 / 3.022 without, so 0.46, 0.48, 0.10 ms (median 0.46, 14% of the kernel). Counting at tick 300 on the live world (5197 discs, largest radius 339, ray length 170, rock cell 300): 358 of 3366 creatures (10.6%) pass the lower-bound table and walk, each over 19 grid cells and 22 discs of which 2.3 are kept, and 154 of them keep a disc. The walk window is the ray length plus the largest radius in the world, 509 units, about 4.4 x 4.4 cells.
- Test of the obvious cut: discs stored in grid order so a cell run reads one stretch and the `rockOrder` indirection goes (7 lines, exact, patch in the session scratchpad `rock-cellorder.patch`). 10 alternating pairs, sense kernel median 3.299 base against 3.279 (-0.02 ms, inside the spread of 0.4 ms). Rejected. The cost is not the disc loads. The 154 creatures with a rock disc in reach take the busy path instead of the early-out (about 3 us each, same order as 0.46 ms), which is the ordinary candidate and ray cost, already cut by ideas 36, 88 and 93.

## Verdict on the exact pool

Every row above is within 0.05 ms of the floors recorded in `stepparts.md`, `rebuildparts.md`, `fillcut.md`, `codegen.md`, `emitbytes.md`, `collide3.md`, `cellgather.md` and `pagepack.md`. I re-read those notes and found no measurement that looks wrong. The brain kernel (3.63 ms) and the sense kernel (3.30 ms) are 67% of the tick and both are instruction and first-touch bound (`scout-brain.md`, `scout-ray.md`).
The pool of single exact ideas worth 1.5% or more is dry. What is left, with the numbers at 3300 mixed:

| # | Idea | Evidence now | Expected ms | Lines | Status |
|---|------|--------------|------------:|------:|--------|
| 1 | Merge the two parked branches as one small-wins bundle: `pl-itemsync` (idea 100, one `patchItems` kernel call per dirty cell set) and `pl-exp2` (idea 109, two-lane fdlibm exp in pack) | syncItems 0.272 (cap 0.371), patchCell 0.193 (cap 0.272), pack 0.244 (cap 0.392) | -0.08 and -0.03, together about -0.11 (1.0%), cap about -0.16 | +150/-28 and +207, both already built and exact | Rebase on 253f894, rerun the paired bench. Needs the probe guard review for exp2 |
| 2 | Move `forwardRun`'s stamp-and-walk into the `forward` export | forwardRun JS 0.08 ms (cpu-prof 0.6% mixed, 0.9% cap) | -0.03 to -0.06 (cap -0.06 to -0.12) | about 30 (JS 15, wat 15) | Not built. `scout-js.md` estimated half of it, reached only without the spare pool in `order` |
| 3 | Quad lanes in `brain.wat` (four same-shape brains per v128, bank groups brains by shape) | brain kernel 3.63 ms, 35% of the tick, instruction part about 2.3 ms of it | 0 to -0.5, the prototype cut 0.4-0.6 ms hot and lost it cold | about 400 generated wat plus a bank that groups brains | Only if the native kernel (`nativeprod.md`, about 1.9 ms) stays parked. Risky, not recommended before a cold-run prototype with the touch stream |

Bundle of 1 and 2: about 0.15 to 0.17 ms (1.5% at 3300, 1.7% at the cap) for about 390 lines. That is the whole exact pool I can show.

The larger levers are not engineering any more: native brain kernel (1.03-1.05x, `nativeprod.md`), helper threads on a host with spare cores, `dt` 1/20 (1.5x, ready on `pl-dtswitch`), huge pages (about 1%, root).
