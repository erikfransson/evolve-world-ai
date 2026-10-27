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
| 1 | Think every other tick (`eco.thinkEvery` 2, staggered halves) | broad | running | no | |
| 2 | FMA via relaxed SIMD in brain and sense kernels, fallback kernels | small | running | no (rounding) | |
| 3 | bf16 brain weights (half the weight bandwidth) | small | running | no (rounding) | |
| 4 | Sense kernel profile at the live setting (measurement) | study | running | - | |
| 5 | Native N-API brain kernel with AVX2 and FMA (server only) | moonshot | running | no | |
| 6 | Helper threads for the server at idle priority: wall speed on this laptop | ops | queued | yes | |
| 7 | prepareRows (slots phase, 7%) into the fill kernel | small | queued | yes | |

## Log
- 2026-10-27 09:00 Campaign start. Prior campaigns (B1, B2, `docs/perf-explore/`) already moved sense, brains, physics, crowd grid, collisions and scans into WASM; their rejected ideas are not retried unless the live setting changes the picture.
- 2026-10-27 09:40 `server/src/liveBench.ts` written; two runs at 400 seeded give the same fingerprint (260290661), so the bench is deterministic.
