# Sense records in crowd cell order (idea 85)

Branch `pl-cellorder`. Question: does running the sense kernel over creatures in crowd-grid cell order (neighbours consecutive) cut the senser phase?

## What changed (+28 -36, net -8 lines)
- `fill.wat` placed the sense records by a stable counting sort on the item grid row (creatures inside a row in slot order, so random in x). It now places them in crowd cell order, read off the grid that is already sorted: `inv[self] = k + 1` for the batch members, then one walk over the crowd's `owners` in sorted order gives each member its record position. n scatter writes plus `count` gathers over about 3300 ints (13 KB, L1), no per-creature float math and no row counts, so it replaces the old two passes and costs less than they did.
- `senser.run` passes `pOwn` (the owners in the kernel memory) and the crowd count; `F_ITEM_ROWS`/`F_INV_CELL` in the fill block became `F_OWNERS`/`F_CROWD_N`. A member index outside the crowd traps (`unreachable`) instead of writing out of bounds.
- Order independence: `sense.wat` has no global and writes nothing into its parameter block, only each record's own input vector and ray detail; scratch is rewritten per record. Equal fingerprints confirm it. The brain slot list stays in batch order, so the brain run is untouched.
- Crowd cells are row-major, so with the live config (item cell = crowd cell = 100) this is item-row order plus x order inside each row. Morton order not tried (the crowd arrays the walk reads are row-major, so a Z-curve would break the contiguity of a cell row).

## Measured (liveBench 60 s, `--profile`, alternating pairs, load 6-12, ms per tick)

| Case       | Pair | cpu base | cpu yours | senser base | senser yours | crowd grid b / y | slots b / y   |
|------------|------|---------:|----------:|------------:|-------------:|------------------|---------------|
| mixed      | 1    | 12.61    | 12.57     | 4.70        | 4.58         | 0.181 / 0.181    | 0.328 / 0.335 |
| mixed      | 2    | 12.81    | 12.54     | 4.81        | 4.60         | 0.180 / 0.184    | 0.334 / 0.331 |
| mixed      | 3    | 12.95    | 12.83     | 4.88        | 4.69         | 0.192 / 0.192    | 0.340 / 0.339 |
| juggernaut | 1    | 15.57    | 15.81     | 6.15        | 6.08         | 0.404 / 0.443    | 0.469 / 0.488 |
| juggernaut | 2    | 16.16    | 15.73     | 6.34        | 6.01         | 0.450 / 0.447    | 0.498 / 0.495 |
| juggernaut | 3    | 16.71    | 16.65     | 6.61        | 6.35         | 0.460 / 0.473    | 0.503 / 0.527 |

Ratio of medians (base / yours): mixed cpuMsPerTick 12.81 / 12.57 = 1.019x, senser 4.81 / 4.60 = 1.045x; juggernaut cpuMsPerTick 16.16 / 15.81 = 1.022x, senser 6.34 / 6.08 = 1.043x.
The senser is faster in 6 of 6 pairs (0.07 to 0.33 ms); whole tick is faster in 5 of 6 (juggernaut pair 1 is +0.24, load noise). Crowd grid and slots phases are unchanged within noise (the permutation lives in the senser phase and is not measurable apart from the old row sort it replaced).
Fingerprints equal: 708687555 mixed, 10334191 juggernaut. Peak RSS 215-220 vs 217-220 MB mixed, 253-258 vs 256-257 MB juggernaut.

## Tests
`npx vitest run wasm resident thinkEvery ecoPool sense --testTimeout=180000 --maxWorkers=2`: exit 0, 7 files, 134 passed (includes the kernels-drift check and wasmCrowd). Full suite not run.

## Verdict suggestion
Merge. Exact, fewer lines than before, no memory change, senser -4.3% (about 0.2 ms) and tick about -2% on both cases. The gain is small and each case has a pair inside the load noise, but the senser phase moved the same way in every pair. layout.md's "spatial order is no better than random" was for a different pass (per-creature streams dominated); here the shared item and crowd rows are what neighbours reuse, and the gain is the x order inside an item row.
