# Dilated crowd occupancy gate (idea 63)

Exact but slower. Rejected. Branch `pl-occgate`, base `perf-live` 8e3d177.

## What

`crowd.wat` `rebuild` marks per grid row two bit-planes (cells holding at least 1 and at least 2 creatures, 313 rows x 8 words on the Inland Sea), then `$dilate` spreads them by K cells along x (shifts on i64 words) and along y (v128 adds) with saturating-at-2 adds (`a2 |= b2 | a1 & b1; a1 |= b1`), so bit c of the result says "at least 2 creatures in the (2K+1)^2 block around cell c". K = ceil((longest ray length of the grid's rows x 1.000001 + radius) / cell), read from the rows in the key loop, so it follows the real lengths; above 24 cells there is no gate. `refresh` keeps the gate (same cells). 75 KB of planes.

`sense.wat`: one creature-level flag `$lone`, computed once before the early-out from the crowd window it already computes (moved up, the main path reuses it): own cell from `cellOf[self]`, window inside the block of K, gate bit 0. Both crowd walks (the idea 14 early-out copy and the main one) start past their last row when `$lone`. The creature itself is in its block by construction, so a clear bit means no other creature in the window; a wider window, a missing gate (JS grid) or a NaN length walks as before. A NaN position finds no candidate in either path.

## Counts (snapshot harness of `senselive.md`, tick 400 and 1500)

Gate says alone for 1831 of 3406 lookups (54%) at tick 400 and 1922 of 3465 (55%) at tick 1500 (a creature in the early-out is looked up twice when it walks on). K = 2 (cell 100, rays about 170).

## Kernel (cold, interleaved, 300 reps, `--no-liftoff`, load 16-18, p25 ms)

Brain inputs of all creatures after NaN poisoning hash equal to the base kernel (b101b365 at tick 400, 50357cc0 at 1500).

| Snapshot  | base  | gate on | gate off (S_GATE 0) | gate computed, never skips |
|-----------|------:|--------:|--------------------:|---------------------------:|
| tick 400  | 4.711 | 4.871   | 4.801               |                            |
| tick 400  | 4.759 | 4.920   | 4.849               | 4.995                      |
| tick 1500 | 4.125 | 4.227   | 4.171               |                            |

Skipping the walks saves 0.075 ms (4.995 to 4.920), the lookup costs 0.15 ms (4.849 to 4.995, about 45 ns a creature: three dependent loads and a division, cold), and the moved code costs 0.05-0.09 ms even with the gate off (a register-bound function). A walk of a lone creature is about 45 ns; skipping it for 55% bounds the gain at 0.1 ms, 0.7% of the tick, below the bar before any cost.

## Whole tick (liveBench `--profile`, nice 19, taskset 2,3,6,7, 3 alternating pairs)

| Case | Base cpuMsPerTick | Yours | Ratio | Base crowd grid / senser ms | Yours crowd grid / senser ms | Peak RSS MB base / yours | Fingerprint |
|------|-------------------|-------|------:|-----------------------------|------------------------------|--------------------------|-------------|
| 4 founders x 800 | 14.147, 14.173, 14.029 (med 14.147) | 14.449, 14.301, 14.456 (med 14.449) | 1.021 | 0.213, 0.215, 0.209 / 5.402, 5.379, 5.329 | 0.249, 0.250, 0.241 / 5.453, 5.403, 5.400 | 218, 216, 216 / 217, 217, 223 | 708687555 both |
| juggernaut x 4900 | 16.923, 17.088, 17.012 (med 17.012) | 17.605, 17.469, 17.141 (med 17.469) | 1.027 | 0.475, 0.505, 0.468 / 6.760, 6.756, 6.733 | 0.605, 0.593, 0.558 / 6.916, 6.880, 6.753 | 256, 257, 253 / 256, 256, 255 | 10334191 both |

The build adds 0.036 ms (mixed) and 0.11 ms (cap) to the crowd grid phase, the senser phase gets slower too.

## Tests

`wasmKernels`: the gate bit of every cell equals a brute-force block count (grid rows of exactly 64, 65 and 100 words of cells, clumps at both ends), the gate is absent when switched off or when a ray exceeds 24 cells, and the brain input of every creature with the gate equals the plain walk (sparse and crowded worlds, 0 to 3 species, rays 25 to 250, creatures at walls and corners, a NaN x and an infinite y, with and without a detail creature). It goes red with K one smaller and the window check removed. Green: `wasmCrowd wasmKernels thinkEvery residentBodies wasmStep` (97 tests), `tsc --noEmit`.

## Verdict

Reject. Exact and cheap to build, but the walk it skips is already a short loop for a lone creature (a few rows, about 1.5 entries), so the gain cannot reach 1% of the tick while the lookup and the build cost more than they save. The same bound applies to any precomputed per-cell flag: the walk cost of a creature alone is too small to pay for another cold lookup. Code stays on the branch for reference.
