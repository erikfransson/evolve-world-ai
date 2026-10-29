# Idea 151: generality audit of the perf-live campaign

Read-only audit of `git diff c384eb5...perf-live -- src server` (436 commits, 44 files) against Erik's rule: a fast path may key on a world setting with an exact fallback, never on what today's founders or population happen to have.
Classes: A general over the engine's allowed range, B keyed on a world setting with an exact fallback, C keyed on founders or today's population (violation), D a bound an allowed configuration can hit.
Allowed ranges used: `PLAN_LIMITS` (1-16 rays, ray length 10-400, 1-4 hidden layers of 1-32, memory 0-8 each), save restore (`ecoState.ts` 1-64 rays, ray length up to 5000, up to 8 hidden layers of up to 512, memory up to 64, up to 20000 creatures), forms (population limit 100-10000), and pasted settings JSON, which checks little (`settingsIO.ts`).

## Result

No C items. No code path, constant or table in the diff depends on a founder's ray count, layer width, lifespan or on the live population (grep for founder names, 3300, 4900, 5000 in the diff finds only the bench tools).
Two D items, both reachable only through unchecked pasted settings JSON, and one soft D on save timeouts. Eight B items. Everything else is A.

## D items

| # | Where | Failing configuration | What happens | Pinned by a test |
|---|-------|-----------------------|--------------|------------------|
| D1 | `brainKernel.ts:19-20,151` `MAX_SIZES = 16 - 6 = 10` layer sizes (was 12) | `brain.hiddenLayers` with 9 or 10 entries in pasted settings JSON (not checked by `settingsIO.ts` or `checkedConfig`; forms stop at 4, saves at 8) | `bank.set` throws "brain needs 2 to 10 layer sizes" at the first `attach`, the world does not start. Before the campaign 10 hidden layers ran on the kernels. The ray-limit fallback to JS (`ecosystem.ts:265`) does not cover layer count | Yes, `wasmKernels.test.ts:150` (8 hidden pass, 9 throws). Not covered: the Ecosystem-level fallback |
| D2 | `crowd.ts:8` `MAX_GRID_CREATURES = 65535`, throws in `crowd.ts:144`, `crowdKernel.ts:149` | `eco.maxPopulation` above 65535 in pasted settings JSON (forms cap 10000, saves 20000, Live 5000) with enough food to fill it | RangeError in the tick. Before, the grid had no limit. Inferred from the code and the guard test, a 65536-creature world was not run | Yes, `crowd.test.ts:32` (limit and throw) |
| D3 | `saveParse.ts:16` `PACK_TIMEOUT_MS = 10 s`, `saves.ts:20` `STOP_PACK_MS = 25 s`, `saveParse.ts:9` `YOUNG_MB = 8` | A world near `maxSaveJsonBytes` (50 MB) on a loaded host. The 10 s was set from "a real pack takes 1 to 3 s" at 42 MB | Pack times out as `WorkerFailed`, the periodic save retries after 15, 30, 60 min (`saveRetryMs`), the stop save gets 25 s. No wrong result, a late save | Yes, `liveSaveRetry.test.ts` |

## B items (keyed on a setting, exact fallback)

| # | Where | Keyed on | Covered | Fallback |
|---|-------|----------|---------|----------|
| B1 | `sense.wat:116,146,605,645` stride-6 pair emit, lean merge loop, one-flag creature features (ideas 136, 143) | species count: ray feature stride 6 means no species list or one species | stride 6 | stride 4, 7, 8, ... take the older loops (exact). Tested at species 0, 1, 2, 3, 5, rays 1-64 (this audit) |
| B2 | `senseKernels.ts:87` `packsOwnSignal`, `crowd.wat` `C_SIG_ROWS`, `fill.wat` `prepare` | every species has start energy equal to the largest one (`sameStart`), and the crowd grid is on the kernel (more than 12 creatures) | all single-species worlds, multi-species with equal start energy | `prepareRows` in JS (`residentStep.ts`). The fallback has no direct test of its own, only `prepareRows` parity tests |
| B3 | `stepKernel.ts:53,76` `portOk`, `step.wat` fdlibm sin and cos | the host's `Math.sin` and `Math.cos` equal the port on about 4000 probe angles | V8 with fdlibm | the imported `Math.sin` and `Math.cos`. A probe is statistical, an engine that differs on none of the probes would pass. Port also defers to the imports for non-finite and abs(x) past 823549 |
| B4 | `ecoConfig.ts` `eco.thinkEvery`, `creature.ts:426`, `residentStep.ts` | world setting 1 to 8, default 1, not exact for 2 and up (creatures act on older senses, churn rises per `think2.md`) | all values 1 to 8, helper threads and saves carry the outputs | value 1 is the old exact path. Live keeps 1 (`server/src/config.ts:50`) |
| B5 | `senser.ts:20` `ROCK_BOUND_CAP = 2048`, `sense.wat` rock skip | ray length up to 2048 skips rock-free cells | all lengths | longer rays never skip and walk the rock as before (exact). Checked here with lengths 100 to 5000 around rock, all within tolerance |
| B6 | `senser.ts:22` `PATCH_MAX = 1024`, `rowCap` run | at most 1024 dirty item cells per tick, no row outgrowing its run | any item churn | whole repack (exact) |
| B7 | `ecosystem.ts:425` grid `refresh` | same members since the last grid (`table.version`), nobody changed cell, more than 12 creatures | any world | full rebuild |
| B8 | Size thresholds `SMALL_SORT = 12`, `SMALL_SCAN = 32` (`ecosystem.ts:42`), `SCAN_MIN = 16` (`ga.ts:126`), mutate scan also needs `0 < rate < 1` | population or genome length | all | JS loops (reference path, exact) |

