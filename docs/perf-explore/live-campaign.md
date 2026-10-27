# Live World speed campaign (2026-10-27)

Goal: the live server's tick (The Inland Sea, one thread, nice 19, cap 5000) runs faster without peak memory running away.
Branch `perf-live` from `development` (c384eb5). Every idea is logged below with its measured effect and verdict; kept ideas are merged into `perf-live`.

Benchmark: `node src/liveBench.ts` in `server/` (new, this campaign): the server's `LiveWorld` with `liveConfig`, seeded with the live founders, stepped headless on one thread.
Number to compare: `cpuMsPerTick` (user CPU per steady tick, after the first quarter), run as `nice -n 19 ionice -c3 chrt --idle 0`, several alternating pairs because the laptop is loaded (load 10-12).
Fingerprint equal means bit-identical results.

## Progress (development vs perf-live)

| Date       | Case                                   | development ms/tick | perf-live ms/tick | Factor | Peak RSS dev / perf-live |
|------------|----------------------------------------|---------------------|-------------------|--------|--------------------------|
| 2026-10-27 | 4 founders x 800 copies, 60 s          | pending             | pending           | 1.00x  | pending                  |
| 2026-10-27 | Juggernaut x 4900 (cap), 60 s          | pending             | pending           | 1.00x  | pending                  |

## Ideas

| # | Idea | Kind | Effect | Exact | Verdict |
|---|------|------|--------|-------|---------|

## Log
- 2026-10-27 09:00 Campaign start. Prior campaigns (B1, B2, `docs/perf-explore/`) already moved sense, brains, physics, crowd grid, collisions and scans into WASM; their rejected ideas are not retried unless the live setting changes the picture.
- 2026-10-27 09:40 `server/src/liveBench.ts` written; two runs at 400 seeded give the same fingerprint (260290661), so the bench is deterministic.
