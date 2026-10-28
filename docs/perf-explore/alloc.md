# Allocation audit of the steady tick (idea 91)

Branch `pl-alloc` from `perf-live` 8443cb6. Mixed case 3300 creatures (`--copies 800`), cap case 4900 Juggernauts, taskset 2,3,6,7 nice 19 idle.

## Method
Sampling heap profiler through `node:inspector` (`HeapProfiler.startSampling`, interval 256 B, with objects collected by minor GC), started at the end of the warm-up and stopped at the end of the bench, with `--frames` so the frame, delta and stats paths of the server run at their real rates. Scratch copy of `liveBench.ts` (not committed). `--trace-gc` for the scavenge counts. `--no-turbo-inlining` was tried and rejected: it boxes every double returned by a non-inlined getter and shows 85 KB a tick that does not exist.

## Where the bytes go (before, bytes per steady tick, `--frames`, 52.0 KB total; without `--frames` 17.1 KB)
| Site | B/tick | Cause | Done |
|------|-------:|-------|------|
| `Chronicle.observe` + `offer` + `Leaderboard.offer` | 18 600 | per member and board: a `${species}:${board}` string, a `findIndex` closure, a `build` closure; a for-of over `eco.members` | fixed |
| `Lineages.forEachLiving` + `namedTop` callback | 6 900 | for-of over the `late` Map allocates an entry pair per row; per row `wireName`, `slice`, `toLowerCase`, key string, group object (3200 rows in the bench, a few hundred live) | pair fixed, rest left |
| `LiveWorld.collectOps` | 7 400 | one `{slot, kind, x, y, tick}` object per item change (58 a tick) and `log.length = 0` frees the log's backing store every tick | left |
| `syncItems` | 1 900 | `for (const c of dirty)` in a function that runs once a tick (never optimised) allocates an iterator result per dirty cell | fixed |
| `encodeDeltaChunk` | 1 000 | two for-of loops over the ops | fixed |
| `World.setItem`/`removeItem`/`markDirty`/`randomSpot`/`addRandomly` | 4 800 | growth of the log and `dirtyCells` arrays after each `length = 0`, boxed doubles | left |
| `sharedPhase` (inlined eat, regrow) 1 400, physics `collide`/`bump`/`keepOut`/`hurt` 1 400, `subarray` views in kernel wrappers 1 500, `mutate` 250 | 4 500 | boxed doubles, one view per kernel call | left |
| bench `ecoSample` (resident getters, for-of, `hypot`) | 4 900 | bench only, not on the server | left |

Left alone: each remaining item needs a new structure (flat typed op buffer shared with `encodeDeltaChunk`, typed log and dirty list with a count, cached view objects) for 1 KB or less a tick each, or is a boxed double that disappears when V8 inlines.

## Result
Heap profile, same bench, `--frames`: 52.0 KB -> 28.2 KB per tick (-46%); without the bench's own `ecoSample` 47 -> 23 KB. Fingerprints equal: 708687555 (mixed), 10334191 (cap).

GC with default flags (16 MB semispace, 60 s runs, steady part only). Scavenges are rare and cheap: the server allocates about 1.4 MB a second, a scavenge frees about 16 MB and takes 1-7 ms, so GC is 0.04-0.2% of wall time, not 2%. The 2% and 3-4 scavenges a second of the scouts came from `--cpu-prof` and from the first seconds, where the new space is still 1 MB. A 150 s `--frames` baseline: 10 scavenges in 51 s steady (11.8 a minute, 56 ms in total, 0.12%). Counts in 60 s runs are 1-5 events and mostly show when the semispace grew, so they cannot resolve the change.

cpuMsPerTick, 3 alternating pairs (base then yours), medians:
| Case | base | yours | ratio |
|------|------|-------|-------|
| mixed | 12.681 12.682 12.282 | 12.660 12.853 12.254 | 0.998 |
| mixed `--frames` | 12.567 12.702 13.196 | 12.531 12.972 12.776 | 1.006 |
| cap (4900 Juggernauts) | 15.242 15.320 15.367 | 15.367 15.329 15.542 | 1.003 |
Frame work per tick (`frameMsPerTick`): base 0.299 (0.279-0.465), yours 0.302 (0.276-0.381). Peak RSS 217-222 / 254-259 MB, same as base.

## Verdict
Exact, fewer allocations, no measurable speed change: the tick time and the GC share were already negligible. Mergeable as a tidy-up (about 20 lines, one server file), not as a speed gain. Tests: see the report (`ecosystem ecoPool resident wasm`, `live*`, `leaderboard`, `lineage`).
