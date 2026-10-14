# Collisions on sorted arrays, one path (redo of collide.md)

Branch `collide2`. `Ecosystem.sharedPhase`, `collideAll`, `bumpSlots`, `World.touchedBatch`, `World.firstItemWithin`, one test.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| One array-culled `collideAll` for all modes plus item lookups in cell order | 71.8 ms CPU/tick (Inland Sea, 9760 creatures, serial, median of 4) | 69.1 | 1.039x (4 alternating pairs, load 20 to 40; 70.3/72.6/72.6/71.0 vs 69.7/68.6/68.5/70.8) | yes: 739359978, 877945501, 410981010, Trials 727564408, Inland 830514026, also 3 helpers and collisionDamage on (138431295) | none (348 to 387 vs 337 to 381 MB) | +66 -21 source, +13 test | Merge |

Phases (ms/tick, load 20): collisions 5.16 to 0.92, eat 4.27 to 5.89 (now includes the one crowd rebuild, 2.3 ms, and the cell-ordered lookups), so eat plus collisions 9.4 to 6.8.

## What changed
- The moved positions are gridded once at the start of `sharedPhase` (eating moves no one), for lookups, `hunt` (which no longer rebuilds) and `collideAll`.
- `collideAll` culls pairs on the crowd's sorted `xs`, `ys` with `collide`'s own first test (NaN-safe). Only overlapping pairs go through `bump` on the creature objects, exactly as before (alive check, `collide`, `hurt`, `noteHurt`, `confine` with rock), and `bumpSlots` copies the two new positions back into the arrays. So hunters, collision damage and rock confinement share one path and no physics is duplicated. The velocities never leave the objects.
- `World.touchedBatch` looks up every creature's first touched item in cell order, using `firstItemWithin`, the grid walk that `eatAt` now also falls back to.

## Notes
- The old branch's second path is not needed: the gain came from not chasing `states[owners[t]]` for every candidate pair, not from array velocities.
- Source grew by 45 lines, not shrank: the old path's `bumpCell` went, the run-based sweep and batch lookup came.
- Left: eat 5.9 ms is the rebuild plus item list cache misses. A rebuild shared with the next tick's sensing grid would need positions after the move, which is this same rebuild: the sense phase of the next tick could reuse it if creatures did not move in between (they do not, but collisions and settle change positions), so no.
