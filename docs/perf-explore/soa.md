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
