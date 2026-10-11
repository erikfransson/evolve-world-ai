# Packed per-row item layout for the WASM sense kernel

Branch `worktree-agent-a8af7ff33c668d277`. Items live in per-cell linked lists in `World`. The kernel now reads a packed copy instead: each grid row is one run of (x, y) pairs and kinds in cell order, head-insertion order inside a cell, so the cells `cx0..cx1` of a row are one contiguous range `[start[cx0], start[cx1 + 1])`. The candidate order is exactly the old list walk, so ties resolve identically.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Packed row runs, patched per dirty cell, kernel reads a row range instead of chasing `nextItem` | kernel 7.10 / 16.5 / 12.5 ms per tick (20000 plain / 30000 plain / 20000 Great Hunt) | 6.02 / 13.65 / 10.7 ms | kernel 1.18x / 1.21x / 1.17x | yes, see checks | -0.4 to -1.5 MB (117.9 to 116.5 MB at 50000, pop 600) | +28 net source (+96/-68 gross, `senser.ts` +37, `sense.wat` -3, `world.ts` -6), +25 test | Merge (small gain, small code) |
| Same, whole tick | 20.3 / 47.4 / 38.1 ms CPU per tick | 19.5 / 44.2 / 36.4 | 1.04x / 1.07x / 1.05x | yes | as above | in the row above | |
| Same, low density 50000, pop 600 | 4.75 ms | 4.40 ms | 1.07x | yes | -1.5 MB | | |
| Rebuild the packed copy every tick | not built | | | | | | Rejected: O(cells + items) per tick, about 0.3 ms at 50000 where the gain is under 0.3 ms |
| Rebuild changed rows from the first changed cell | sync 0.33 to 0.55 ms per tick at 30000 | replaced by the next row | | | | | Rejected: walks 150 cells and 120 list items per dirty row |
| Patch the changed cell and shift the row tail (`copyWithin`) | sync 0.02 ms per tick (old dirty-slot copy) | 0.07 / 0.16 / 0.11 ms (20000 / 30000 / hunt) | | yes | | | Kept (cost is included in the whole-tick rows) |

Kernel and sync times are process CPU from timers around `exports.sense` and `syncItems` in a real `Ecosystem.step` loop (`width` scaled population, 250 to 300 ticks, last 75% timed), medians of 3 to 4 alternating base/new pairs, `nice -n 19`, load average 15 to 18 from other sessions. Pair-to-pair spread was under 2% for the kernel numbers. `ecoBench` `cpuMsPerTick` pairs (5 at 20000, 4 at 30000) agree in sign but are noisier (+-10%): medians 16.95 vs 16.32 at 20000, 42.1 vs 42.1 at 30000. A warm repeated-call microbench (no per-tick change, caches hot) showed 12 to 20% kernel gain, the same range.

## Findings

- The crowd grid is already this layout (sorted arrays, `cellStart`, row ranges read as one run, see `crowd.md`). Only the item grid chased pointers, so there is nothing to do for the crowd walk.
- The kernel does not use the ray cache. `sense.wat` walks the grid fresh for every creature every tick (about 10 grid items and 4 candidates after the culls, from rays.md and simdrays.md), so the 95% cache validity does not help the WASM path. A kernel-side cache of each creature's candidate list is conceivable (walk skipped on about 95% of calls, same order), but needs per-creature storage in WASM memory and stamp checks in WAT. After this change the item walk is cheaper, so the bound shrinks: the item walk and culls were about a third of the kernel (simdrays.md), so at most about 20% of the kernel and 7% of the tick, before the cache overhead. Not built.
- Kernel share of the tick: 35% (20000 plain), 35% (30000), 33% (Great Hunt). A 17-21% kernel gain therefore gives 4 to 7% of the tick, in line with the measured whole-tick numbers.
- The packed copy replaces the five WASM-side item arrays (xs, ys, kinds, nextItem, cellHead). Rows are laid out with `rowCap = max(64, 1.5 x widest row + 16)` slots. A row that outgrows its run triggers a full relayout (exercised by the new test, which crowds one row). At 50000 (125000 items, 156500 cells) the packed copy is about 1.4 MB against 2.3 MB for the old arrays plus the `dirtySlots` list, which is gone.
- `World.dirtySlots` is no longer needed and was removed. `dirtyCells` is unchanged.

## Checks

`ecoBench --seconds 30 --pop 600` 494818766, `--predators --seconds 40` 792910110, `--set eco.wasm=false` 672487632, `bench.ts --pop 300 --gens 12 --seed 2` 836727452, `--width 20000 --seconds 12` 545499697 and `--width 30000 --seconds 8` 875196102 equal to main, 50000 pop 600 818894933 equal to main. vitest 485 passed (`--maxWorkers=1`), including the exact-tie tests and a new test that moves items in and out of crowded cells and past the row capacity, comparing every ray with `Creature.sense`.

## Reproduce

Scripts are in the scratchpad `opt2/` (`cells_kab.sh REPS WIDTH plain|pred TICKS` for the kernel split, `cells_eab.sh REPS ecoBench-args` for whole ticks), comparing this tree with a `git archive` of main.
