# Fuse the tick-start passes (idea 50)

Rejected: exact, but the fused build is 0.6-0.8% slower per tick, and the bound on what refresh plus pack could ever gain is 0.1-0.15%. Branch `pl-fuse` from `perf-live` 3d33e82; the experiment code is not committed (6 files, about 70 lines of real change; it was reverted).

## What each pass costs

Scratch timers (thread CPU time around each wasm export, 60 s runs, not committed), ms per tick averaged over the whole run, taskset 2,3,6,7 nice 19:

| Pass                       | mixed (3300) | cap (4900) | Note                                            |
|----------------------------|--------------|------------|-------------------------------------------------|
| crowd `refresh`            | 0.014        | 0.025      | 1451 / 1120 of 1800 ticks call it (0.018 / 0.04 per call), 18 / 63 abort |
| crowd `pack`               | 0.097        | 0.177      | dominated by the imported `Math.exp` per creature (about 30 ns each) |
| fill `prepare`             | 0.081        | 0.145      | the ground lookup is most of it                 |
| fill `fill`                | 0.409        | 0.644      | two passes over the rows                        |

All four are far below the expected 0.05-0.15 ms each except fill; the work in them is arithmetic and the imported exp, not the second walk over the same arrays.

## Bound for refresh plus pack

Fusing removes at most the refresh's own pass: 0.014 ms (0.1% of the 14.4 ms tick) and 0.025 ms (0.15% of 17.5). Pack's exp calls, its stores and the row store stay.
It would also need pack's output buffers and the start energy at `prepareTick`, a flag so `senser.run` skips its own pack, and a stale-flag guard when `run` does not happen. Exactness would hold (a refresh that aborts leaves partial f32 columns and signals that the later rebuild plus pack rewrite from the same energies), but 0.1% is not worth that plumbing. Not built.

## Prepare into fill (built, measured)

`prepare` became a per-row function `$prepareRow` that `fill` calls for each row in its first loop when a new call-block field `F_PREP` points at the staged prepare block (`WasmFiller.stagePrepare`, used by `senseThinkRows` when `every <= 1` and the crowd packs its signal; `thinkEvery > 1` keeps the separate prepare, since fill then sees only the thinking subset and every row needs its ground factor). Order holds: pack writes extra 0, prepare extras 1-4 and the ground factor, fill copies the extras after; the step reads the ground factor later. Placing the call in fill's second loop (hot row lines) gave the same scratch numbers.

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, alternating pairs, load about 12)

| Case  | Build | cpuMsPerTick                        | crowd grid ms       | slots ms            | senser ms           | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|---------------------|---------------------|---------------------|---------------|-------------|
| mixed | base  | 14.147, 14.130, 14.088 (med 14.130) | 0.222, 0.216, 0.212 | 0.368, 0.362, 0.365 | 5.398, 5.401, 5.387 | 213, 215, 217 | 708687555   |
| mixed | yours | 14.245, 14.249, 14.557 (med 14.249) | 0.209, 0.213, 0.216 | 0.012, 0.012, 0.011 | 5.994, 5.989, 6.099 | 218, 213, 217 | 708687555   |
| cap   | base  | 16.772, 17.092, 17.244 (med 17.092) | 0.485, 0.489, 0.506 | 0.499, 0.509, 0.516 | 6.700, 6.831, 6.867 | 256, 254, 254 | 10334191    |
| cap   | yours | 17.053, 17.384, 17.198 (med 17.198) | 0.479, 0.509, 0.479 | 0.013, 0.013, 0.012 | 7.507, 7.607, 7.535 | 257, 254, 254 | 10334191    |

Ratio of medians 1.008 (mixed) and 1.006 (cap), slower in most pairs. Slots plus senser grow by 0.24 ms (mixed) and 0.22 ms (cap): the separate prepare cost about 0.37 / 0.50 ms in the slots lap and the fused fill costs 0.60 / 0.72 more. Fingerprints equal (708687555, 10334191), peak RSS flat.

## Why it does not pay

The first pass over the rows pays the cache misses, wherever it sits; the second walk is cheap because the lines are warm. Merging the passes cannot save that, and it enlarges the fill loop (the prepare body, with its two ground blends, is inlined or called per row), which got slower by more than the separate call cost. I did not isolate the exact cause (not verified: code layout, register pressure or tiering).

## Tests (on the experimental code, before the revert)

`npm run wasm`, then `npx vitest run wasmCrowd wasmKernels residentBodies wasmStep thinkEvery ecoPool --testTimeout=180000 --maxWorkers=1`: 6 files, 120 tests passed, exit 0 (kernel drift and the thinkEvery pin included).

## Verdict

Reject. Fusing refresh and pack is bounded at 0.1-0.15% and not built; fusing prepare into fill is exact but 0.6-0.8% slower. Together with ideas 33, 34 and 44 this closes the tick-start passes: what remains in them is arithmetic and the exp import, not repeated walks.