## A items (general over the allowed range)

| Item | Where | Why it is general |
|------|-------|-------------------|
| Column groups of 6,5,4,3,2,1 vectors, tanh inline, prefetch | `brain.wat` | any layer width. The 6-wide block came from 24-wide layers, but widths 4 to 20 have exact cases and the group size is a register limit. Gain varies with width, no cliff |
| Ray-row split, run-order by block address, chunked bump blocks, compaction, mark stamps | `brainKernel.ts`, `brain.wat` `runOrder` | any sizes (`rayInputs = min(rays * stride, input)`), block over 1 MB gets its own chunk, stamp wrap tested |
| Ray scratch of 64 rays (`MAX_RAYS`, `SCRATCH_BYTES 2816`, odd-ray NaN pad, hit lanes in groups of four) | `senser.ts:19`, `sense.wat` | covers 1-64 rays, the engine's limit. Rays above 64 fall back to the JS path (`senseKernels.ts:57`, `ecoPool.test.ts:274`). Run here at 1, 2, 3, 15, 16, 17, 31-33, 62-64 rays, species 0, 1, 2, 5, spreads 1.5 and 2 pi: no mismatch. No committed test uses more than 40 rays (`ecoPool`) or 12 (`wasmKernels`) |
| Candidate buffer `(world.count + rock.rockCount) * 32 + 64`, crowd `count * 16 + 64` | `senser.ts:336` | `world.count` is item slot capacity, so accepted items cannot exceed it. Writes go at most 28 bytes past the last accepted entry, inside the 64 slack |
| Item pair read (+8 bytes), `patchItems` | `senser.ts`, `sense.wat` | row run size checked, returns fewer than n then repack |
| Crowd `cellStart` as u16 with 8-cell stores, `+14` byte slack | `crowdKernel.ts:156`, `crowd.wat` | table size `(cells + 1) * 2 + 14` covers the seven-cell overrun for any cell count. Guard in D2 |
| Radix keys, `refresh`, `pack` | `crowd.wat` | unchanged key math |
| Ground block mask (`G_BLOCK_SHIFT 3`) and `prepare` | `groundField.ts`, `fill.wat` | a block with no corner at 128 or more cannot blend to 127.5 or more, so exact for any map. Field copied by identity, the field is only written while a map is built |
| Clear-of-rock raster at 128 units, one bit per square | `terrain.ts:36`, `step.wat` | conservative raster, any radius per species, out-of-raster squares take the full path |
| Rock lower bound table | `senser.ts` `rockLowerBound` | one table per terrain, cost about 225 cells per disc, 70 KB at the largest map |
| Offset tables shared by content | `senser.ts` | by bits, hash chains, freed at zero refs, never more tables than slots |
| Birth chunks (`BIRTH_CHUNK 8` loops to the end), `SparePool.take` (`SPARE_LOOK 16`, falls back to the newest), `MAX_SPARE 256` | `ecosystem.ts`, `sparePool.ts` | heuristics with a total fallback. `MAX_SPARE` only releases storage |
| `mutateScan`, `settle`, `birthCandidates` | `members.wat` | exact twins, n bytes of output buffer sized by n |
| Lent genomes, `genomeInto`, row and slot reuse | `brain.ts`, `resident.ts`, `senseKernels.ts` | storage only |
| Leaderboard `floor` skip | `leaderboard.ts:67`, `chronicle.ts` | exact because the four boards only grow while alive. Species fixed at 0 as the existing `offer` already did |
| `encodeMembers`, name cache, no-viewer skips, `setImmediate` when behind | `server/src` | byte-equal frame (test), cache bounded at 2048, skips depend on viewers, not creatures |
| Save pack worker, snapshot, `base64` | `saves.ts`, `saveWriteWorker.ts`, `ecoState.ts` | text equal to the old save, size checked before gzip |
| Bench and timer tools | `liveBench.ts`, `kernelTimers.ts` | measurement only, not shipped paths |

