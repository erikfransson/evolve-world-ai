# Skip the touch walk for creatures out of reach (idea 35)

Exact, skips 98.5% of the walks, but only 0.1% faster mixed and 1.4% at the cap: the sense kernel pays about 0.23 ms for the clearance it hands over. Branch `pl-touchskip`, measured on `perf-live` 3d33e82, rebased onto 057a96c.

## What

- `sense.wat` item gather: a running least squared distance over every item of the window cells, taken before the distance and wedge culls (`select` on `f64.lt`, so a NaN item is ignored, as the touch never finds one either).
  After the gather it writes a 32-byte clearance record at the member index: the sense position x, y, `m = min(sqrt(least d2), far - 1)` (-1 when the window has no cells) and a stamp.
- `crowd.wat` touch: for each creature, skip the walk (answer -1) when the record has the current stamp and `m - |p_touch - p_sense| > reach + 1e-6`. NaN anywhere fails the test and walks.
- `WasmCrowd.unsensed(n)`, called from `Ecosystem.senseRows`, sizes the records and bumps the stamp; the senser takes the address once. `sharedPhase` passes `skip` only when the last `senseRows` ran this tick with the same `table.version`.

## Why it is exact

- Displacement: the bound is the creature's actual move between the two positions the kernels read (the sense record and the shared-phase grid), not a model of the step. So thrust, drag, terminal speed, walls, the rock `keepOut` push, an RL `act`, anything between sense and touch is covered, with no speed assumption.
- Window: the gather walks the cells of `[x - far, x + far]` (far = ray length + item radius), clamped like the item cells, so every item nearer than `far` lies in them. The record caps m at `far - 1`; the 1 covers the f32 item positions and the cell key rounding. An empty window (an extreme or infinite position) writes -1.
- Triangle inequality: an item touchable after the move has `|item - p_touch| < reach`, so `|item - p_sense| < reach + |move| < m`, which contradicts m being the least distance (or below far). The 1e-6 margin covers f64 rounding at world coordinates up to 1e5.
- Items: the touch runs on `itemTables`, which is null (JS walk, no skip) when any item changed since the sense synced the packed rows. Eating, regrowth and births all happen after the touch batch in `sharedPhase`, and inserts or restores happen between ticks, so on the main path the items the touch sees are those the sense gathered.
- Who skips: only creatures the sense wrote this tick. Non-thinkers at `thinkEvery` above 1, rays 0 (the gather is skipped) and members added since keep an old stamp. A table change between sense and touch (version) or a touch without this tick's sense turns the skip off. The helper-thread path computes `touched` in `advanceBodies` with `touchedBatch` and never calls the kernel touch.

## Numbers (liveBench `--profile`, 60 s, pinned to CPUs 2,3,6,7, nice 19, 3 alternating pairs, load 16-22)

Skipped: 98.5% of creature-ticks mixed and 98.6% at the cap (30 s runs, JS replica of the test, not committed).

| Case  | Build | cpuMsPerTick                      | eat ms              | senser ms           | peak RSS MB   | fingerprint |
|-------|-------|-----------------------------------|---------------------|---------------------|---------------|-------------|
| mixed | base  | 14.270, 14.172, 14.410 (med 14.270) | 1.161, 1.146, 1.191 | 5.645, 5.651, 5.676 | 216, 216, 215 | 708687555   |
| mixed | yours | 14.285, 14.261, 14.262 (med 14.262) | 0.853, 0.854, 0.865 | 5.923, 5.878, 5.874 | 217, 216, 217 | 708687555   |
| cap   | base  | 17.449, 17.466, 17.572 (med 17.466) | 1.574, 1.573, 1.586 | 7.140, 7.137, 7.192 | 246, 252, 256 | 10334191    |
| cap   | yours | 17.332, 17.227, 17.209 (med 17.227) | 1.199, 1.181, 1.165 | 7.383, 7.368, 7.373 | 253, 257, 255 | 10334191    |

Ratio of medians 0.999 (mixed) and 0.986 (cap). Eat drops 0.31 / 0.39 ms, the senser rises 0.23 / 0.23 ms, the rest is flat.
Earlier pair sets were void: `perf-live` merged ideas 34 and 44 (prepareRows) while they ran, which showed as a 0.3-0.8 ms "slots" gap.

## Variants tried

| Variant                                                       | senser change | Note                                                      |
|---------------------------------------------------------------|---------------|-----------------------------------------------------------|
| `f64.min` per item in the gather                              | +0.29 / +0.29 | wasm min's NaN and -0 handling                            |
| `select` on `f64.lt` per item (kept)                          | +0.23 / +0.23 | about one cycle per gathered item                         |
| separate walk of a 1.5 x reach window after the gather        | +0.35 (1 run) | as dear as the touch walk itself: the walk cost is items, not cache misses |
| JS fill of the records each tick instead of a stamp           | none          | replaced by the stamp to drop an O(n) loop                |

## Tests

New `wasmCrowd.test.ts` cases: 300 ticks each on the Inland Sea with 1500 founders (rock), a crowded 2500 x 1800 plain world, the predator world and the Inland Sea at `thinkEvery` 2, every kernel touch also run without the skip and compared; and the scatter test (positions outside the world, NaN, infinite) now also compares the skip.
With `moveScale` 0 (the move left out of the bound) the comparison goes red on the Inland Sea and the crowded world.
Focused files (wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep) after the rebase: 125 passed, exit 0; tsc clean; thinkEvery pin 81047108 holds, 60 s fingerprints 708687555 and 10334191 on the rebased branch. Full suite not run (bar not met).

## Verdict

Reject as is: exact and general, but 0.1% / 1.4% for about 130 lines, under the 2% bar. The touch walk is nearly free to skip; gathering the clearance is not.
A cheaper record (the least distance only over the window rows within reach + a few units of y, which needs a second copy of the inner loop) might halve the senser cost, for perhaps 1.5% at the cap.
