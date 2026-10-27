# Live World speed campaign (2026-10-27)

Goal: the live server's tick (The Inland Sea, one thread, nice 19, cap 5000) runs faster without peak memory running away.
Branch `perf-live` from `development` (c384eb5). Every idea is logged below with its measured effect and verdict; kept ideas are merged into `perf-live`.

Benchmark: `node src/liveBench.ts` in `server/` (new, this campaign): the server's `LiveWorld` with `liveConfig`, seeded with the live founders, stepped headless on one thread.
Number to compare: `cpuMsPerTick` (user CPU per steady tick, after the first quarter), run as `nice -n 19 ionice -c3 chrt --idle 0`, several alternating pairs because the laptop is loaded (load 10-12).
Fingerprint equal means bit-identical results.

## Progress (development vs perf-live)

| Date       | Case                                   | development ms/tick | perf-live ms/tick | Factor | Peak RSS dev / perf-live |
|------------|----------------------------------------|---------------------|-------------------|--------|--------------------------|
| 2026-10-27 09:00 | 4 founders x 800 copies, 60 s (3300)   | 15.24               | 15.24             | 1.00x  | 214 / 214 MB             |
| 2026-10-27 09:00 | Juggernaut x 4900 (cap), 60 s          | 18.50               | 18.50             | 1.00x  | 253 / 253 MB             |
| 2026-10-27 16:30 | 4 founders x 800 (3 pairs, medians)    | 16.03               | 15.51             | 1.03x (exact); 1.5x more with `eco.thinkEvery` 2, Erik's call | 249 / 248 MB |
| 2026-10-27 16:30 | Juggernaut x 4900 (3 pairs, medians)   | 19.66               | 19.41             | 1.01x (exact) | 257 / 254 MB |

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
| 8 | Sense: pooled ray-offset tables, rock lower-bound table (70 KB), v128 feature store | small | senser 5.2 to 4.5 ms, tick 1.05x in both cases; wall-loop skip rejected (0.8%) | yes | Merged (`sensecuts.md`) |
| 9 | brain.wat: up to 6-vector column blocks (24-wide layers in one pass), tanh inlined per layer | small | brain kernel 1.10x (Oracle 1.17x, Juggernaut 1.05x), about 3% of the tick | yes | Merged (`brainblock.md`) |
| 11 | Server frame encoding (byte writes, age without a Map lookup, leaderboard key) | small | frame work 0.64 to 0.50 ms per tick, 0.14 ms (under 1% of the tick); 81 lines in the gated server path | yes | Rejected (`frames.md`); the bench charged stats at 5 Hz instead of 1 Hz, fixed |
| 10 | Eat phase: crowd `cellStart` fill four cells per v128 store (both rebuilds per tick) | small | crowd grid 0.55 to 0.42 ms, eat 1.14 to 1.00 ms, about 1.7% of the tick; the eat loop itself is 0.07 ms (33 eaters a tick) | yes | Merged (`eatlive.md`) |
| 12 | Node and V8 flags for the server process (semi-space, liftoff, wasm tiering, gc) | small | none beats baseline by over 3%; GC is about 2% | yes | Rejected (`flagslive.md`) |
| 15 | Step kernel: clear-of-rock raster one bit per square (8x smaller lookup) | small | memory and steer phase -8% in every pair, about 0.7% of the tick; sin and cos host calls are 36% of the phase, not removable exactly across engines | yes | Merged (17 lines, less memory) (`stepk.md`) |
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
- 2026-10-27 16:30 Factor after batch 1: 1.03x mixed, 1.01x at the cap, bit-identical. The exact wins are small, as the earlier campaigns found; the big lever (think every other tick, 1.5x) waits for Erik's decision on the dynamics change.
- 2026-10-27 17:00 Full suite on perf-live: 1215 of 1216 pass; the Inland Sea case of residentBodies.test.ts hits its 20 s timeout under load on perf-base too (both pass in 45 s with --testTimeout=180000), so not a regression.
- 2026-10-27 17:40 Idea 11 rejected: under 1% for 81 lines in server code under the push gate. liveBench now calls stats once a second as the server does.
- 2026-10-27 18:00 Idea 10 merged (14 lines of crowd.wat). The second crowd rebuild cannot be skipped exactly (creatures cross cells every tick, in-cell order matters for collisions).
- 2026-10-27 19:30 Idea 8 merged (+138/-34, exact, about 5%).
- 2026-10-27 20:30 Idea 15 merged (small but consistent, smaller raster). Note from the agent: identical code ran 0.8 ms slower in one worktree than another, so pairs must run from one checkout (base = HEAD, yours = patch).