## Caps asked about

| Cap | Engine maximum | Fits | Test |
|-----|----------------|------|------|
| 10 layer sizes | saves 8 hidden (10 sizes), forms 4 | yes, exactly at the save maximum. Pasted JSON can pass it (D1) | `wasmKernels.test.ts:150` |
| `MAX_GRID_CREATURES` 65535 | 20000 in saves, 10000 in forms, 5000 Live | yes, unchecked pasted `maxPopulation` can pass it (D2) | `crowd.test.ts:32` |
| Candidate buffer | item slots plus rock discs plus crowd | cannot overflow | no direct test (slack argument above), crowded-cell tests in `wasmKernels.test.ts:627` |
| 64 rays | `MAX_RAYS` 64, save restore 64, `PLAN_LIMITS` 16 | yes, kernel run at 63 and 64 rays here | JS fallback above 64 pinned, 63 and 64 rays on the kernel not pinned |
| Input 1024 values, 1024 neurons per layer (`SCRATCH_FLOATS`, not from this campaign) | save restore allows 512 neurons and 64 rays, so 64 rays with 9 or more species can pass 1024 | as before | `wasmKernels.test.ts:300` |
| `PATCH_MAX` 1024 | any | exact fallback | `wasmKernels.test.ts:693` |
| `ROCK_BOUND_CAP` 2048 | ray length 5000 in saves | exact fallback | bound table test `:812`, long rays only checked ad hoc here |
| Ground and clear rasters | any map size | sized from the map | `residentBodies.test.ts:84,125` |

## Suggested follow-ups (not done, audit was read-only)

1. D1: let `SenseKernels.create` or the Ecosystem constructor fall back to JS for more than 8 hidden layers, as it does for rays, or validate `brain.hiddenLayers` to the form's 1-4 in `settingsIO`. A test for the fallback.
2. D2: validate pasted `eco.maxPopulation` and `initialPopulation` to the save maximum of 20000.
3. Pin 63 and 64 rays on the sense kernel with one cheap test (species 0 and 3), and a species set with unequal start energies for B2.

## Fixes (idea 153)

- D1: `checkHiddenLayers` (`ecoConfig.ts`, `MAX_HIDDEN_LAYERS = 8`) runs in `parseWithPreset` (`settingsIO.ts`) and `checkedConfig` (`ecoState.ts`). A pasted or saved brain with 9 or more hidden layers now fails with `config "brain.hiddenLayers" must have at most 8 layers, got N.` at validation, not at the first attach. Test: `ecosystem.test.ts` "brain depth limit" (8 layers run on the kernels, 9 refused on restore), `settingsIO.test.ts`.
- D2: `parseWithPreset` clamps `eco.maxPopulation`, `initialPopulation` and `birthReserve` to `MAX_CREATURES = 20000` (moved from `ecoState.ts` to `ecoConfig.ts`, same value), so the 65535 grid guard is out of reach of settings. The forms' 10000 and `retune`'s cap are unchanged. Saves already refused above 20000. Pasted species are rejected, so no species `founders` to clamp. Test: `settingsIO.test.ts`.
- Gaps: `wasmKernels.test.ts` runs 62, 63 and 64 rays (species 0 and 3, spreads 1.5 and 2 pi) and ray lengths 2048, 2049 and 5000 around rock against the JS senser, bit for bit. `wasmCrowd.test.ts` pins `packsOwnSignal` (start energies 50/120 and 90/50 take the `prepareRows` twin, 50/50 and 120/120 the crowd kernel's pack) and that the rows equal the twin bit for bit.
- Engine code is unchanged for every valid world (constants and validation only); fingerprints checked below.

## Follow-up (idea 154)

B1 is closed: the pair emit, the lean merge loop and the detail loop take every stride (byte-identical over strides 4-16 in review round 17's differential), so no stride-keyed branch remains in sense.wat.
