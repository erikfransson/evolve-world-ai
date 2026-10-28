# Brain kernel: 16-wide zero skip in `$compact` (idea 99)

Exact. Branch `pl-compact16` from `perf-live` (538804e, includes idea 92). Verdict suggestion: merge as a small win (kernel -2%, mixed tick -1%), or park if the bar is 1.5% of the tick.

## What
`$compact` first tests 16 inputs at a time: four `f32x4.ne` against zero, two `i16x8.narrow`, one `i8x16.narrow`, `i8x16.bitmask` gives a 16-bit mask. Mask zero: only `idx += 16`. Otherwise four nibble steps with the same swizzle table and count table as before (no recomputed lane masks). The old 4-wide loop and partial tail then run on what is left. Predicate stays `f32 != 0` (-0 out, NaN kept), list byte-identical. 36 lines changed in `brain.wat`, plus the test widened (`nIn` 1 to 70, -0 inputs, sparse slots so whole 16-groups are zero).

## Kernel microbench
Real brain run of the live mix (3318 brains, tick 600), same memory in each instance, user CPU, median of 61-101 reps, interleaved, memory hash equal in all variants, load 7-25 (scratchpad `compact16/kab.ts`).

| Variant | cold | hot |
|---|---|---|
| 16-wide, nibbles from the 16-bit mask (built) | 1.014-1.027x | 1.017-1.023x |
| 8-wide skip | 1.015-1.028x | 1.012-1.026x |
| 16-wide `any_true`, masks recomputed per 4 | 1.006-1.022x | 1.014-1.020x |
| 16-wide, no branch (always 4 steps) | 0.996x | 1.007x (one run) |

Cost of the whole compaction (second call, hot): base 0.37-0.42 ms of 4.3, with the 16-wide skip 0.27-0.31 ms. So the pass is about 9% of the kernel in the microbench (nzlist.md measured 5%; brain.md's 17-21% includes first touch of the input), and the skip removes about a quarter of it. Variants differ by less than the spread; 16-wide and 8-wide are equal. The rest of the cost is the non-zero groups (the tail inputs are almost always non-zero), which stay branch-free steps. Branch-free 16-wide (no skip) gains nothing, so the saving is the skipped work, not the cheaper mask.

## liveBench (`--seconds 60 --profile`, taskset 2,3,6,7, nice 19, 3 alternating pairs, base = perf-live)

| Case | Build | cpuMsPerTick | brain forward ms | peak RSS MB | fingerprint |
|---|---|---|---|---|---|
| mixed | base | 12.015, 11.998, 11.958 (med 11.998) | 4.405, 4.406, 4.371 | 218, 218, 215 | 708687555 |
| mixed | compact16 | 11.997, 11.863, 11.697 (med 11.863) | 4.310, 4.263, 4.200 | 215, 220, 219 | 708687555 |
| cap | base | 14.390, 14.070, 14.157 (med 14.157) | 4.500, 4.356, 4.403 | 256, 256, 255 | 10334191 |
| cap | compact16 | 13.806, 14.243, 14.287 (med 14.243) | 4.195, 4.402, 4.366 | 256, 254, 253 | 10334191 |

Ratio of medians: mixed 0.989 (brain forward -0.14 ms, -3.2%), cap 1.006 (brain forward -0.04 ms, inside the spread). Fingerprints equal on both cases, peak RSS unchanged.

## Tests
`npx vitest run wasm thinkEvery brain --maxWorkers=2 --testTimeout=180000`: 8 files, 118 tests, exit 0. (Default 20 s timeout fails wasmCrowd and wasmStep under the nice 19 load, as before.)

## Verdict
Exact and general (any input count), but the ceiling is about 0.1-0.15 ms of the tick (under 1%), well inside the load noise of the whole-tick numbers. Merge only if small exact wins are wanted.
