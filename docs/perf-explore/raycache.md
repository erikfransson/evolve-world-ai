# Item candidate cache in the sense kernel (idea 28)

Exact, but slower. Branch `pl-raycache`, base `perf-live` 4ad0f84 (later perf-live commits are docs only).

## What

Each resident row gets a cache of whole item cells: every item of every cell of the walk window grown by `0.1 L` per side, copied in walk order (row, cell, list order) with its cell and candidate kind (12 bytes per entry, 32 entries, 388 bytes per row).
The header (build version, packed window, entries address) sits in row bytes 180-191, the line the fill kernel just read.
`WasmSenser.syncItems` stamps the 4 x 4 cell block of every dirty cell with a new version (a module-wide clock), and a full rewrite of the packed rows sets an epoch that voids every older cache. `World.load` now drops `dirtyCells`, so a loaded world forces that rewrite.
On a hit the kernel filters the cached entries to the walk window's cells and runs the walk's arithmetic and tests on them. A miss rebuilds, and an overflow (more than 32 items or a window over 31 cells) walks the grid as before.

## Why it is exact

An entry of cell c is used only when c lies in the current walk window. The cached window holds the walk window, so every cell of the walk window is in the cache, all of its items, in packed order.
Cell c's packed run changes only through `setItem` or `unlink` (both mark c dirty, so its block gets a version above the build) or through a full rewrite (epoch).
Only the walk window's blocks are checked, which is enough: cells outside it are not used, and are checked when a later window covers them.
Filtering keeps the cached order, so the candidates come out in the walk's order, with the same f32 positions and the same f64 arithmetic.
Brain inputs of all creatures hash equal to the base kernel (b101b365 at tick 400, 50357cc0 at tick 1500, inputs poisoned with NaN first), and the fingerprint is unchanged (708687555).

## Counts (instrumented run, 4 founders x 800)

| Slack | Hit rate | Rebuilds | Items per build | Builds over 32 items |
|-------|---------:|---------:|----------------:|---------------------:|
| 0.1 L | 94.8%    | 5.2%     | 9-11            | 0.0-0.1%             |
| 0.3 L | 95.6-96.1% | 3.9-4.4% | 9-14          | 0.5-1.1%             |
| 0.6 L | 96.0%    | 4.0%     | 17-21           | 7-9%                 |

Almost every rebuild comes from a changed block, not from movement, so slack 0.1 was chosen.

## Kernel (snapshot harness of `senselive.md`, cold, memory restored before each call, p25 ms)

| Variant | t400 | t1500 |
|---------|-----:|------:|
| base | 4.51 | 3.83-3.91 |
| cache, header and entries in a private block (v1) | 4.63 | 4.01 |
| cache, header in the row, rows touched as fill would leave them (final) | 4.86-4.94 | 4.19-4.26 |
| same, entries also warm (a prefetch in fill) | 4.94 | 4.17 |
| 8 x 8 blocks instead of 4 x 4 | 4.92 | 4.26 |

Breakdown at t400: the walk plus all item tests cost 2.70 ms (base minus no-walk), the cache filter plus the same tests cost 2.51 ms. So even a free validity check would save about 0.2 ms, about 1.3% of the tick. The check, the 5% rebuilds and the extra code cost about 0.6 ms on top.
The walk is cheaper than it looks because records are sorted by grid row: neighbouring creatures read the same packed rows, which stay warm. Per-creature caches give that sharing up.

## Whole tick (liveBench `--profile`, 60 s, alternating pairs)

| Case | Base cpuMsPerTick | Yours | Base senser | Yours senser |
|------|-------------------|-------|-------------|--------------|
| 4 founders x 800 | 13.09, 10.03, 13.06 (med 13.06) | 13.46, 10.31, 13.28 (med 13.28) | 4.84, 3.64, 4.82 | 5.11, 3.81, 5.00 |

Ratio of medians 1.017 (slower). Senser +0.17 to +0.28 ms in every pair. Fingerprint 708687555 in all runs, peak RSS 213-218 vs 218-220 MB.
Juggernaut x 4900 pairs: see the final report.

Memory: 388 bytes per row, 1.9 MB at 5000 creatures, plus 40 KB of block stamps.

## Tests

New `wasmKernels` test: brain inputs with the cache equal those of the walk over 60 rounds of moves (some past the slack and across cells), eating, regrowth and a cluster larger than the cache, run twice per round. It goes red without the stamps and without the window containment checks (x and y tested). `wasmKernels thinkEvery residentBodies wasmStep`: 65 passed.

## Verdict suggestion

Reject. Exact and tested, but 1.7% slower on the tick, and the bound for a perfect cache is about 1.3%, below the 3% bar.
