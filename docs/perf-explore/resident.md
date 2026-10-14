| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Memory grown in eighths (`Kernel.ensure`), nothing else | 66.7 ms per tick (59.2 single-threaded) | 56.6 (54.8) | 1.18x (1.08x) | bit-identical | +10% (411 against 375 MB single-threaded, 346 to 419 against 341 to 372 otherwise) | 3 | Merge on its own |
| Creature bodies resident in WASM memory, step and fill kernels, on top of the above | 56.6 (54.8) | 45.9 (43.2) | 1.23x (1.27x) | bit-identical, probe disables it where libm differs | -24% against the growth fix alone (312 against 411 MB single-threaded) | 1270 (585 WAT, 685 TS) plus 161 test | Merge, see verdict |
| Both together, against development | 66.7 (59.2) | 45.9 (43.2) | 1.45x (1.37x) | bit-identical | -17% single-threaded (312 against 375 MB), -2% to -10% otherwise (333 to 335 against 341 to 372) | 1270 | |
| Steer only resident (first checkpoint, no fill kernel) | 65.9 | 61.9 | 1.07x | bit-identical | +17% | about 700 | Too small alone |

Inland Sea, 10000 creatures, serial, wasm on, 15 s, branch `resident` on `origin/development` (f1ebe53). Medians of cpuMsPerTick over 3 alternating rounds (base, growth fix, resident), load average 15 to 18. In brackets the same with `node --single-threaded` (3 rounds, load 11 to 12), which leaves out V8's helper threads (GC, compile) and so shows the main-thread cost. Without it the user CPU of all threads is counted, and the unpatched memory growth makes those helper threads busier, which is why the growth fix looks larger there. Fingerprints: Inland 830514026 in all runs of all variants.

## What is resident and who owns it
- One row of 320 bytes per `Creature` object, in the brain bank's WASM memory (`wasm/resident.ts`): x, y, vx, vy, energy, heading, turn rate, ticks alive, cos, sin, plan upkeep, ground factor, ray length, brain slot, ray count, offset-table and input addresses, output address, species block, 16 memory units. x, y and energy share the first cache line. A row belongs to its Creature for life (objects are recycled, rows are never freed).
- `creature.state` and `creature.heading` become one `ResidentState`: same fields as a plain `CreatureState`, as getters and setters on the row. Every JS reader and writer (eat, collisions, hunt, births, snapshots, saves, the Live server, `ecoState`, the UI) is unchanged. Trials, RL without kernels, landing and helper-thread worlds keep plain objects.
- Resident only when the Ecosystem has the WASM kernels and no journal (no helper threads). A start-up probe compares the kernel's sin, cos and exp with this engine's `Math` on 20000 inputs and leaves residency off on any difference, so a browser whose libm is not fdlibm keeps today's JS results exactly.
- Views of WASM memory die when it grows. `Kernel.onGrow` calls the store, which rebinds every state (two field writes each). Memory is grown in eighths so that this is rare.

