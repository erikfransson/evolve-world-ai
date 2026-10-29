# Quality review 2 (thermo-nuclear, idea 155)

Independent Opus review of `git diff c384eb5...d3ade3a -- src server scripts tests` (70 files, +5147/-782) against the thermo-nuclear bar.
Prior review items (saveParse's wrappers, the stop-budget object, thinkEvery, bench tools' place, test-only leftovers) not re-raised: none got worse.
No source file crosses 1000 lines (ecosystem.ts 883). Most growth: wasmKernels.test.ts 514 to 976, sense.wat 414 to 710, brainKernel.ts 205 to 437, step.wat 218 to 390.

## Findings, ranked

1. Lend/own genome lifecycle spread over five sites (creature.ts reset, senseKernels attach and release, brain.ts ensure and load's lent branch). Judo: one `Brain.lendTo(lender, slot, sizes)`; reshape, the lent getter and load's lent branch go. Safe without pairs.
2. Brain descriptor and tanh table offsets kept by hand in brainKernel.ts and as literals in brain.wat instead of layout.ts. Move them into LAYOUT; bytes identical, drift test proves it. Safe.
3. WasmBrainBank holds four jobs (genome layout, chunk allocator with compaction, address-ordered index, run list). Extract the chunk allocator and index (about 150 lines); pure cleanups: forwardSlots repeats runRegion's grow, freeBlock and unorder each call find, reset() repeats the initialisers (also senser.ts). Cleanups safe; the extraction needs one pair.
4. Body inputs have three twins (Creature.writeBodyInputs, prepareRows, fill.wat prepare) chosen through packsOwnSignal. Judo: fill.wat prepare also writes the energy signal when the crowd kernel did not; the JS twin becomes the test oracle. Needs pairs and bit equality.
5. Save columns listed by hand in four places; restoreState's `decoded` callback is a server memory workaround inside the engine API. Judo: `decodeState` then build; one column tuple drives packState and the transfer list. Re-measure the verify worker's peak; push gate.
6. Creature frame layout written twice (encodeCreatures now test-only, encodeMembers emulates it). One `putCreature` record writer in protocol.ts; encodeCreatures to the test helpers. Needs the frame harness; push gate.
7. One members call block shared by mutateHits and the birth walk (four fields rewritten). Own block for mutateScan. ga.ts mutate: Box-Muller written twice, mulberry32 inlined thrice, extract `normalFrom`. Safe; one cheap pair for ga.
8. Small branching growth: the birth-room predicate four times in ecosystem.ts; the spare-pool bound in ecosystem.ts and ecoShare.ts; `skippedBytes` beside `lastCreatures` in public.ts; the packSave doc comment above the wrong declaration. Safe; public.ts through the gate.
9. sense.wat's `sense` is about 510 lines with five feature-writing paths and the in-sight predicate written twice: a `{{def inSight}}` macro (bytes identical) and a path map comment. Safe if bytes identical.
10. wasmKernels.test.ts' sense block (570 lines) copies the detail-parity setup three times; split into wasmSense.test.ts with a helper; the harness runs JS prepareRows, not the production path.

Fine as built: watTemplate.ts, the S_* layout constants, the save marker split, the fdlibm probe, memberFrame.ts on its own.

## Verdict

Not approved yet: four presumptive blockers (2, 6, 4, 1). With 1, 2, 5, 7 and the unused encoder moved out (6), approve; 3, 4, 9, 10 strongly recommended.
Actions: ideas 156-163 (see live-campaign.md).
