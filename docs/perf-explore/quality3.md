# Quality review 3 (final thermo-nuclear, Erik's ask before the merge)

Independent Opus review of `git diff c384eb5...129df55 -- src server scripts tests` after the fixes 156-161 and 163 (162 reverted).

Verdict: approve, no presumptive blocker. tsc exit 0 in src/typescript and server; 207 tests exit 0. No file over 1000 lines (largest changed: ecosystem.ts 872, ecosystem.test.ts 791, sense.wat 711, ecoShare.ts 662, wasmSense.test.ts 610, senser.ts 438, step.wat 390, brainKernel.ts 334 plus blockChunks.ts 157).

Prior findings 1, 2, 3, 5, 6, 7, 8, 9, 10 verified fixed; finding 4 stays open with the measured reason (162's A/B).

Remaining, none blocking:

- A. The signal decision is made in two layers (residentStep.ts picks which prepare runs, senseKernels.ts decides whether pack stores the signal): one `SenseKernels.prepare(...)` choosing the fill kernel or the JS twin, packsOwnSignal private, `senseThinkRows` without a branch; drop the test-only `signalDone` parameter of prepareRows (the two tests blank the signal themselves). Neutral, fingerprint check only.
  Fix (idea 164): `SenseKernels.prepare(rows, n, world, crowd)` picks the fill kernel's prepare or the JS `prepareRows`; `packsOwnSignal` is private, `senseThinkRows` has no branch, and `prepareRows` lost `signalDone`. wasmCrowd.test.ts now runs the fill kernel's prepare for the "leaves the packed signal" case and restores the packed signal after the JS twin in the other. Fingerprints 708687555 (mixed 60 s) and 10334191 (cap) unchanged.
- B. BlockChunks leaks a little: a public mutable `orderDirty` cleared from the bank (replace with `takeOrder()`), and `BlockHost.moved` is a relay that `relocate` can call `onMove` for. Compaction is rare, no pair.
  Fix (idea 164): `BlockChunks.takeOrder()` returns the order when dirty and clears the flag (`orderDirty` is private); `BlockHost.moved` and the per-slide array are gone, `WasmBrainBank.relocate` calls `onMove(slot)` after updating the addresses. Round-9 fuzz (seeds 1-5, 4000 ops) gives identical moves and arena tops before and after (for example seed 1: 18687 moves, 40.9 MB).
- C. saveParseWorker flips a process-wide V8 flag for an early gc: measure the verify-worker peak without `collect?.()` (3 runs); delete it if equal, else keep with the measurement cited.
  Fix (idea 164): the `--expose-gc` flag and `collect?.()` are deleted. Measured with `meas.ts` (worker added over start RSS) and `stages.ts` (process verify HWM), 3 runs per arm: mixed added 99 99 99 with and without, cap 85 85 99 with and 85 85 85 without; verify HWM mixed 478 477 486 with, 485 486 489 without; cap 476 485 480 with, 518 475 482 without. Medians differ by at most 8 MB, inside the run spread, so no early collection is needed.
- D. Minor: packState's `as unknown as EcoState` relies on key order (covered by the gz sha test); `layerSizes` restates inputLayout's size formula (a test keeps them equal).

Left for Erik, not worse: saveParse's worker wrappers (packSave adds a third finish/timeout copy), the stop-budget object, the thinkEvery switch, the bench tools under server/src, the test-only casts into privates.
