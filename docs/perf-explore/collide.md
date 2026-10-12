# Collisions and eat on gridded arrays

Branch `worktree-agent-a002d1fe840d1071e`. `World.touchedBatch`, `Ecosystem.gridMoved` and `collideGridded` in `ecosystem.ts`, plus one test.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Grid moved positions once, item lookups in cell order, collisions on the sorted arrays (no hunting, no collision damage) | 81.6 ms CPU/tick (50000 wide, 9.7k creatures, serial) | 77.8 | 1.048x (3 alternating pairs, load 18; 81.2/81.6/81.7 vs 78.4/77.8/75.7) | yes, all 4 fingerprints | none (334 vs 330 MB) | +178 source, +14 test | Merge |
| Fuse the state gather into the steer loop | gather 0.47 ms/tick | | | | | | Not built, at most 0.4 ms |
| Counting sort instead of 2-pass radix in `Crowd.rebuildFrom` | 2.3 ms per rebuild (10k, 156k cells) | 2.5 | 0.9x | yes | | | Rejected, the O(cells) prefix pass costs 1 ms |

Phase split (ms/tick, 50000 wide): eat plus collisions 11.4 before, 7.7 after. Now: gather 0.5, crowd rebuild 2.5, lookups 2.8, eat loop 1.1, collisions 0.85.

## What changed
- Without hunters the moved positions are gridded once before the eat loop (the old code did it in `collideAll`). Eating moves no one, so the grid serves both.
- `World.touchedBatch` looks up the first touched item of every creature in cell order (same walk as `eatAt`, items only read). The eat loop then uses it through the existing `touched` protocol, which re-looks-up items taken earlier in the loop. Skipped when helpers pass `touched`.
- `collideGridded` runs the same pairs in the same order with the same arithmetic on the crowd's sorted x, y and list-order vx, vy. The rest of a cell and the cell to the right are one run, the three cells below another. Only creatures that touched are written back. Hunting and collision damage keep the object path (`collideAll`).
- Collisions 5.4 to 0.85 ms. The saving is the pair walk through objects (`bump`, `collide`), not the gather: gathering x, y, vx, vy of 10k creatures costs only 0.5 ms.

## Where the rest is
- Item lookups 2.8 ms are cache misses on the item linked lists (xs, ys, nextItem at random slots, about 1.4 items per lookup). The packed rows of the WASM sense would fix that but carry no slot ids; adding ids is maybe 2% of a tick.
- The births scan in `sharedPhase` walks every creature object (EcoCreature, creature, state, birth) and costs 1.2 ms/tick; a typed mirror of energy and birth threshold would cut it, but must follow swap-removal. Settle loop 0.5 ms.

## Checks
`ecoBench --seconds 30 --pop 600` 847633506 (also `--threads 3`), `--set eco.wasm=false` 204227508, `--predators --seconds 40` 303607739, `bench.ts --pop 300 --gens 12 --seed 2` 121151891, 50000 wide 10 s 859442980 equal on old and new path. New test compares the gridded path with the per-pair path (damage 0) in a crowded 300 x 300 world, with and without WASM; it fails with a 0.05% change of the push distance.

Orchestrator verdict (2026-10-12): held, not merged. The gridded path duplicates the collide, keepInside and eatAt arithmetic in a second code path for 1.048x, and the obstacles change (#34) adds rock confinement to collisions, which this copy would also need. Revisit only as a single array-based collision path that replaces collideAll.