## What runs where
- Per tick in JS: the crowd gather and sort, eating, collisions, deaths and births (births and settle read the rows directly through `rowAt[i]`, the crowd gathers x, y, energy from them with `Crowd.rebuildRows`). `Ecosystem` keeps the sense batch itself, `slotRows` and `slotSelves` in creature construction order, updated on spawn and remove, so a tick builds no per-creature batch and does no slot work (`kernels.attach(creature)` gives the brain its slot once, at spawn).
- `fill` (step.wat, replaces `WasmSenser.run`'s per-creature loop, about 10 ms): counting sort of the batch by item grid row, the 64-byte sense records, the brain input extras (fdlibm exp for the energy signal, speeds, turn, the ground lookup, units), the ground factor for the step, and the slot list of the brain run.
- `step` (replaces remember and `stepBody`, about 10 ms): fdlibm sin and cos, drag, ground, walls, rock with keepOut's clear-of-rock raster, energy, old-age upkeep. A heading beyond the port's range (about 8e5 rad) leaves the row unsteered and flags it, and JS steers it (tested).
- Species differ in config, so each row points to its species' parameter block, rewritten every tick (retune works).

## ms per tick by phase (profile runs, Inland, 9760 creatures)
| Phase | development | growth fix | resident |
|-------|-------------|-----------|----------|
| crowd grid | 2.7 | 2.5 | 2.4 |
| batch build, slots, adopt output | 1.8 | 1.5 | 0.04 |
| senser | 30.7 | 23.3 | 18.9 |
| brain forward | 12.0 | 10.8 | 10.9 |
| memory and steer | 10.8 | 8.8 | 3.9 |
| eat | 5.4 | 5.6 | 5.2 |
| collisions, settle, births, regrow | 2.4 | 2.2 | 2.5 |

First resident version (rows read through the state objects only) was no faster in the small phases: births 0.9 to 3.3, crowd grid 2.7 to 4.3, settle 0.5 to 1.0. Without the objects ahead of them in the cache the object reads of later phases miss. The `rowAt` loops, 64-byte aligned rows and putting energy next to x and y fixed that.

## Verification
- Fingerprints equal development: pop 600 739359978, `eco.wasm=false` 877945501, `--threads 3` 739359978, `--predators --seconds 40` 410981010, Inland 830514026, `bench.ts --pop 300 --gens 12 --seed 2` 727564408, aging on (agingStart 3) 418924465, rlBench 2101925694.
- The kernel's exp, sin and cos against this engine's `Math` on 6e7 inputs each (energy ratios down to -745, headings to 8e5 rad, near multiples of pi/4): 0 mismatches on Node 24.
- `tests/typescript/residentBodies.test.ts` (9 tests): on every tick of four worlds (plain, Inland with rock and ground, old-age upkeep, two species) the fill kernel's brain inputs equal `writeBodyInputs` and the step kernel equals remember plus steer, bit for bit; the JS fallback for huge headings; bodies across memory growth; rows, `rowAt`, `slotRows`, `slotSelves` through births and swap-removals; no residency with a journal; no residency when `Math.sin` differs. The comparison harness caught a real bug while building (species block not written before the first sense).
- Whole vitest suite: 922 of 923 pass. The one failure, `liveV2 selection cost` (100 viewers add under 10% to the tick), compares against the tick time. The tick is now 30% cheaper and the absolute cost of 100 viewers is unchanged (0.31 ms a tick), so it reads 15.4% where development reads 9 to 11% (it is borderline there already). The threshold needs to change with it.
- `tsc` clean. Kernel bytes: STEP module 6.9 KB of base64.

## Risk areas
- Memory growth invalidating views. Every cached `Float64Array` of the WASM memory must be taken after the last allocation of a call. Handled in the store (rebind), the stepper (views taken last) and `WasmSenser.run` (views retaken after `fill`). A new caller that caches a view across an allocation reads zeros from a detached buffer.
- Two parallel lists must follow members through spawn, swap-remove and restore: `rowAt` and `slotRows`/`slotSelves` (the latter needs a binary search per death). Tested, but it is new state beside `states`, `kinds`, `birthEnergies`.
- libm equality. Exact on Node (the Live server). On engines with another libm the probe turns it off, so the cost there is only the lost speed. Births still draw `Math.cos(heading)` in JS, which equals the kernel's where the probe passed.
- The settle shortcut assumes a creature that is not alive has no energy left (true today: hunt and hurt zero it).
- 16 memory units per row (the plan limit, 8 and 8); a larger plan throws in `fitUnits`.
- Addresses are i32, so the kernel memory must stay under 2 GB (as for the other kernels).
- Multi-value returns and saturating float-to-int conversion in the WAT need Chrome 85 and Safari 15.2, newer than the SIMD requirement.
- `liveV2` timing test (above).

## Verdict
Merge the growth step now (3 lines, 1.08x single-threaded, 1.18x on all-thread CPU, exact), and merge the resident bodies as a second change. It is the largest single-core gain left (1.27x on a 55 ms tick, 1.37x with the growth step), exact by test and by every fingerprint, safe by probe where libm differs, and it lowers RSS. The cost is 1270 lines (585 WAT, of which 176 are the sin and cos port and 90 the libm and ground ports that exist nowhere else) and one new concept, the row. There is no useful smaller variant: steer alone gave 1.07x, the gain comes from removing the per-creature object traffic of the sense fill and the slot and batch work, which needs the rows.

## New ideas, not tried
1. Crowd rebuild in the kernel from the rows (gather, cell keys, radix sort, cellStart) with the crowd arrays living in WASM memory. It is about 2.4 ms in the crowd grid, 2.5 ms in eat and 1.1 ms for the senser's copy, 5 to 6 ms of 43, and the row address list already exists.
2. The eat loop reads each member object (`m.species`, `m.creature`) for every creature although only eaters need it: use `kinds[at]` and touch the object after `touched[at] >= 0`. Exact, about 1 to 2 ms, and also valid without residency.
3. Find out why page-by-page `memory.grow` costs 4 to 7 ms per tick in steady state (at start 965 growths in 25 ticks). Reserving the arena up front from `maxPopulation` might do more than eighths and would show whether the cost is GC accounting of the detached buffers.
