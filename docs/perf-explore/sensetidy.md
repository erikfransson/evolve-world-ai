# Idea 126: sense kernel tidy (sensetidy)

Branch `pl-sensebudget` from `perf-live` 6f81ad5 (engine unchanged up to af8f48b). Built from idea 1 of `sensebudget.md`, plus its idea 2. Exact, fingerprints equal.

## What (`sense.wat`)
- The odd last ray lane is padded with NaN in the direction scratch (dx and dy at index nR), so the prefilter loses its per-group `g*2+1 == nR` test. The group loop steps `ro` and `sp` pointers against an end pointer.
- The item row loop steps the two `itemStart` pointers by the row stride instead of an `imul` and shifts per row.
- `$dirsPairs` also stores best = L and kind 0 when no wall is in range. `$initPairs` is gone.
- Item candidates store fx, fy and the index. The exact path computes d2 - r2 from them (same operations, same bits). Rock discs keep their stored value.
- Item and crowd cell windows are one vector chain each (`f64x2` and `f32x4` floor, `i32x4.trunc_sat_*`, per-call clamp vectors, `extract_lane`). The lower clamp (>= 0) and upper clamp (<= last cell) stay separate, so a negative last column still gives an empty window.
- Header notes the NaN lane; the unused `$lane0` is dropped. Diff `sense.wat` +53 -47 with comments (generated file 1 line).

## Window set-up check (kernel harness, same state, p25 ms, 3 runs, call 300)
Variants alternate inside each run, hash equal throughout (mixed 10b91cba, cap 4cc9bd68).

| Case  | Run | base  | tidy  | tidy + vector windows |
|-------|-----|------:|------:|----------------------:|
| mixed | 1   | 3.704 | 3.470 | 3.436                 |
| mixed | 2   | 3.625 | 3.430 | 3.367                 |
| mixed | 3   | 3.648 | 3.441 | 3.396                 |
| cap   | 1   | 4.795 | 4.548 | 4.448                 |
| cap   | 2   | 4.704 | 4.438 | 4.356                 |
| cap   | 3   | 4.736 | 4.490 | 4.395                 |

The vector windows win in 6 of 6 (-0.03 to -0.06 mixed, -0.08 to -0.10 cap), so they are in. Tidy alone is -0.20 to -0.23 mixed and -0.25 to -0.27 cap against base.

## Whole tick (liveBench `--profile --seconds 60`, base = `perf-live` worktree, taskset 2,3,6,7 nice 19, 3 alternating pairs)

| Case  | Build | cpuMsPerTick                       | senser ms                   | brain forward ms         | peak RSS MB   | fingerprint |
|-------|-------|------------------------------------|-----------------------------|--------------------------|---------------|-------------|
| mixed | base  | 12.082, 11.457, 11.635 (11.635)    | 4.255, 4.120, 4.227 (4.227) | 4.709, 4.361, 4.427      | 219, 215, 217 | 708687555   |
| mixed | new   | 11.225, 11.410, 11.156 (11.225)    | 3.904, 3.920, 3.888 (3.904) | 4.396, 4.498, 4.364      | 219, 221, 222 | 708687555   |
| cap   | base  | 13.489, 13.798, 13.631 (13.631)    | 5.135, 5.195, 5.177 (5.177) | 4.394, 4.529, 4.425      | 254, 258, 255 | 10334191    |
| cap   | new   | 13.277, 13.865, 13.559 (13.559)    | 4.882, 4.991, 4.974 (4.974) | 4.392, 4.698, 4.516      | 255, 258, 257 | 10334191    |

Ratio of medians (new / base): senser 0.924 mixed, 0.961 cap (faster in 6 of 6 pairs, -0.32 and -0.20 ms); tick 0.965 and 0.995. The tick moves with the brain forward phase, which differs by up to 4% between sides, so the senser delta is the claim: 2.8% (mixed) and 1.7% (cap) of the base tick of these runs.
The earlier probe without the vector windows gave senser 0.946 / 0.934 over 3 pairs (`sensebudget.md`).

600 s mixed, one pair (pin 164690887): cpuMsPerTick 10.472 base, 10.275 new (0.981); senser 3.304 to 3.123 (0.945); brain forward 4.330 and 4.304; peak RSS 222 and 223 MB; fingerprint 164690887 on both.

## Tests
- `npm run wasm` exit 0, generated file in sync (drift test passes).
- `npx vitest run --maxWorkers=2 --testTimeout=180000` (pinned): 122 files, 1256 of 1257 tests passed, exit 1. The one failure is `cli.test.ts` "bench.ts ... fingerprint does not depend on the thread count", a 20 s timeout of two spawned bench processes at load 10-18. `vitest run cli --maxWorkers=1`: 16 of 16, exit 0.

## Verdict
Merge. Exact, general over every ray count (odd and even), row count and stride, senser -4% to -8%, about 2-3% of the tick, RSS unchanged.
