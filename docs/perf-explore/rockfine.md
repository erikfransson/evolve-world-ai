# Finer rock lower-bound table (idea 67)

Question: after idea 8's coarse table (300-unit cells), how many creatures still walk the rock grid, and does a second table at the item-cell size (100 units, one byte per cell holding floor(lb/2), capped at 255) pay? Branch `pl-rockfine`. Exact by construction (finer cell gives a bound at least as large, rounding is down, NaN or out-of-grid positions walk).

## Count (snapshot harness of senselive.md, rebuilt on this branch, 3331 and 3294 creatures)

| Count                                      | t400 | t1500 |
|--------------------------------------------|-----:|------:|
| Creatures still walking the rock grid      | 377 (11.3%) | 375 (11.4%) |
| of those keeping at least one disc         | 149  | 152   |
| Walks left with the fine table             | 237  | 230   |

Residual cost of the rock stage after idea 8 (cold, p25, whole kernel, 120 reps interleaved): `full` 4.48 / 3.77 ms, rock off (`S_ROCK_COLS` 0) 3.87 / 3.26, walk forced off 3.87 / 3.23. So the residual is 0.6 ms (t400) and 0.5 ms (t1500), well over the 0.1 ms stop line. The fine table removes 140 of the 377 walks, so at most about 0.2 ms was in reach.

## Implementation tried

`rockLowerBoundFine` (3 x 3 fine cells per coarse cell, `ROCK_FINE = 3`, derived from `ROCK_CELL`, 158 KB on The Inland Sea), pointer and grid size in four new `S_` fields, kernel checks the coarse bound, then the fine byte, then walks. Built on first use per Terrain with the other rock tables. Inputs of all creatures hash equal after NaN poisoning against the idea-8 kernel (b101b365 at t400, 50357cc0 at t1500, as in sensecuts.md), with the fine test on and off. `wasmKernels` has a new test (twice the byte never above the true edge distance, never looser than the coarse bound by more than the rounding, at cell sizes 300 and 120).

## Kernel timing (cold, 120 reps, variants rotated, `--no-liftoff`, load 18-20; ms per call)

| Snapshot | base | base (repeat) | fine on | fine table off, new code |
|----------|------|---------------|---------|--------------------------|
| t400     | 4.76 p25 | 4.74 | 4.88 | 4.88 |
| t1500    | 4.07 p25 | 4.05 | 4.14 | 4.18 |

The new kernel is 0.08-0.12 ms slower, and equally slow with the fine test switched off, so the loss is code generation (one more live local and branch in a register-bound function), not the table. The 140 saved walks are worth less than that (the first fine-first ordering, one extra cold byte load for every creature, was +0.2 ms). liveBench pairs were not run: the kernel harness shows no gain to carry up.

## Verdict suggestion

Reject, do not merge. The rock stage after idea 8 costs 0.5-0.6 ms, but 40% of its walks removed by the fine table do not repay the added kernel code. Remaining rock cost is the 149 creatures that really have a disc in reach plus the walks around them.
