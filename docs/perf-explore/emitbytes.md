# Sense kernel feature emit: fewer bytes moved (idea 107)

Rejected. Exact variants (brain inputs, fingerprints 708687555 and 10334191 unchanged), but none moves the senser phase. Branch `pl-emitbytes` from `perf-live` c4dc5b8, docs only; the prototypes were scratch edits of `sense.wat` (the pair-store patch is 17 lines).

## Counter: how many emitted rays rewrite zeros over zeros
Instrumented `$emit`, `$emitClo` and the hit path (old block read before the write, exported i64 counters). liveBench 800 copies x 4 founders, 60 s, 1800 ticks, rays that took the all-empty `memory.fill` early-out not counted.

| Rays through emit and hit path | Per tick | Share |
|---|---|---|
| all | 23.3k | 100% |
| through `$emit` / `$emitClo` (no creature seen) | 21.3k | 91.5% |
| new block zero, old block zero | 20.0k | 86.0% |
| new zero, old non-zero | 0.6k | 2.7% |
| new non-zero, old zero | 0.7k | 2.8% |
| non-zero both | 2.0k | 8.5% |

So a "skip when the slot is already zero" rule would drop 86% of the ray writes.

## (a) Skip zero-over-zero rays
Exact form: for a ray with kind 0 (block all +0.0), read the old 24 bytes (`v128` plus `i64`) and skip the stores when they are zero; otherwise write as before. Stride 6 only (other strides always write). A real dirty-rays record would avoid the read too, but it needs per-slot state outside the input (the 64-byte creature record is full, `set` would have to clear it, any other writer of the ray area would have to maintain it).

liveBench `--profile`, 60 s, 3 alternating pairs (taskset 2,3,6,7 nice 19, load 13-15), mixed case:

| Build | cpuMsPerTick | senser ms | brain forward ms | fingerprint |
|---|---|---|---|---|
| base | 11.364, 11.308, 11.753 (med 11.364) | 4.207, 4.181, 4.322 (med 4.207) | 4.119, 4.161, 4.334 | 708687555 |
| skip zero-over-zero | 11.189, 11.696, 11.582 (med 11.582) | 4.150, 4.322, 4.226 (med 4.226) | 4.084, 4.270, 4.277 | 708687555 |

No gain (senser +0.5%, inside the spread). Skipping 86% of the stores while reading the same lines removes nothing, so the store instructions are not the cost.

Bound without the read (skip kind-0 rays untouched, not exact): the inputs go stale, creatures see phantom food and the population collapses (cpuMsPerTick 3.0, fingerprint 143947451), so the line-touch saving cannot be measured that way. It would also move to the brain: `$compact` and layer 0 read the same lines in the same tick (`compactio.md`, `compact16.md`: the first touch of the input shows up wherever it comes first).

## (b) Aligned stores for stride 6
Pairs of rays: `A`, then `0 0 B0 B1` and `B2 B3 0 0` made with two `i8x16.shuffle` against zero, 3 `v128` stores per 48 bytes instead of `v128` + `i64` per ray (4). In `$emit` and `$emitClo`, odd last ray and other strides on the old loop. 17 lines.

Tests `npx vitest run wasm sense resident thinkEvery brain --maxWorkers=2 --testTimeout=180000`: 9 files, 127 tests, exit 0. Whole tick with `--profile`, 3 alternating pairs each (load 8-14); the senser phase swings with load, so the senser/brain forward ratio (brain unchanged) is given too:

| Case | Build | cpuMsPerTick | senser ms | senser / brain | peak RSS MB | fingerprint |
|---|---|---|---|---|---|---|
| mixed | base | 11.156, 11.569, 11.13 (med 11.156) | 4.118, 4.226, 4.103 | 0.997, 0.983, 0.997 | 219, 217, 214 | 708687555 |
| mixed | pair stores | 10.891, 9.838, 11.54 (med 10.891) | 3.977, 3.639, 4.271 | 0.990, 1.006, 1.009 | 220, 216, 216 | 708687555 |
| cap | base | 11.787, 11.608, 13.067 (med 11.787) | 4.569, 4.487, 4.998 | 1.251, 1.249, 1.225 | 257, 252, 252 | 10334191 |
| cap | pair stores | 12.35, 10.755, 12.229 (med 12.229) | 4.763, 4.151, 4.715 | 1.249, 1.245, 1.244 | 255, 255, 250 | 10334191 |

The ratio is flat (mixed 0.997 vs 1.006, cap 1.249 vs 1.245); the tick medians differ by load, not by the change.

## (c) What the layout makes expensive
`senselive.md`: "crowd merge and feature writes" is 0.93 ms cold against 0.43 ms hot. The 0.5 ms cold excess is first touch of the input lines (about 9 rays x 24 bytes = 216 bytes, 3 to 4 lines, per creature, evicted by the 24 MB weight stream of the previous brain pass), while the arithmetic is about 10 cycles a ray (23k rays a tick, under 0.1 ms). Neither fewer stores (a, b) nor fewer instructions touch that. Touching the lines early costs more than it saves (`sensepf.md`: a WASM load that misses blocks retirement, no prefetch instruction). The lines must be touched once per tick by the sense or by the brain, so the bytes cannot be cut below the touched lines without changing the input layout (`compactio.md`, rejected).

## Verdict
Reject. Exact and general (any ray count and stride), but the emit's cost is cache-line first touch, not stores: skipping 86% of the stores (a) and cutting 25% of them (b) both leave the senser flat. No engine change committed.
