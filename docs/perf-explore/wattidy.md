# Idea 118: exact tidy of the kernels (wattidy)

Branch `pl-wattidy`. Exact, no change in behaviour.

## Folded
- sense.wat: the f32 crowd window (x32, y32, L32, outer directions, far, margin, openness, cell range) is computed once after the f64 walks, for both the early-out and the crowd rays; was written twice. Its openness has its own local `$openc`, so `$open` is f64 only.
- sense.wat: `$emit` and `$emitClo` are one `$emit` with a loop-invariant `calc` flag (closeness from scratch or from best and kind); one stride-tail zero loop.
- sense.wat: two dead `$i = 0` stores removed; the stale "f32 as rays.wat" comment replaced; the header now covers the early-out, the two-rays-per-candidate test (88), the wedge filter for rock discs (115) and `patchItems` (100).
- brain.wat: the always-true `(if (i32.const 1)` around the one-vector tail and the shift by 0 in `$compact` removed. The header names no pass, so it stays.
- members.wat: header says three scans, `mutateScan` twins ga.ts.

## Measured
`liveBench --seconds 60 --profile`, pinned to cores 2,3,6,7, alternating base (perf-live), new, 3 pairs per case. cpuMsPerTick, then senser and brain forward phase ms per tick.

| case  | pair | base cpu | new cpu | base senser | new senser | base brain | new brain |
|-------|------|----------|---------|-------------|------------|------------|-----------|
| mixed | 1    | 9.266    | 9.341   | 3.381       | 3.394      | 3.536      | 3.582     |
| mixed | 2    | 9.042    | 8.868   | 3.314       | 3.207      | 3.452      | 3.420     |
| mixed | 3    | 8.780    | 8.855   | 3.213       | 3.218      | 3.355      | 3.393     |
| cap   | 1    | 10.618   | 10.483  | 4.129       | 4.048      | 3.406      | 3.388     |
| cap   | 2    | 10.694   | 10.353  | 4.123       | 3.997      | 3.438      | 3.320     |
| cap   | 3    | 10.530   | 10.241  | 4.074       | 3.940      | 3.366      | 3.293     |

Ratio of medians (new / base): mixed cpu 0.981, senser 0.971, brain 0.991; cap cpu 0.975, senser 0.969, brain 0.975. Mixed is inside the pair noise (pairs 1 and 3 slightly worse), cap is better in 3 of 3. No loss.
Fingerprints 708687555 (mixed) and 10334191 (cap) hold in all 12 runs. Peak RSS 217-222 mixed, 251-256 cap, as base.

Tests: `vitest run wasm sense resident thinkEvery brain --maxWorkers=2 --testTimeout=180000`: 9 files, 131 tests, exit 0.

Verdict: merge (exact, fewer lines, no cost).
