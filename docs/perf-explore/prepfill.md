# prepareRows in the fill kernel (idea 44)

Exact, 1.9% of the tick at 3300 creatures and 4.6% at the cap. Branch `pl-prepfill` from `perf-live` 4e4320f.

## What

`prepareRows` (JS, residentStep.ts) computed per creature the forward and sideways speed, turn rate, ground value and ground factor. Now the new `prepare` export of `fill.wat` does it with the same f64 ops in the same order, including the ground lookup (`GroundField.valueAt`, a plain typed-array read: two bytes per node, a bilinear blend per layer).

- Species constants (`drag`, `maxThrust`, `maxTurnRate`) go into a small species block per call, the raster is copied into the bank once per field (`field !== this.ground`), the ground factor constants (`SLOW_FACTOR`, `FAST_FACTOR`) are call-block fields.
- Used when `packsOwnSignal(crowd)` (the crowd kernel's pack stores the energy signal, redo.md); else the JS `prepareRows` runs as before (JS crowd, helper threads, mixed start energies).
- `GroundField.inv` is now public (read by `prepare`). Raster edits through `GroundField.set` after the first tick would not reach the copy; it is only used to build fields.
- Test: `residentBodies` compares `prepare` with `prepareRows` bit for bit (`Object.is`) over 600 creatures, 6 rounds, on mud and firm ground, at the world edge and outside it.

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, load about 11)

| Case  | Build | cpuMsPerTick                        | slots ms (prepareRows)  | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|-------------------------|---------------|-------------|
| mixed | base  | 14.622, 14.393, 14.394 (med 14.394) | 0.886, 0.866, 0.856     | 216, 218, 219 | 708687555   |
| mixed | yours | 14.116, 14.122, 14.099 (med 14.116) | 0.361, 0.353, 0.360     | 218, 215, 216 | 708687555   |
| cap   | base  | 17.801, 17.806, 17.764 (med 17.801) | 1.249, 1.231, 1.262     | 255, 258, 258 | 10334191    |
| cap   | yours | 16.992, 16.467, 16.989 (med 16.992) | 0.496, 0.485, 0.497     | 255, 255, 257 | 10334191    |

Mixed: ratio of medians 0.981, slots down 0.51 ms (59% of the phase). Cap: ratio 0.955, slots down 0.75 ms (61%). Every pair better; other phases unchanged within noise. Peak RSS unchanged.

## Tests (all exit 0)

Kernels regenerated (`npm run wasm`); `npx vitest run wasmKernels residentBodies wasmStep thinkEvery ecoPool --testTimeout=180000 --maxWorkers=1`: 5 files, 91 tests passed (includes the thinkEvery pin 81047108 and the kernel-drift test).

## Verdict

Merge. Above the 1.5% bar in both cases, exact, no memory cost.
