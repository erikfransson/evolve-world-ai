| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Resident rows, physics in JS on the row arrays, fill kernel only moves data (`resident-lite`) | 54.9 ms per tick single-threaded (53.5 all threads) | 48.1 (48.8) | 1.14x (1.10x) | bit-identical, every fingerprint, same Math as today | -7% (331 against 356 MB, independent measurement) | 750 production (91 WAT) + 132 test | Recommended |
| Same with step, exp, ground and keepOut in WAT, fdlibm ports and a probe (`resident`, reviewed) | 54.9 (53.5) | 44.2 (44.5) | 1.24x (1.20x) | bit-identical on Node, probe turns it off elsewhere | -24% (313 MB) | 1270 production + 161 test | Larger, two languages for the physics |

Inland Sea, 10000 creatures, serial, wasm on, 15 s, development a561bed (memory growth in eighths already in). Medians of cpuMsPerTick over 3 alternating rounds of the three variants, `node --single-threaded` (load 11 to 15) and then with all threads (load 11 to 14). Fingerprint 830514026 in every run.

## Design (lite)
- One row of 192 bytes per `Creature` in the brain bank's WASM memory (`wasm/resident.ts`, offsets in `wasm/layout.ts`): x, y, vx, vy, energy, heading, turn rate, ticks, cos, sin, upkeep, ground factor, ray length, the five brain input extras, and the i32 fields the fill kernel needs. The memory units sit in a block of their own, so a plan may have any number of them.
- `creature.state` and `creature.heading` are one `ResidentState`, getters and setters on the row, so every JS reader and writer is unchanged. Only an Ecosystem with the WASM kernels and no journal (no helper threads) makes resident creatures. Trials, RL without kernels, landing and helper worlds keep plain objects.
- Layout has one source: `layout.ts`. `scripts/wasmAssemble.ts` substitutes its numbers for the double-brace tokens of `fill.wat`, and the TypeScript reads the same table.
- `Ecosystem` keeps the sense batch itself (`slotRows`, `slotSelves` in creature construction order, updated on spawn and remove) and `rowAt` (member index to row), so a tick builds no per-creature batch and does no slot work (`kernels.attach` gives the brain its slot once at spawn).
- Per tick: `prepareRows` (JS, `wasm/residentStep.ts`) writes the brain input extras and ground factor into the rows with the engine's own `Math.exp` and `GroundField.valueAt`; `fill` (WAT, 91 lines) sorts the batch by item grid row, writes the sense records and copies the extras and units as f32; sense and brain run as before; `stepRows` (JS) does remember and `stepBody` on the row arrays, with `physics.keepInside` and `terrain.keepOut` on a scratch body. Crowd gather, births and settle read the rows through `rowAt`.
- Views of WASM memory die when it grows. `Kernel.onGrow` makes the store rebind every state (two field writes each).

## ms per tick by phase (profile runs, 9760 creatures)
| Phase | development | lite | full |
|-------|-------------|------|------|
| crowd grid | 2.5 | 2.5 | 2.4 |
| batch build, slots, adopt output, prepare | 1.5 | 2.9 | 0.04 |
| senser | 23.3 | 18.3 | 18.9 |
| brain forward | 10.8 | 11.3 | 10.9 |
| memory and steer | 8.8 | 7.2 | 3.9 |
| eat | 5.6 | 5.5 | 5.2 |
| collisions, settle, births, regrow | 2.2 | 2.6 | 2.5 |

The JS physics costs 3.3 ms more than the WAT step, and the JS input extras 2.9 ms more than the WAT fill. That is the whole difference between the variants. The sense fill (10 ms of object traffic) and the slot, batch and adopt loops are what the rows remove, and both variants get that.

## Verification
- Fingerprints equal development: pop 600 739359978, `eco.wasm=false` 877945501, `--threads 3` 739359978, `--predators --seconds 40` 410981010, Inland 830514026, `bench.ts --pop 300 --gens 12 --seed 2` 727564408, aging on (agingStart 3) 418924465.
- `tests/typescript/residentBodies.test.ts` (8 tests): on every tick of four worlds (plain, Inland with rock and ground, old-age upkeep, two species) the fill kernel's brain inputs equal `writeBodyInputs` and `stepRows` equals remember plus steer, the ground factor included (the harness no longer overwrites it); a plan with 20 or more memory units; bodies across memory growth; rows, `rowAt`, `slotRows`, `slotSelves` through births and swap-removals; no residency with a journal.
- Whole vitest suite: 922 of 922. `tsc` clean.

## Review fixes in this branch
Units outside the row (no limit, tested), one layout table, no hand-copied offsets, no fdlibm ports, probe or bad-heading path, no raster cell constant, settle called for every creature that is out of energy (the row only counts the tick of those that are not), one writer of the ground factor (`prepareRows`), no per-batch allocation in `SenseKernels.run`.

## Risk areas
- Memory growth invalidating views: every cached array of the WASM memory must be taken after the last allocation of a call (store rebind, fill kernel, `WasmSenser.run` retakes its views after `fill`).
- Two parallel lists follow members through spawn, swap-remove and restore (`rowAt`, `slotRows`/`slotSelves`, the latter with a binary search per death). Tested.
- Addresses are i32, so the kernel memory must stay under 2 GB, as for the other kernels.
- The sense record, brain input extras and the extras' order are a contract between `residentStep.ts`, `fill.wat` and `Creature.writeBodyInputs` (the parity test guards it).

## Verdict
Take the lite variant. It keeps 1.10 to 1.14x of the 1.20 to 1.24x for 520 fewer lines and one language for the physics, exact on any engine because it uses the engine's own Math. If the last 10% is wanted later, step, exp and ground can move to WAT behind the same rows (branch `resident`), at the price of the fdlibm ports and the start-up probe.

## New ideas, not tried
1. Crowd rebuild (gather, cell keys, radix sort, copy into the senser) in the kernel from the row list: about 5 ms of 48.
2. The eat loop reads every member object for the species although only eaters need it: use `kinds[at]`, exact, about 1 to 2 ms, valid without residency.
3. `stepRows` and `prepareRows` in one pass over the rows (energy and position are not final until the shared phase, so only the step's own reads can fuse); or sort the batch so rows are visited in memory order for the item grid lookups.
