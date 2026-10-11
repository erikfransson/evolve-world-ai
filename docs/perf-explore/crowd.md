# Crowd grid and item grid at low density

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Crowd rebuild by stable radix sort of cell keys, cellStart filled only across gaps, collideAll sweeps occupied cells only | 11.06 / 7.55 / 5.72 ms CPU per tick at 50k / 30k / 20k (pop about 600) | 6.50 / 5.83 / 5.25 | 1.70x / 1.29x / 1.09x | yes, all fingerprints equal | -1 to -4 MB (no cursor array) | about 70 net | Merge |
| Same, Great Hunt at 30k, --pop 300 (hunt rebuilds too) | 6.18 | 4.34 | 1.42x | yes (54745658 both) | -3 MB | in the row above | Merge |
| Item arrays patched in the WASM copy from dirty slot/cell lists instead of copied whole each tick | 6.97 at 50k | 6.56 | 1.06x | yes | +0 (two short lists) | about 35 | Merge (optional, split from the row above) |
| Larger cells for sparse worlds | not tried | | | would change collision order | | | Rejected, not needed |
| Reusing the grid across prepareTick, hunt, collideAll | not tried | | | positions move between them | | | Not possible |

Medians of 3 alternating A/B pairs (4 for the item sync), `nice -n 19`, user CPU per tick, load average 22 to 35 so absolute numbers are pessimistic. `--pop 600 --seed 1`, 12 to 20 s runs. Peak RSS is 127-135 MB at all widths, far below 1.5 GB.

## Findings

- Old rebuild cost was linear in cells: 254 us at 20k, 1240 us at 50k for 600 creatures (micro benchmark, 156500 cells at 50k, cell 100). It ran 2 times per tick (3 with predators) plus a full cell sweep in collideAll.
- New rebuild: 138 us at 20k, 203 us at 50k (600 creatures), 843 us for 3000 creatures at 50k. The remaining cell-linear part is `Int32Array.fill` over gaps, about 10 us per 30000 cells.
- Order is identical to the counting sort: LSD radix is stable, so a cell keeps creature order and cells are ordered by index. `collideAll` walks `occupied` (ascending cell index), the same order as the row-major sweep, so the cell size stays.
- Dense cellStart is kept because the WASM sense kernel and `castRays` read `cellStart[row + cx0 .. row + cx1 + 1]` as one contiguous range.
- Item grid: `cellHead`, `cellStamp`, `blockStamp` are only touched per change (no per-tick full-grid work in world.ts). Memory at 50k: 125000 items, 156500 cells: cellHead 0.63 MB, cellStamp 0.63 MB, blockStamp about 0.04 MB. The per-tick full-array work was in `WasmSenser.run`, which copied xs, ys, kinds, nextItem, cellHead (about 2.5 MB) plus crowd.cellStart (0.63 MB) into WASM memory every tick: 330 us per tick at 50k, 36 us at 20k. Items now sync through `World.dirtySlots` and `dirtyCells` (recorded only once a senser asks, full copy on first use, on a different world or when more than count/8 slots changed). `crowd.cellStart` is still copied whole (about 50 us at 50k).
- Next candidate, not done: copy only the crowd's cellStart gaps' changes, or let the WASM kernel take the occupied-cell list.

## Checks

`--seconds 30 --pop 600` 494818766 (threads 0 and 3), `--predators --seconds 40` 792910110 (threads 0 and 3), `bench.ts --pop 300 --gens 12 --seed 2` 836727452, 50k pop 600 328449237 equal to baseline, vitest 439 passed.
