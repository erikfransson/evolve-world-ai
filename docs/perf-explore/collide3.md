# Collision sweep, third look (idea 51)

Exact, no code kept. Branch `pl-collide` from `perf-live` 3d33e82, only this file. Verdict: rejected, the phase has no 1% to give.

## Where the phase goes

Collisions phase (CPU, `--profile`): 0.23 ms at 3300 mixed, 0.35 ms at the cap (4900 Juggernauts). The profile timer itself costs 0.04 ms per lap (a `sweep` that returns at once reads 0.040), so the net phase is about 0.19 and 0.31 ms (1.3% and 1.7% of the tick).

Per tick: 3300 occupied cells for 3300 creatures (cell 100, radius 12, reach 24), so the grid is nearly one creature per cell. Mixed: 374 pair tests, 2.5 pairs in contact. Cap: 800 tests, 16 to 24 in contact, 4760 occupied cells. Crossings into WASM: 3.5 (mixed), 17 to 25 (cap).

Split by variants of the sweep in the live tick (mixed, net of the 0.04 timer):

| Part | ms |
|------|----|
| cell loop, all cells, reads of `cellStart` for the neighbour runs, no pairs | 0.12 |
| pair loops of the cells that have a neighbour (about 10% of cells) | 0.10 |
| JS bump per contact (`collide`, `keepInside`, `keepOut`, copy back), median 4 to 8 us | 0.02 at 3300, about 0.08 at the cap |

A warm loop (same sweep 3000 times on one grid) gives only 0.11 ms per call, because the branch predictor learns the sequence and the grid stays in cache. In the tick the cell loop is cold (about 36 ns a cell), so micro-benchmarks of the sweep mislead; only in-tick `--profile` numbers were used.

## Tried (all exact, fingerprints equal to base on 10 s and 30 s runs)

| Variant | Mixed phase | Cap phase | Note |
|---------|-------------|-----------|------|
| base | 0.229 / 0.234 / 0.223 | 0.345 / 0.346 / 0.350 | |
| cell row from a moving `rowEnd` instead of `div_u` | warm 108 vs 110 us | | no effect |
| runs from the occupied list with a forward pointer, no `cellStart` | warm 160 vs 110 us | | slower, data dependent loops mispredict |
| bitmap of occupied cells (19.6 KB, written in `rebuild`), skip a cell alone in its 2x2 neighbourhood, `occStart` for cell ends | 0.231 / 0.230 / 0.244 | | prelude 0.12 to 0.06, but the work cells then pay the cold `cellStart` misses one by one; total unchanged |
| same plus runs from the occupied list (`cellStart` no longer read) | 0.210 / 0.215 / 0.270 | 0.380 / 0.392 / 0.399 | about 0.02 better at 3300 (within noise), 0.04 worse at the cap |

## Why it stops here

- What is left is mostly branch mispredictions and cache misses spread over the 10% of cells that have a neighbour (about 220 ns each) and over the cell loop itself. Both are data dependent, with no exact shortcut that keeps the pair order.
- Skipping the copy-back is already done (only touching pairs are written), and host crossings are 3.5 a tick (17 to 25 at the cap, 0.4 us each, under 0.01 ms).
- Even a free sweep would save 0.19 ms at 3300 (1.3%) and about 0.2 ms at the cap (1.1%), and no variant removed more than a tenth of that. The bar of 1% at the cap is out of reach.

Possible but not tried (expected under 0.03 ms): per-word rank table of the occupied-cell bitmap to find neighbour runs without loops (a branch-free work path).

## Checks

Base liveBench 60 s `--profile`: cpuMsPerTick 14.41, fingerprint 708687555, peakRssMB 215, collisions 0.240. No source change is kept, so the kernel tests were not re-run on this branch.
