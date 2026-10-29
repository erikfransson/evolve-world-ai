# u16 cellStart in the crowd grid (idea 89)

Exact, no gain (slower by about 1.5%). Branch `pl-cell16`, base `perf-live` 4f46e69. Rejected.

## What

`cellStart` (156k cells, 626 KB at the live setting) as a `Uint16Array` instead of `Int32Array`, 313 KB, filled 8 cells per v128 store.
Generality: `maxPopulation` is any count, so above `GRID.narrowMax` (65535 creatures) the table is u32 (`crowd.ts` picks it per rebuild, `crowd.wat` `$setStarts` and the `C_WIDE` flag, `sense.wat` and the sweep read through `$startAt` with `S_CROWD_WIDE` / `C_WIDE`). The JS readers (`anyWithin`, `castRays`, `hunt`, `collideAll`) take either typed array unchanged. A two-level table was not built: `crowdsparse.md` already rejected a per-row search in the hot readers.

## Whole tick (liveBench `--profile`, 60 s, nice 19, 4 CPUs shared, load 12-22, alternating pairs)

| Case  | Build | cpuMsPerTick                  | crowd grid ms           | senser ms               | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------|-------------------------|-------------------------|---------------|-------------|
| mixed | base  | 12.751, 12.856, 13.049 (12.856) | 0.184, 0.186, 0.192   | 4.644, 4.645, 4.763     | 214, 219, 216 | 708687555   |
| mixed | yours | 13.136, 13.065, 12.749 (13.065) | 0.189, 0.189, 0.183   | 4.931, 4.873, 4.736     | 217, 212, 221 | 708687555   |
| cap   | base  | 14.770, 14.285, 14.371 (14.371) | 0.388, 0.371, 0.373   | 5.634, 5.490, 5.511     | 254, 255, 258 | 10334191    |
| cap   | yours | 14.960, 14.421, 14.570 (14.570) | 0.397, 0.381, 0.391   | 5.899, 5.685, 5.746     | 254, 252, 255 | 10334191    |

Ratio of medians 1.016 (mixed) and 1.014 (cap). The grid phase did not move (0.186 to 0.189, 0.373 to 0.391), so the fill was not cold-table bound at this size, and the senser phase got 3-5% slower.
Control: a second mixed run with the `$startAt` branch removed (always `load16_u`, wide path broken, measurement only) gave 13.081 vs 12.846 base (3 pairs), senser 4.79-4.94 vs 4.60-4.72. So the senser loss is not the width branch; the 16-bit loads themselves do not help the crowd walk.

## Tests

`wasmCrowd.test.ts` new case: `GRID.narrowMax` lowered to 100, 20 ticks of the Inland Sea in both crowd modes, grid equal array for array and positions equal at the end; a 70000-creature JS rebuild gives a u32 table and goes back to u16. It times out (red) with the sense kernel's wide flag forced to 0.
`vitest run wasm sense crowd resident --maxWorkers=2`: 100 passed first run (exit 0); a later run under load 20 timed out one wasmStep case at 20 s, which passes alone with a 100 s timeout.

## Verdict

Reject. Exact but 1.5% slower, no phase gained, about 120 changed lines. Keep the branch only as a record.
