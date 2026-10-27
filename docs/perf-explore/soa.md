| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Typed-array BodyStore for hot state (x, y, vx, vy, heading, turnRate, energy), column gathers for crowd and WASM sense, row-based stepBody | 23.1 ms/tick (20000, serial) | 23.05 | 1.00x | bit-identical | none (257 MB) | about 150 | Not worth it |
| Same, 30000 wide, serial | 56.5 | 59.2 / 55.4 / 60.3 (median 59.2 vs 56.5, noise) | 1.0x | bit-identical | -3% (445 -> 425 MB) | same | Not worth it |
| Same, 20000, --threads 3 | 35.0 | 35.45 / 34.2 / 36.2 (median 35.45 vs 35.0) | 1.0x | bit-identical | none | same | Not worth it |

CPU ms per tick (process CPU), alternating A/B pairs, 6 at 20000 serial and 3 each otherwise, load average 27 to 43, so noise is about +-4%.
Fingerprints equal main: 20000/15 s = 561561743 and 30000/10 s = 698110544 (A and B, serial), `--predators --seconds 40` = 792910110 (serial and threads 3).
tsc is clean. The vitest suite was started but its pass count was not captured, so treat tests as unverified.

## What was built
- `sim/bodyStore.ts`: `BodyStore` (Float64Array columns, one row per Creature object, never reused) and `SlabState`, a `CreatureState` view with getters over a row (alive and ticksAlive stay plain fields).
- Creature takes an optional store. Ecosystem and ShareHelper pass theirs. Trials and landing creatures keep plain objects.
- `Crowd.rebuildRows` gathers from columns by row. The senser rec and `writeBodyInputs` read columns. `stepRow` is `stepBody` on columns, same operations in the same order. `touched` reads columns. `stepBody` itself now reads and writes via locals.

## Why no gain
- Only the getter view (no direct column use) was neutral. Direct column use in the gather, motion and eat lookup saved about 3% in one 3-pair run, and the 6-pair rerun showed nothing.
- CPU profile at 20000 wide: about 58% is the WASM sense and brain. The object-touching JS (rebuild, senser gather, finishTick, stepBody, eatAt, collide) is about 25%, and most of that is real arithmetic and grid work, not cache misses. At 2600 to 6000 creatures the objects fit in cache, so the 150 ns/creature gather seen on serial.md's setup is mostly read latency that typed arrays do not remove.
- Not converted: collide/hurt/bump, settle, consume, hunt, writeState/readState in ecoShare. Estimated at most another 1 to 2% for about 80 more lines.

## Verdict
Not worth merging: about 150 lines, one new concept (rows plus a view class with instanceof branches), no measurable speedup, no RSS change. A real gain would need the movement/eat/collide loop to run in WASM over the columns (serial.md's kernel), which this store would feed, but serial.md measured only 1.05 to 1.08x for that.

## Idea 32: struct-of-arrays at the live setting (3300 creatures, the Inland Sea)

Branch `pl-soa` from `perf-live`. Stage 1 (study) only, since it fails the 3% bar (about 0.4 ms of a 13 to 15 ms tick).
On perf-live the bodies already live in one flat array: resident rows of 192 B in WebAssembly memory, cache-line aligned, read as `f64[o + F.x]`. No phase walks JS objects per creature any more, so the pointer chasing this idea targets is mostly gone already.

| Phase (ms per tick, `--profile`) | Total     | Part SoA would remove                                                                 | Part it keeps                                                                                             |
|----------------------------------|-----------|---------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| slots (`prepareRows`)            | 1.0-1.1   | none: the column version measured 5% slower (below)                                  | ground lookup `valueAt` 0.49, `energySignal` (exp) 0.29, loop body (loads, arithmetic, stores) 0.49        |
| eat                              | 1.0       | at most 0.03-0.07 (strided row reads in the crowd key loop, eatlive.md)              | crowd rebuild kernel twice about 0.5, `touch` kernel 0.41, JS eat loop 0.065                              |
| births                           | 0.08      | about 0                                                                               | `birthCandidates` kernel scan, `giveBirth` (genome, brain set, allocation)                                |
| settle and deaths                | 0.08      | about 0                                                                               | `settle` kernel scan                                                                                      |
| collisions                       | 0.19      | about 0                                                                               | sweep kernel on the crowd's sorted columns (already struct-of-arrays), `bumpSlots` per hit pair            |
| Sum                              | 2.4       | under 0.07 (0.5% of the tick)                                                         |                                                                                                           |

Split of slots from the V8 CPU profiler (`--cpu-prof`, 200 us interval, 1800 ticks, self time, inflated about 15% by the profiler): `prepareRows` 0.49, `valueAt` 0.49, `energySignal` 0.29. The rest of the JS self time in the tick is under 0.1 ms a function (`sharedPhase` 0.09, `patchCell` 0.13, brain `set` 0.07).

### Direct test of the layout
A scratch copy of `prepareRows` reading x, y, vx, vy, energy, turn, cos, sin and species from columns indexed by batch position and writing 6 output columns, same arithmetic, ground lookup and exp.
The columns were gathered from the rows after each call, so they sat in memory through the rest of the tick as real columns would. Both versions ran every tick, order swapped every tick, 1350 steady ticks a run, 3 runs, liveBench `--seconds 60 --copies 800`, nice 19, load 11 to 14.
`threadCpuUsage` ticks in 1 ms steps here, so wall time per call was used for the quantiles (p25 is robust to preemption).

| Run | Rows p25 / median (us) | Columns p25 / median (us) | CPU mean rows / columns (us) |
|-----|------------------------|---------------------------|------------------------------|
| 1   | 928 / 1014             | 996 / 1097                | 993 / 1083                   |
| 2   | 949 / 1033             | 994 / 1086                | 1020 / 1068                  |
| 3   | 913 / 1013             | 965 / 1075                | 978 / 1046                   |

Columns are 4 to 8% slower: 15 streams against one sequential row stream that the prefetcher follows (rows are in slot order, which is construction order). 3300 rows are 634 KB and the loop is bound by the lookup and exp, not by loads. Fingerprint 708687555 in every run (the real `prepareRows` still wrote the results).

### Verdict
Reject without building stage 2. The resident rows already are the flat layout, the measured column variant is slower, and the other JS-side phases are kernels or under 0.1 ms. The scratch patch was not committed.
