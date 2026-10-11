# WASM exploration: move the rest of sense into WebAssembly

Branch `perf-explore-wasm` (worktree agent-a73a8a653fad3999a), prototype commit "Prototype: one-call WASM sense".
World 20000 x 12500 (prototype flags `--scale 1.6667`, now `--width 20000` on main), founders scaled by area. Normal-preset density gives about 4000 creatures (`--pop 1500`) and 9600 (`--pop 3500`). Tables below are from the prototype stage, the merge-ready numbers are at the end.
Machine load was 25-60 throughout, so wall time is unusable. Numbers below are user CPU ms per steady tick (`cpuMsPerTick`, new in ecoBench), A and B in alternating pairs, spread under 3%.

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| One-call WASM sense (dirs, item+wall rays, crowd rays, features written into brain input), serial, 4000 creatures | 46.3-48.0 ms (7 runs, median 46.8) | 33.6-36.5 ms (7 runs, median 34.3) | 1.36x | bit-identical fingerprint to the current WASM path | Recommended |
| Same, 9600 creatures, serial | 117.0, 120.0, 120.2 | 88.0, 88.2, 86.0 | 1.36x | bit-identical | Recommended |
| Same, 3 shared helpers, 4000 creatures (total CPU of all threads) | 59.7, 60.1, 58.9 | 46.4, 47.3, 45.4 | 1.28x CPU; wall 87-93 vs 70-78 ms but load 40 | fingerprint equal to serial and to the base path | Recommended |
| f64x2 SIMD over rays in the item-ray loop | 34.2-34.9 | 33.6-34.9 | none | bit-identical | Rejected, reverted |
| Collisions, motion, eating, crowd rebuild in WASM | not built | est. at most 12% of the remaining tick | n/a | collisions yes; motion needs sin/cos | Not worth it yet |

Also checked: fingerprints equal for the base and new path at 600 founders (20 s, and 60 s with 1881 births and structural mutation), for 2 shared helpers and 3 message helpers (471518118), and a vitest case compares both paths over 300 ticks. Existing ecosystem, ecoPool and wasm tests pass (one unrelated founders test timed out once under load and passed on rerun).

## What dominates at 20k+

Per-tick split of the current WASM path at 4000 creatures (timers around each loop, ms per tick, load inflated: total 113 ms wall):

| Part | ms | Share |
|------|----|-------|
| item and wall rays + ray directions (JS `senseWorld`) | 33.5 | 30% |
| `encode` (RayHit objects to Float32 input, then copy into WASM) | 16.9 | 15% |
| brain forward (WASM) | 15.3 | 14% |
| queue crowd rays (JS to WASM staging) | 8.1 | 7% |
| remember + steer (JS, `Math.cos/sin`) | 8.7 | 8% |
| eating, deaths, births, regrow | 9.8 | 9% |
| collisions | 6.4 | 6% |
| crowd rays (WASM) + apply back to objects | 4.1 + 2.5 | 6% |
| outputs copy, slot lookup, crowd rebuild | 3.1 + 1.2 + 1.8 | 5% |

So about 80% of a tick is JS, and only about 18% is in the two existing kernels. Most of the JS cost is not arithmetic but object traffic: one `RayHit` per ray per creature written by the item pass, read by `queue`, rewritten by `apply`, read again by `encode`, then copied into the brain's input.

## What was built (the best candidate)

`sense.wat` + `senser.ts`. One WASM call per batch does, per creature: ray directions by angle addition, item and wall rays, crowd rays (the existing f32 code), and writes the ray features straight into the brain input vector in the brain bank's memory (the module imports the bank's memory). JS still writes the 4 extras and the memory units (cheap scalar stores, and it keeps `Math.exp` out of WASM: the energy signal of every crowd slot is computed once per tick in JS into a table that WASM indexes).
Per tick the whole item grid (xs, ys, kinds, cellHead, nextItem, about 300 KB at 20k) and the crowd arrays are copied into WASM memory. That costs tens of microseconds and needs no change to World or the journal.
Per-creature ray offset cos/sin tables are stored once per brain slot, refreshed with the brain.
The `RayCache` anchored list is not used by sense any more. WASM walks the grid cells and filters by distance and wedge, which gives the same candidates in the same order as the cached list (the list is the grid walk in cell order, filtered by a superset radius). `eatAt` then falls back to its own grid walk, which is the same result by its own comment.

## Precision rules (how exactness holds)

- The existing kernels do not match the JS path. Brain sums and crowd rays are f32 (max abs diff about 1e-7 for outputs, rare grazing-ray kind flips), so `eco.wasm` true and false give different fingerprints, and a test asserts that. The bar that is kept is: WASM path fingerprint stays equal across helper counts, and across this change.
- The new kernel keeps every operation of the old WASM path: item and wall rays in f64 with the same expression order, crowd rays in f32 from the same f64-to-f32 conversions (positions, directions, `(1 - closeness) * L` start distance, `L` and radius), closeness `1 - best / L` computed as before, features stored to f32 by round-to-nearest demotion exactly as a `Float32Array` store.
- WASM has no fused multiply-add outside relaxed SIMD, and `f64.sqrt`, `/`, `floor` are IEEE exact, so f64 code in WASM equals V8's. JS `Math.exp`, `sin`, `cos` have no WASM instruction. Exp stays in JS (per creature and per crowd slot, not per ray). Sin/cos are used by `stepBody` for the heading, so motion cannot move without porting V8's fdlibm sin/cos bit for bit.
- Tie rule kept: an item at equal distance to the wall wins (`t === best && kind === wall`), and among equal items the first in grid order wins.
- Creature order does not matter (each result depends only on the creature and the snapshot), so helper counts agree. Verified with fingerprints.

