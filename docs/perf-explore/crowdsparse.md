| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Sparse cell index, two-level (occupied-row bitmap plus per-row starts) instead of dense `cellStart` | gap loop 0.60 ms of a 2.40 ms rebuild (micro, 9760 creatures, 99856 cells, 9297 occupied) | not built | upper bound 0.6 ms of 70 ms, 0.85% | would be exact | none | est. 80+ in crowd.ts, sense.wat, castRays, anyWithin, collideAll, eat | Rejected: readers need a per-row search, which costs more than the 0.6 ms written |
| Rewrite only the cellStart entries that changed since the last rebuild | 100k entries written per tick | not built | none | would be exact | none | est. 40 | Rejected: 7.5% to 49% of entries change per tick at drift of 1 to 10 units, and finding them needs a full diff pass |
| Copy `cellStart` into WASM (`i32.set`, senser.ts line 275) | 0.025 ms per tick (400 KB, micro) | not changed | none | n/a | none | 0 | Nothing to gain, under 0.05% of a tick |

## Measurements

Full bench, origin/development f1ebe53, serial, wasm on, one run through `bench.sh` at load 15.7: cpuMsPerTick 63.43, msPerTick 70.18, steady 67.5, mean population 9760, peak RSS 341 MB, fingerprint 830514026 (matches the brief). Phases: crowd grid 2.735 ms, senser 29.4 ms.

Micro (`scratchpad/b2/cs/micro.ts`, not in the repo): `rebuildFrom` 2.40 ms, of which the cellStart gap loop is 0.60 ms; `i32.set` of cellStart 0.025 ms. Load 17.

Changed-entry count (`scratchpad/b2/cs/delta.ts`): a rebuild after uniform drift of plus or minus sigma/2 changes 7460 of 99857 entries at sigma 1, 24275 at sigma 3 and 48520 at sigma 10.

## Verdict

No change merged. The cellStart write is 0.85% of a tick at most, and the copy is negligible. Both cheaper schemes either add a per-query search to the hot readers (castRays, anyWithin, collideAll, eat, and the WASM sense kernel) or still scan most entries. Null result.

## Not tried

- Radix pass and gather in `rebuildFrom` (about 0.9 ms together by the earlier breakdown), if the crowd grid is to be cut further.
