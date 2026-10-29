# The senser wrapper's data movement, part by part (idea 96)

Rejected: the parts are real (1.4 ms in the scouts' count) but nothing exact and small cuts more than 0.03-0.05 ms, which no whole-tick pair resolves. Branch `pl-fillcut` from `perf-live`, the kept change (SIMD narrowing in `fill.wat`) is +18 -16 lines; exact, fingerprints equal.

## Method
- Parts timed with `kernelTimers` (thread CPU, cold, as scout-ray) and, for the kernels, a scratch copy of it (not committed) that repeats each idempotent export 12 times right after the real call and keeps the minimum wall time, which is stable to about 3% at load 20. Ablations remove one part in the `.wat`, rebuild, rerun (timing only, results then wrong; pop stays 3200 over 80 ticks).
- Hot (repeat) and cold (first call) times agree within 0.03-0.07 ms: these kernels are compute bound, not miss bound.
- `syncItems` parts: temporary `performance.now` laps inside `patchCell`, 25 s run.
- Mixed case, 3300 creatures, taskset 2,3,6,7 nice 19, load 7-22. The "JS 0.09" of the scouts is mostly timer overhead: `run` minus its four timed children is 0.05 ms, and each nested timer pair costs about 1.5 us (a syscall).

## What each 0.1 ms is (ms per tick, hot unless marked)

| Call (hot)            | Part                                                    | ms     | Note |
|-----------------------|---------------------------------------------------------|--------|------|
| fill 0.209            | memory unit copy (f64 to f32, 5.5 units per creature)   | 0.049  | per-unit loop; 0.025 left after two-at-a-time `f32x4.demote_f64x2_zero` (kept) |
|                       | record copy, 5 f64 and 5 i32 per creature               | 0.045  | by the in-place variant below |
|                       | zero, scatter and walk for the cell-order place         | 0.021  | n scatter writes and a walk over the crowd |
|                       | extras copy (5 f64 to f32)                              | 0.008  | |
|                       | rest: row loads, slot store, loop                       | 0.09   | |
| prepare 0.188         | ground lookup (raster loads, branch, `$hit`)            | 0.139  | body is 0.049 (3 divides, stores); the lookup is 0.129 even when `$hit` returns at once |
| pack 0.230            | `Math.exp` import                                       | 0.181  | the rest 0.049: f32 positions, signal store, row store 0.01 |
| syncItems 0.33        | start shift loop (263 entries per patch, cold lines)    | 0.094  | 14.7k entries per tick, 6 ns each |
|                       | three `copyWithin` (168 calls)                          | 0.077  | 0.46 us a call, 117 items moved per patch |
|                       | `writeCell`                                             | 0.024-0.034 | |
|                       | list count walk                                         | 0.026  | |
|                       | loop, timers, rest                                      | about 0.1 | |

## Tried

| Variant | Result | Verdict |
|---------|--------|---------|
| Two-at-a-time f64 to f32 narrowing of extras and memory units (`$narrow`, `f32x4.demote_f64x2_zero`, tail for odd counts) | fill hot 0.209 to 0.181, cold median 0.37 to 0.32 | exact, kept, but see whole tick |
| Sense record of 16 bytes (row address, self, detail), `sense.wat` reads the resident rows in place | fill hot 0.209 to 0.160, but senser phase +0.1 to +0.2 in both pairs (three row lines per creature instead of one record line, rows are in slot order, records in cell order) | rejected |
| Ground lookup: one 4 x u16 test for "no corner at 128 or more in either layer" before the two `$hit` calls, and `f64.min`/`f64.max` clamps as compare and select | prepare hot 0.186 to 0.163, cold no change (0.28 vs 0.32 medians) | not shown better, dropped |
| `Math.exp` as a fdlibm port in `crowd.wat` (V8's `ieee754::exp` operation for operation, 0 mismatches in 20M random, edge and special arguments, probe-gated) | pack hot 0.229 to 0.245 | rejected: V8 already calls its C `exp` directly for the import (a constant argument costs nothing, so it is treated as a pure intrinsic), the cost is the 40 ns of arithmetic itself |
| `syncItems` shift in one wasm export | `intercept.md` measured it slower (7-9 us vs 4 us a patch) | not repeated |

An f64x2 two-lane `exp` (branch-free selects over the three reduction cases, scalar fallback at large arguments) could halve the 0.18 ms; estimated gain 0.05-0.09 ms (0.5-0.8%) for about 80 lines of wat; not built.

## Whole tick of the kept change (liveBench `--profile`, 60 s, alternating pairs, load 7-22)

| Case  | Build | cpuMsPerTick                         | senser ms            | slots ms             | peak RSS MB   | fingerprint |
|-------|-------|--------------------------------------|----------------------|----------------------|---------------|-------------|
| mixed | base  | 11.286, 10.719, 9.615 (med 10.719)   | 4.156, 3.963, 3.556  | 0.330, 0.308, 0.271  | 214, 220, 213 | 708687555   |
| mixed | yours | 11.466, 10.629, 10.835 (med 10.835)  | 4.174, 3.909, 3.921  | 0.333, 0.314, 0.311  | 218, 217, 220 | 708687555   |
| cap   | base  | 13.583, 13.708, 13.119 (med 13.583)  | 5.265, 5.291, 5.087  | 0.455, 0.453, 0.443  | 256, 253, 257 | 10334191    |
| cap   | yours | 13.726, 13.162, 13.548 (med 13.548)  | 5.330, 5.081, 5.219  | 0.454, 0.435, 0.448  | 259, 256, 253 | 10334191    |

Ratio of medians 1.011 (mixed) and 0.997 (cap): no change resolvable (an earlier round with the same fill change and the ground edits gave 0.99 and 1.01). The expected gain, 0.03-0.045 ms, is 0.3-0.4% of the tick, below the pair-to-pair spread of 5-10%.

## Tests
`npx vitest run wasm sense resident thinkEvery --maxWorkers=2 --testTimeout=180000`: 6 files, 108 passed, exit 0 (kernel drift, `residentBodies` prepare equality and the thinkEvery pin included).

## Verdict
Reject (or merge only as a free cleanup): the data movement around the senser is compute spread over a dozen 0.02-0.18 ms pieces; the two big ones (`Math.exp` 0.18, ground lookup 0.13) have no exact small cut, and the cut that removes the most copying (records in place) costs more in the kernel than it saves in fill.
