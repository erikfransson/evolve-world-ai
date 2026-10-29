# Quality review 3 (final thermo-nuclear, Erik's ask before the merge)

Independent Opus review of `git diff c384eb5...129df55 -- src server scripts tests` after the fixes 156-161 and 163 (162 reverted).

Verdict: approve, no presumptive blocker. tsc exit 0 in src/typescript and server; 207 tests exit 0. No file over 1000 lines (largest changed: ecosystem.ts 872, ecosystem.test.ts 791, sense.wat 711, ecoShare.ts 662, wasmSense.test.ts 610, senser.ts 438, step.wat 390, brainKernel.ts 334 plus blockChunks.ts 157).

Prior findings 1, 2, 3, 5, 6, 7, 8, 9, 10 verified fixed; finding 4 stays open with the measured reason (162's A/B).

Remaining, none blocking:

- A. The signal decision is made in two layers (residentStep.ts picks which prepare runs, senseKernels.ts decides whether pack stores the signal): one `SenseKernels.prepare(...)` choosing the fill kernel or the JS twin, packsOwnSignal private, `senseThinkRows` without a branch; drop the test-only `signalDone` parameter of prepareRows (the two tests blank the signal themselves). Neutral, fingerprint check only.
- B. BlockChunks leaks a little: a public mutable `orderDirty` cleared from the bank (replace with `takeOrder()`), and `BlockHost.moved` is a relay that `relocate` can call `onMove` for. Compaction is rare, no pair.
- C. saveParseWorker flips a process-wide V8 flag for an early gc: measure the verify-worker peak without `collect?.()` (3 runs); delete it if equal, else keep with the measurement cited.
- D. Minor: packState's `as unknown as EcoState` relies on key order (covered by the gz sha test); `layerSizes` restates inputLayout's size formula (a test keeps them equal).

Left for Erik, not worse: saveParse's worker wrappers (packSave adds a third finish/timeout copy), the stop-budget object, the thinkEvery switch, the bench tools under server/src, the test-only casts into privates.
