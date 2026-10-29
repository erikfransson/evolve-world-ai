# Idea 140 genomecopy: drop the JS copy of the weights of kernel-backed brains

Branch `pl-memscout` (on perf-live 5767e22 plus the merge). Candidate 1 of `memscout.md`: every `Brain` kept `weightsGenome`, a Float32Array copy of weights that the wasm brain block holds again (23 MB at the 4900 cap, 26.6 MB at 3250 mixed).

## What changed (about 95 lines of source, 2 tests)
- `brain.ts`: `lend(lender, slot)` drops the own copy once the bank holds the weights; `genome` on a lent brain returns a fresh copy read from the bank, `genomeLength` and `genomeInto(out)` read without one; `own()` takes a copy back; `reshape` is the reset of a lent brain; `ensure()` (the JS views, the detail creature) owns first, and a brain with built views is never lent.
- `brainKernel.ts`: `readGenome(slot, out)`, the inverse of `set` (reads the descriptor, so it follows blocks moved by `compact()` and the separate ray rows of idea 125).
- `senseKernels.ts`: `attach(c, genome)` lends after `set`; `release` owns before the block is freed (a dropped creature keeps a readable genome). `creature.ts`: `reset` passes the genome to `attach` for a lent brain.
- Length-only reads (`.genome.length` in `ecosystem.ts`, `ecoState.ts`, `ecoShare.ts`, `liveBench.ts`) use `genomeLength`; the save snapshot reads each genome straight into its column with `genomeInto`. Births, the helper-thread share (born packets), the viewer's genome request and carry read the `genome` getter. No-kernel creatures (RL, tests, JS path) keep the copy and are unchanged. No save-format change.

## Contract notes
- RL creatures that run through `SenseKernels` (`rl/env.ts` `kernels.reset`) are lent too. As before, a previous episode's creatures must not be read after `bank.reset()`: their blocks are gone, and a read would return whatever the next episode wrote there.
- `Creature.reset` checks the genome length against the plan's layer sizes first, so a mismatched genome throws with the brain, plan and bank descriptor untouched (test in `ecoPool.test.ts`).
- A birth copies the parent's weights once (`genomeInto` into the child scratch) unless a structural mutation remaps them; the helper packet reads through a scratch array, not a fresh copy.

## Exactness
- `wasmKernels.test.ts` "readGenome rebuilds the stored genome bit for bit": 400 slots over every `SIZE_SETS` entry, ray inputs 0, 1, all and half, after releases, 20 `compact()` calls and refills with other layouts.
- `ecoPool.test.ts` "kernel creatures lend their genome...": after 400 ticks all members but the detail one are lent, lengths agree, and the saved state is identical after `own()` on all.
- Save state sha256 of a 600-tick 60-creature world (structural mutation on, births and deaths): `6f8f31c1...ff6b` on perf-live and here, fingerprint 761480345 on both, 55 of 55 members lent. The 600 s mixed bench has fingerprint 164690887 on both. Pins: 708687555 (mixed 60 s) and 10334191 (cap) equal in all six runs each.

## Numbers (taskset 2,3,6,7, nice 19, load 20-28)
Alternating pairs, 60 s:
| Case | cpuMsPerTick base | new | peak RSS base | new |
|------|-------------------|-----|---------------|-----|
| mixed 3300 | 11.18 11.02 11.02 | 11.36 10.86 10.79 | 218 219 218 | 203 201 200 |
| cap 4900 | 12.83 12.70 12.80 | 13.23 12.57 12.74 | 252 254 255 | 235 232 235 |
Medians: mixed 11.02 vs 10.86, cap 12.80 vs 12.74 (inside the spread), peak RSS -17 MB (mixed) and -20 MB (cap). The live data drop is the 26.6 / 23 MB measured.

Mixed 600 s with `--save 150` (4 saves of 41 MB JSON, `--frames`), end RSS / HWM in MB, `arrayBuffers` 37.1 to 10.5:
| Run | base | new |
|-----|------|-----|
| first pair (new without `genomeInto`) | 461 / 550 | 452 / 573 |
| second pair, two each | 435 / 555 and 383 / 502 | 353 / 482 and 361 / 479 |
cpuMsPerTick of the 600 s runs 13.7, 13.7 vs 13.4, 13.7. Before `genomeInto` the save snapshot made one copy per creature through the getter (about 16 MB of garbage a save) and the HWM was not lower (573 vs 550, one pair); with the direct read the saves peak 479-482 against 502-555 and the end RSS is 353-361 against 383-435. The glibc retention of memscout (candidate 2) still hides part of the 27 MB, so the RSS gain after saves is noisy (about -30 to -80 MB over four runs, median -50) and larger than the live data. Four runs per arm is little; treat the size as "at least 20 MB" not as a precise number.

## Tests
- `tsc --noEmit` exit 0. `vitest run wasmKernels ecoPool ecosystem resident ecoState`: 129 passed, exit 0 (after `genomeInto`).
- Full typescript suite before `genomeInto`: 1254 passed, 8 failed, exit 1; all 8 are `cli.test.ts` spawns that time out at the file's 20 s limit under this load, and the same file fails the same way on perf-live (5 failed there in the rerun). Server suite not run: no file in `server/src` changed except the `genomeLength` read in `liveBench.ts`; saves are byte-identical by the sha above.

## Verdict suggestion
Merge. Exact, about 95 lines, -17 to -20 MB peak RSS at no tick cost, bigger saving after saves. Watch: `Brain.genome` on a kernel creature now allocates a copy per call (births, viewer request, carry only; nothing per tick).
