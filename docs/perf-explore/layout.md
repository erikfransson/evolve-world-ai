# Memory layout and cache locality at 20k+ width

| Idea                                                      | Before (CPU ms/tick)  | After     | Speedup       | Exact?               | Verdict                    |
|-----------------------------------------------------------|-----------------------|-----------|---------------|----------------------|----------------------------|
| Sense batch in creature construction (heap) order, serial | 66.2                  | 60.3      | 1.10x         | bit-identical        | Kept on branch, 33 lines   |
| Same, 2 shared helpers (process CPU / wall)               | 77.3 / 108            | 71.8 / 94 | 1.08x / 1.15x | bit-identical        | Kept                       |
| Sense batch in spatial (crowd grid cell) order            | 64.4 (list order)     | 66.7      | 0.97x         | bit-identical        | Rejected                   |
| Sense batch in random order (diagnostic)                  | 64.4 (list order)     | 68.7      | 0.94x         | bit-identical        | Shows order matters 6-10%  |
| Reorder the member list itself (spatially)                | n/a                   | n/a       | n/a           | would change results | Not tried, see below       |
| GC tuning or allocation removal                           | 0.2-0.3 ms/tick GC    | n/a       | under 0.5%    | n/a                  | Not worth it               |

Setup: 4167 creatures in a 20000 x 12500 world at steady turnover (6.5 births and deaths per tick), 200 ticks after 600 warm-up ticks, medians of 3-4 alternating pairs, CPU = process user CPU per tick. Machine load was 45-55, so wall times swung +-15% between repeats while CPU times stayed within +-3%; only CPU is trusted.
The turnover setup is a throwaway bench script (birthEnergy 60, birthCost 25, childEnergy 25, cooldown 3 s, food regrow x2). Normal-preset runs start with list order equal to heap order, where nothing can be gained, and need hours of simulated time to churn.
`ecoBench.ts` gained `--width/--height` (founders scale with area) and `cpuMsPerTick`.

## What dominates at 20k+

Profile (2778 creatures, serial, WASM): item rays `World.castRays` 17%, `SenseKernels.run` self 13% (item gather, queueing), WASM kernels about 14%, `sharedPhase` 7%, `encodeInputs` 6%, `finishTick` (remember and steer) 4%, crowd rebuild 3%, GC 1.7%.
Working set per tick: brain weights 12 MB (2778 creatures, mean genome 1100 floats) plus the WASM copy, plus per-creature ray caches and state, so roughly 25-40 MB against a 12 MB shared L3 (L2 1.25 MB per core).
The item grid is small (17500 items, about 300 KB) and fits L2, so item-grid storage order cannot matter at this density, and spatial order helps nothing: neighbours only share that small structure.

## What was found

1. Sensing and thinking write only the creature's own data, so their order is free. Fingerprints are identical for list, spatial, random and heap order, serial and with 2 shared helpers.
2. Order still costs time. Per-creature data (brain weights in the WASM bank, ray cache arrays, state, input and output buffers) is allocated in construction order. After births and deaths the member list (swap-removal, recycled objects) no longer follows that order and walking it jumps through memory. Random order costs +7% CPU over list order, heap order saves 10%.
3. Spatial order is no better than random. The per-creature streams dominate, not shared structures.

## Prototype

`Creature.slot` (construction counter) and `SenseBatch.sortBySlot()`, called at the top of `senseThinkBatch`: one native `Float64Array.sort` of packed keys (slot * 2^22 + position) per tick, about 4000 keys, well under 1 ms. It covers the serial path, the coordinator's own share and each helper (helpers have their own Creature objects, so their slot order is their own heap order). 33 lines in `creature.ts`, nothing else changed.
Exactness: ecoBench width 20000, 8 s: fingerprint 530577184 serial and with 2 shared helpers; JS path (`--wasm false`) 829893343 with and without the sort. The churn bench gave 253823103 for serial and 2 helpers, sorted and unsorted.
WASM brain slots are handed out on first sight, so slot order also walks the WASM brain bank front to back. That is probably most of the gain, but it is not separable here.
Not run: vitest (no node_modules in the worktree).

## Promising but untried

- Real struct-of-arrays: state x, y, vx, vy, energy in typed arrays indexed by list position and ray caches in one arena with fixed stride. Removes pointer chasing (about 15 typed arrays per creature, each a header plus backing store) and makes locality explicit instead of depending on V8 heap order. Large refactor (`CreatureState` is used by physics, ecoShare, UI), expected gain at best similar to the 10% above.
- Reordering the member list spatially changes eating and birth outcomes (both walk the list from a random start), so it is exact only if those walks go through a separate fixed-order index. Spatial order showed no gain, so not worth it.
- Smaller per-creature caches (RayCache starts at 32 doubles x 5 arrays plus candidates; most creatures see far fewer items).
- Predators and prey: creature rays already read the crowd's cell-sorted contiguous arrays (4000 x 4 doubles), so no layout work is needed there.

## GC

`--trace-gc`, 500 ticks at 4167 creatures: 23 scavenges of 3-7 ms (one per about 22 ticks, 0.2-0.3 ms per tick, under 0.5% of a tick) and 3 mark-compacts. Allocation is about 2.8 MB per tick (genome slices at birth, journal arrays). No pause is visible at tick scale. Left alone.
