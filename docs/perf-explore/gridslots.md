# Crowd grid reuse and the slots phase

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Derive the tick-start crowd grid from the eat-time grid (patch deaths, births, bumps, energies) | rebuild 1.65 ms per call (load 15 probe) | not built | at most 0.5 ms of 48 (1%) | would be exact with effort | none | est. 120+ | Rejected: bound too small for the risk |
| `GroundField.seal`: per raster cell kind table so `valueAt` skips the corner tests for non-mixed cells | slots 1.76 / 1.89 / 1.98 / 1.94 / 2.73 / 2.75 ms | 1.72 / 1.83 / 1.90 / 1.72 / 2.56 / 2.66 | median -0.085 ms (0.2% of a tick) | yes, 830514026, groundScene and maps tests pass | +100 kB (one byte per raster cell) | about 30 plus a 25 line test | Rejected: inside the noise of cpuMsPerTick |
| Fuse prepareRows with stepRows | not built | | | not exact | | | Not possible (see below) |

Six alternating pairs, Inland bench (10000 creatures, 15 s, serial, wasm on), load 5.5 to 6 for the first three and about 8 for the rest. cpuMsPerTick pair medians were within noise (35.98 / 35.79, 37.22 / 36.67, 36.75 / 33.81, 33.62 / 34.10, 47.86 / 47.38, 48.04 / 47.98).

## Grid findings

- Between the eat-time grid (built after the step, before eating, hunting, collisions, deaths and births) and the next tick-start grid, a probe over 350 ticks (9860 creatures) found: 98.2% of positions identical (about 185 creatures are new or were bumped), energies equal for all but about 11, order of the unchanged ones preserved. But the owner index differs for 45% of the sorted slots, because every death and birth shifts the sorted positions, and swap-removal changes the index of the creature moved into the hole, which changes its place among its cell mates.
- A patched grid still has to rewrite all five sorted arrays (a merge pass) and all of `cellStart` (any insertion shifts every later start). Rebuild stages per call (load 15, so pessimistic): row gather 0.24 ms, cell keys 0.30, radix sort 0.30, sorted-array write plus `cellStart` gaps 1.04. Only the first three, 0.84 ms, can be avoided, and a merge costs about 0.3 ms back. Energy refresh needs dirty tracking in eat, hunt, hurt and birth, or a gather over all rows, which is the cost being avoided. Net at most about 0.5 ms per tick, about 1%.
- The end-of-tick grid is not even a snapshot of the final state: it is built before collisions, so bumped creatures differ in position, and hurt/eaten/born ones in energy.

## Slots findings

- "slots" is `prepareRows` plus `brains.runRegion` (a constant-time call); `slotRows` is maintained already. Per creature: `Math.exp` (about 0.3 ms per tick), `GroundField.valueAt` (about 0.6 ms before the kind table), and the row reads and writes (0.5 ms with both removed, cold). The ground and exp are both functions of state that changes every tick (energy by upkeep, position by motion), so neither can be cached, and exp must stay the engine's own.
- Fusing with `stepRows` is not exact: energy, positions and velocities change after the step (eat, hunt, bump, damage, births), and prepareRows must read the final values. Fusing it into the fill kernel needs `exp` in WAT (the fdlibm port the lite resident variant dropped).

## New ideas, not tried

1. Cell keys in the same loop as the row gather in `rebuildRows` (one pass less over px and py), about 0.1 ms per call, exact.
2. `cellStart` gap fill (about 0.5 ms of each rebuild) by a Uint8 occupancy bitmap plus a prefix count at read time was rejected before; a WASM `fill` of the gaps may still win.
