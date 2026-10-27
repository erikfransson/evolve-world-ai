# Live World speed campaign (2026-10-27)

Goal: the live server's tick (The Inland Sea, one thread, nice 19, cap 5000) runs faster without peak memory running away.
Branch `perf-live` from `development` (c384eb5). Every idea is logged below with its measured effect and verdict; kept ideas are merged into `perf-live`.

Benchmark: `node src/liveBench.ts` in `server/` (new, this campaign): the server's `LiveWorld` with `liveConfig`, seeded with the live founders, stepped headless on one thread.
Number to compare: `cpuMsPerTick` (user CPU per steady tick, after the first quarter), run as `nice -n 19 ionice -c3 chrt --idle 0`, several alternating pairs because the laptop is loaded (load 10-12).
Fingerprint equal means bit-identical results.

## Progress (development vs perf-live)

| Date       | Case                                   | development ms/tick | perf-live ms/tick | Factor | Peak RSS dev / perf-live |
|------------|----------------------------------------|---------------------|-------------------|--------|--------------------------|
| 2026-10-27 | 4 founders x 800 copies, 60 s (3300)   | 15.24               | 15.24             | 1.00x  | 214 / 214 MB             |
| 2026-10-27 | Juggernaut x 4900 (cap), 60 s          | 18.50               | 18.50             | 1.00x  | 253 / 253 MB             |

Baseline phases (ms per tick, 3300 mixed / 4900 Juggernaut): senser 5.74 / 7.54, brain forward 5.23 / 5.17, slots (prepareRows) 1.04 / 1.52, memory and steer 1.26 / 1.59, eat 1.05 / 1.35, crowd grid 0.51 / 0.67, collisions 0.18 / 0.27, rest under 0.2. Server frame encoding adds 0.57 ms per tick at 5 Hz. Speed achieved unpaced on this loaded machine: 2.0x and 1.7x real time (the set speed is 3x).

## Ideas

| # | Idea | Kind | Effect | Exact | Verdict |
|---|------|------|--------|-------|---------|
| 1 | Think every other tick (`eco.thinkEvery` 2, staggered halves) | broad | 1.51x (3300 mixed), 1.47x (4900 cap); no memory cost | no at 2 (yes at 1) | Merged with thinkEvery 1 everywhere: at 2 the 600 s runs show churn 1.5-1.9x higher and the population trend reversed, so switching the live world to 2 is Erik's call (`think2.md`) |
| 2 | FMA via relaxed SIMD in brain and sense kernels, fallback kernels | small | 1.024-1.026x (brain forward -7%, senser unchanged), 90 lines plus a second kernel build | no (rounding, machine-dependent) | Rejected for now: too little for giving up cross-machine bit-equality; parked on `pl-fma` (`fma.md`) |
| 3 | bf16 brain weights (half the weight bandwidth) | small | brain kernel 1.00x or worse (weights are 28% of kernel time, the widening costs 0.5 ms) | no (rounding) | Rejected (`bf16.md`) |
| 4 | Sense kernel profile at the live setting (measurement) | study | kernel flat: per-ray passes 38%, item walk and tests 38%, crowd 14%, rock 10%; two exact cuts worth about 4% of the tick | - | Done (`senselive.md`), cuts queued as idea 8 |
| 5 | Native N-API brain kernel with AVX2 (server only) | moonshot | brain forward 1.8x bit-identical (prefetch, 8-wide), whole tick 1.15-1.17x; FMA adds 2% | yes (exact variant) | Parked on branch `pl-native` (`native.md`): needs Erik's call on a C++ twin of brain.wat, a build step at deploy and the Live push gate (no bounds checks yet) |
| 6 | Helper threads for the server at idle priority: wall speed on this laptop | ops | queued | yes | |
| 8 | Sense: shared ray-offset tables (273 distinct among 3331) and a rock lower-bound table, wall-loop skip | small | queued | yes | |
| 9 | brain.wat: up to 6-vector column blocks (24-wide layers in one pass), tanh inlined per layer | small | brain kernel 1.10x (Oracle 1.17x, Juggernaut 1.05x), about 3% of the tick | yes | Merged (`brainblock.md`) |
| 12 | Node and V8 flags for the server process (semi-space, liftoff, wasm tiering, gc) | small | none beats baseline by over 3%; GC is about 2% | yes | Rejected (`flagslive.md`) |
| 7 | prepareRows (slots phase, 7%) into the fill kernel | small | no exact variant over 1%: ground lookup is at most 0.6 ms, exp 0.33, rest 0.45 | yes | Rejected (`prep.md`) |

## Log
- 2026-10-27 09:00 Campaign start. Prior campaigns (B1, B2, `docs/perf-explore/`) already moved sense, brains, physics, crowd grid, collisions and scans into WASM; their rejected ideas are not retried unless the live setting changes the picture.
- 2026-10-27 09:40 `server/src/liveBench.ts` written; two runs at 400 seeded give the same fingerprint (260290661), so the bench is deterministic.
- 2026-10-27 11:10 Idea 3 rejected: the brain kernel is about 72% compute or latency, only 28% weight traffic (cache-resident control 3.9 vs 5.3 ms); bf16 widening eats the saving. Write-up `bf16.md`.
- 2026-10-27 11:30 Idea 7 rejected: the slots phase splits into ground lookup (at most 0.6 ms), Math.exp (0.33) and field traffic (0.45); nothing exact to cut. Write-up `prep.md`.
- 2026-10-27 12:00 Idea 4 done: sense kernel cost is loop entry, branch misses and cold misses per grid row, not candidate counts (2.2 items, 0.2 rock, 0.1 crowd kept per creature). Exact cuts queued as idea 8. Write-up `senselive.md`.
- 2026-10-27 13:10 Idea 5 (moonshot) measured: a native AVX2 brain kernel on the bank memory is bit-identical and 1.8x on the kernel, 1.15-1.17x per tick. Parked for Erik: it means a C++ twin of brain.wat, a g++ build at deploy, and attack surface (uploaded plans size the brains). Finding: the kernel cost is instructions and latency, not bandwidth, so brain.wat itself has headroom (idea 9).
- 2026-10-27 14:00 Idea 2 measured 1.025x; parked, not merged: relaxed_madd fuses only on CPUs with FMA, so saves would replay differently across hosts, and the gain is 0.4 ms. Erik can overrule.
- 2026-10-27 15:40 Ideas 1 and 9 merged into perf-live (c5b159a, 414b13e). thinkEvery stays 1 in liveConfig: the 1.5x is available by one config line once Erik accepts the dynamics change. Factor run batch1 (3 alternating pairs, both cases) and the full test suite started.
- 2026-10-27 16:20 Idea 12 rejected: no Node flag helps (baseline spread alone 6%). GC about 2%.
