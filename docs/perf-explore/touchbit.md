# Item cell occupancy bitmap as a touch pre-reject (idea 86)

Exact, but the eat phase gets 0.05-0.06 ms slower and the whole tick does not move. Rejected. Branch `pl-touchbit`, base `perf-live` 531a215.

## Count (temporary JS counter in `WasmCrowd.touch`, 30 s runs, not committed)

Touch calls whose reach window covers only empty item cells: 55.8% mixed (1.66 M of 2.98 M), 61.7% at the cap (2.72 M of 4.41 M). Mean window 1.32 rows and 1.74 cells, 1.5 items per non-empty window. Above the 30% bar, so built.

## Ceiling (temporary kernel mode switch, warm loop of 20 touch calls, median over 400 ticks)

| Variant                                              | mixed ms | cap ms |
|------------------------------------------------------|---------:|-------:|
| full touch                                           | 0.83     | 1.15   |
| empty windows answered free from a precomputed flag  | 0.40     | 0.57   |
| window arithmetic only, no row walk                  | 0.19     | 0.19   |

The free flag skips the window arithmetic too, which a bitmap cannot. The ceiling of a real bitmap is about 0.2-0.3 ms (warm), minus its own lookup.

## What

- `senser.ts`: one bit per item cell (row-major `cy * cols + cx`, 12 KB on the Inland Sea) in the tail of the start-rows region (`pOcc`). The full sync sets bits while it writes the cells, `patchCell` sets or clears its cell's bit.
- `crowd.wat` `firstItem`: per row, an unaligned i64 load at the window's first bit, shifted and masked to the window (up to 56 cells, wider walks as before); an empty row skips the two `start` loads and the item loop.
- `layout.ts`: `C_ITEM_OCC`. 27 added lines of source (the generated kernels file is one line), plus a test of 16 lines.

## Numbers (liveBench `--profile --seconds 60`, taskset 2,3,6,7, nice 19, 3 alternating pairs)

| Case  | Build | cpuMsPerTick                         | eat ms                  | peak RSS MB   | fingerprint |
|-------|-------|--------------------------------------|-------------------------|---------------|-------------|
| mixed | base  | 13.543, 13.445, 12.918 (med 13.445)  | 1.136, 1.128, 1.083     | 216, 213, 214 | 708687555   |
| mixed | yours | 13.538, 13.073, 13.477 (med 13.477)  | 1.191, 1.158, 1.188     | 219, 216, 216 | 708687555   |
| cap   | base  | 15.845, 15.961, 16.146 (med 15.961)  | 1.448, 1.476, 1.484     | 257, 257, 253 | 10334191    |
| cap   | yours | 15.832, 15.820, 15.903 (med 15.832)  | 1.526, 1.518, 1.535     | 255, 255, 256 | 10334191    |

Ratio of medians 1.002 (mixed) and 0.992 (cap), inside the noise (+-3%). The eat phase, which is the measurable part, rises by 0.06 ms (mixed) and 0.05 ms (cap) in all three pairs of both cases.

## Why it does not pay

An empty window already costs two adjacent `start` loads per row and one compare; a bitmap replaces them with a load, a variable shift, a mask built from the width and an and, and the window arithmetic stays. The `start` table (400 KB) is read in cell order by creatures sorted by cell, so its lines are hot. The 56% of calls that skip are cheap already, and the extra ALU work lands on the 44% that walk too.
The rows after the first rarely matter (1.32 rows a window), so there is no long walk to cut. This is the same bound as `occgate.md`: a per-cell flag does not beat a walk that is already two loads.

## Tests

New `wasmCrowd.test.ts` case: after 40 ticks of eating and regrowth on the Inland Sea (cells patched in place) every bit equals whether the cell holds an item. The existing kernel-vs-JS touch comparison (16 randomised worlds, scattered creatures) is unchanged.
`wasmCrowd wasmKernels thinkEvery residentBodies wasmStep`: 96 passed, exit 0 (with `--testTimeout 300000 --maxWorkers 2`; at the default 20 s six long cases time out on the pinned, loaded cores, with or without this change); `tsc --noEmit` clean. Fingerprints 708687555 and 10334191 hold.

## Verdict

Reject. Code stays on the branch for reference.