## Gaps before this could merge

1. `creature.rays` (RayHit objects) and `brain.activations[0]` are no longer filled in the batch path. The UI draws the selected creature's rays and brain input from them. Fix: for the selected creature only, run the old JS `sense` and `encode` after the tick (display only, small).
2. Tests for edge cases: creature outside the grid, plans with 1 ray, odd ray counts, ray count over 62 (now throws), Trials config (stride 4).
3. (Done) the `SenseKernels.full` / `SENSE_FULL` prototype switch is gone, `run` is the one-call path.
4. `World` cell/cols/rows/width/height/itemRadius/cellHead/nextItem went from private to public readonly.
5. The old `rays.wat` and `rayKernel.ts` become unused by the Ecosystem (about 280 lines could go), except `cast` is duplicated into `sense.wat` now.

## Code cost

Prototype stage: `sense.wat` 288 lines, `senser.ts` 167 lines, about 60 lines of glue, one test. See the merge-ready section for the final count.

## Promising but untried

- Predators and prey: rays that see creatures with energy and contacts get more expensive with density. This kernel already does the crowd part in WASM with the energy signal table, so the extra per-ray fields (species) would be one more table lookup. Gain should hold or grow with density (9600 creatures gave the same 1.36x).
- Item grid candidates for rays are about 4 ms of the 34 (measured by skipping the trace loop). f64x2 over rays gave nothing.
- Next biggest JS parts after this change (profile): `finishTick` remember+steer 9% (needs sin/cos port, about 150 lines of fdlibm in WAT, must be tested bit for bit against `Math.sin/cos` over millions of inputs), crowd rebuild twice per tick 3.4% (counting sort, easy in WAT), collisions 4% (f64 + sqrt only, grid order, portable and exact), eating 3.5%, `SenseKernels.run` outputs copy 3.6% (could read outputs in place if `Creature.output` became a view into WASM memory).
- Putting creature state in WASM-resident SoA (so no per-tick record fill, 5% `senser.run`) is a large refactor of `CreatureState` users and was not tried.
- Collision, motion and the rest together would bring the JS share from about 55% to maybe 25% but is mostly gated on the sin/cos port.

## Files

Prototype (merged since): `src/typescript/src/sim/wasm/sense.wat`, `senser.ts`, `senseKernels.ts` (`run`), `src/typescript/src/ecoBench.ts` (`cpuMsPerTick`). Reproduce against main: `cd src/typescript && nice -n 15 node src/ecoBench.ts --seconds 12 --width 20000` on both and compare `cpuMsPerTick`; fingerprints must match (52683040).

## Merge-ready update (after merging main e17cba7)

- Merged main (block stamps, wall skip, parallel helpers, sortBySlot, poison damage, seasons). The kernel's candidate order is still the grid walk order, which the cached list keeps, and the wall skip is mirrored (walls computed only within L x (1 + 1e-6) of an edge; it never changes a result).
- `Ecosystem.detail` (set by `EcoRunner` to the selected id) names the one creature whose `rays` and brain input are read back after each batch (`SenseKernels.detail`, rec word 14 in `sense.wat`). Consumers checked: `selectedDetails` in ecoRunner (rays and `layerActivations()[0]`), the brain panel (same input), `episode.ts` and `ui/scene.ts` (Trials, JS path, unchanged). With helper threads the existing `watch` already puts the selected creature in the coordinator's batch. A creature selected mid-tick shows last tick's rays until the next tick.
- Deleted `rays.wat`, `rayKernel.ts`, `Creature.queueCrowd`, the ray half of `wasmBench.ts`. Net source growth vs main is about +210 lines (`sense.wat` 305 + `senser.ts` 185 - 281 removed - small glue).
- Extension point for Predators and prey: the crowd feature path is the merge loop at the end of `sense.wat` (hit crowd slot `$k`, per-slot f32 table `sig` filled in `senser.ts`). A species flag or other per-creature feature is one more per-slot table indexed by `$k`, plus its stride in the feature write.
- Tests: `wasmKernels.test.ts` compares the kernel with `Creature.sense` for corners and walls, 360 degree fan, one ray, zero rays, an item at the ray length and a hair either side, item removal and placement between runs, and crowds (within f32 rounding). Helper counts 1 and 3 by fake ports, message and shared workers are in `ecoPool.test.ts` ("give the same run for any helper count and mode").
- Measured at width 20000 against main: see `docs/perf-notes.md` E5d.
- Review fixes: `Ecosystem.refreshDetail()` runs a display-only JS sense and encode for the selected creature on select (also while paused). Configs with more than 64 rays (setting, range or pool entry) make `SenseKernels.create` return null, so those runs use the JS path (exact, no throw). The seen-energy scale and ray feature count come from the config passed to `create`, not from a creature. Tie-order tests (different cells, same cell) and a pinned 300-tick WASM fingerprint (746480886, equal to main e17cba7) guard "same as main".
