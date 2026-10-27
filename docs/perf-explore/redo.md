# Work the tick repeats (idea 34)

Exact, about 2% faster at the cap and 1.5-2.5% at 3300. Branch `pl-redo` from `perf-live` 9a0334b. Built: the energy signal once per creature (candidate 1). Everything else in the audit is below 1% or not a repeat.

## What

`prepareRows` computed `1 - exp(-energy / startEnergy)` in JS per creature for its own brain input, and the crowd kernel's `pack` computed the same value (as f32) for what others sense. With one start energy for all species the two are the same number: the fill kernel narrows the own value to f32, and pack stores `fround` of it.

- `crowd.wat` `pack`: new call-block field `C_SIG_ROWS`. When set, pack also stores the f32 signal, promoted to f64, into the row's first extra (`R_EXTRAS`), reaching the row through `rowAt[owners[k]]`.
- `senser.run` passes the flag to `pack`; `senseThinkRows` passes `signalDone` to `prepareRows`, which then skips the JS exp. Order holds: `prepareRows`, then in `run` pack, then fill.
- Gate `SenseKernels.packsOwnSignal(crowd)`: the crowd is the WebAssembly one (rows in the same memory) and every species' `startEnergy` equals `seenEnergyScale`. Otherwise (JS crowd, helper threads, species with different start energies) `prepareRows` computes it as before.
- The exp stays the engine's own `Math.exp`; pack's f32 rounding is unchanged. With `thinkEvery > 1` pack still runs for the thinking subset only, and the extras of the others are not read.

## Whole tick (liveBench `--profile`, 60 s, nice 19, 3 alternating pairs, load 8-12)

| Case  | Build | cpuMsPerTick                        | slots ms (prepareRows)  | senser ms            | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|-------------------------|----------------------|---------------|-------------|
| mixed | base  | 12.848, 9.748, 12.667 (med 12.667)  | 1.038, 0.722, 1.035     | 4.84, 3.62, 4.77     | 215, 217, 219 | 708687555   |
| mixed | yours | 11.469, 11.690, 12.500 (med 11.690) | 0.679, 0.683, 0.742     | 4.41, 4.48, 4.84     | 214, 213, 217 | 708687555   |
| cap   | base  | 15.647, 15.463, 15.420 (med 15.463) | 1.505, 1.501, 1.514     | 6.08, 5.97, 5.95     | 255, 254, 258 | 10334191    |
| cap   | yours | 15.212, 15.025, 15.176 (med 15.176) | 1.053, 1.061, 1.046     | 6.08, 5.99, 6.06     | 256, 254, 253 | 10334191    |

Cap: ratio of medians 0.981, every pair 0.24-0.44 ms better, slots down 0.45 ms (30% of the phase) and senser unchanged (pack's extra row store is not visible).
Mixed: slots down 0.30-0.35 ms in every pair (matches the 0.27-0.29 ms of `energySignal` in the profile); the whole-tick ratio 0.923 is noise (the base's pair 2 ran in a quiet minute, 9.7 ms), the honest figure is the phase, about 0.3 ms of 12.5 (2.4%).

## Audit of one tick (mixed, 3300 creatures)

Phases from `--profile` (perf-live, 12.5 ms), JS self times from `node --cpu-prof` (200 us, 1800 ticks, 60 s, whole run divided by 1800 so map building at start-up is in the list but not in the tick). WebAssembly functions have no names in the profile, so kernels are timed by their phase.

| Step | ms/tick | Repeats work on unchanged data? | Verdict |
|------|---------|---------------------------------|---------|
| prepareTick: crowd grid (refresh or rebuild) | 0.16 | The rebuild was done twice (idea 33, merged) | done |
| prepareRows: `energySignal` (JS exp) | 0.27 | Yes, pack computes the same value | built here |
| prepareRows: `valueAt` ground lookup | 0.42 | No: pre-move position, once per creature; the step reads `groundFactor` from the row | keep |
| prepareRows: loop body | 0.39 | No | keep |
| slots (brain run region) | 0.4 | No | keep |
| syncItems / `patchCell` | 0.12 | No, patches only the cells changed since the last sync | keep |
| pack (f32 columns, exp) | in senser | exp is the only exp left per creature | keep |
| fill, sense kernel | 4.8 (senser) | Rays per creature differ; no per-tick repeat found | keep |
| brain forward | 4.3 | No | keep |
| step kernel (memory and steer) | 1.1 | No | keep |
| sharedPhase: rebuild | 0.15 + 0.2 | The tick-start copy is reused when nothing changed cell (idea 33); birth/death patching rejected there | keep |
| itemTables, touch | 0.4 | Needed: moved positions | keep |
| eat (JS loop over touchers) | 0.07 | No | keep |
| hunt, collisions, settle, births, regrow | 0.18 + 0.07 + 0.08 + 0.05 | No, each reads state changed this tick | keep |
| `checkInsert` (0.18 in the profile) | 0 | Start-up seeding of the bench only | not a tick cost |

Left over after this change: nothing in the tick above 1% that is computed twice on unchanged data.

## Tests

New case in `tests/typescript/wasmCrowd.test.ts`: `pack(..., toRows = true)` leaves in every row exactly `fround(energySignal(crowd energy, start))`, and `prepareRows(..., signalDone = true)` leaves those values alone.
Focused files (wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep): 119 passed, exit 0. Kernels regenerated (`node scripts/buildWasm.ts`), tsc clean.

## Verdict

Merge: exact, about 0.3-0.45 ms per tick (2-3% of the tick by the phase, 1.9% whole-tick at the cap), no RSS change, about 25 lines.
