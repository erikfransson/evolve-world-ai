# Move the creatures that changed cell over the tick-start grid (idea 49)

Exact, but slower than the rebuild it replaces: +2.9% (mixed) and +2.4% (cap) per tick, eat phase +0.08 / +0.12 ms. Branch `pl-gridmove`, base `perf-live` 3d33e82. Follow-up of `gridreuse.md` and `gridpatch.md`.

## What

`crowd.wat` `move` replaces the shared-phase rebuild when the member table is unchanged since the last WebAssembly rebuild (`table.version`, as the tick-start refresh) and at most `n >> 3` creatures changed cell.

- Pass 1, in grid order: the cell key of each creature as in `rebuild`; those differing from `cellOf` are collected (old slot, new key, index), the new keys and indices kept sorted by insertion.
- Merge: one pass over the old `owners` without the movers, each mover emitted before the first creature that sorts after it by (cell, index). That is the order the stable counting sort gives.
- `cellOf` of the movers is updated, then the rebuild's own tail (`$sorted`, split out of `rebuild`, unchanged) gathers x, y, energy, species and owner from the rows and rewrites `cellStart` and `occupied`. Past the bound `move` returns 0 before changing anything and the rebuild runs.
- Scratch is `permB` (3 x n/8 entries). `Ecosystem.regridMoved` calls it in `sharedPhase`; `crowdKernel.ts` `move` is the wrapper.

## Movers per tick (60 s runs, counter not committed, unbounded)

The brief expected a few dozen. It is about 100 at 3300 and 150 at the cap, about 3% of the creatures.

| Case                    | Mean per tick | Typical range |
|-------------------------|---------------|---------------|
| 4 founders x 800 (3300) | 96.5          | 80 to 127     |
| Juggernaut x 4900 (cap) | 151.6         | 128 to 175    |

A bound of 64 let only 24 of 1800 mixed ticks (5 of 1800 at the cap) move, so the bound is n/8 (about 410 and 610).

## Whole tick (liveBench `--profile`, 60 s, nice 19 on cpus 2,3,6,7, 3 alternating pairs, load about 20)

| Case  | Build | cpuMsPerTick                         | crowd grid ms       | eat ms (holds the shared-phase grid) | peak RSS MB   | fingerprint |
|-------|-------|--------------------------------------|---------------------|--------------------------------------|---------------|-------------|
| mixed | base  | 14.486, 14.003, 14.076 (med 14.076)  | 0.230, 0.225, 0.212 | 1.179, 1.165, 1.160                  | 215, 217, 217 | 708687555   |
| mixed | yours | 14.597, 14.485, 14.405 (med 14.485)  | 0.221, 0.216, 0.214 | 1.250, 1.260, 1.235                  | 216, 220, 215 | 708687555   |
| cap   | base  | 17.567, 17.035, 17.090 (med 17.090)  | 0.508, 0.503, 0.501 | 1.573, 1.552, 1.552                  | 249, 253, 257 | 10334191    |
| cap   | yours | 17.501, 17.411, 17.500 (med 17.500)  | 0.509, 0.496, 0.498 | 1.687, 1.667, 1.675                  | 254, 258, 251 | 10334191    |

Ratio of medians 1.029 (mixed) and 1.024 (cap). Every yours run is above its base pair on the eat phase (+0.08 ms, +0.12 ms), so the sign is not noise even though the totals are.

## Why it loses

In-process timing of the same shared-phase state (medians over 400 ticks, same cpuset, load about 20, so absolute values are about 2.5x a quiet machine; the rebuild is timed second, with the rows hot, which favours it):

| Case  | Pass 1 | + merge | `move` whole | `refresh` (no movers) | Rebuild |
|-------|--------|---------|--------------|-----------------------|---------|
| mixed | 0.251  | 0.314   | 0.667        | 0.163                 | 0.537   |
| cap   | 0.374  | 0.465   | 0.993        | 0.252                 | 0.768   |

- The radix sort is not the expensive part of the rebuild. Its tail (gather from the rows, `cellStart`, `occupied`) is about 0.35 of the 0.54, and `move` keeps that tail.
- Pass 1 reads the rows in grid order, so it costs more than the rebuild's key pass (table order, sequential rows).
- So `move` = pass 1 (0.25) + merge (0.06) + the same tail (0.35) is slightly more than the rebuild (0.54 = key pass + sort + tail).

## Ceiling of a better version

Not built. To win, `move` must also skip the tail: write x, y, energy, species in pass 1 (a refresh, 0.16), shift the five sorted arrays by blocks between the 200 to 300 insert and remove points (`memory.copy`, blocks moving left in ascending and those moving right in descending order never overwrite unread data), and patch `cellStart` and `occupied` by range. Its floor is pass 1 plus the shifts, about 0.45 of the rebuild's 0.54 on the loaded numbers above, so it would save about a quarter of the shared-phase rebuild.
That rebuild is 0.2 to 0.3 ms on a quiet machine (`gridpatch.md`), so the saving is about 0.05 to 0.08 ms, 0.4% to 0.5% of the tick. Even a free grid update would gain 1.4% (mixed) and 1.8% (cap), under the 1.5% bar at 3300. Not worth 150 more lines of wat.

## Tests

`tests/typescript/wasmCrowd.test.ts`: two new cases and one changed line.
- The shared phase of 300 ticks on a crowded damage world and on the predator world, after every `regridMoved` the arrays are compared with a fresh JS rebuild, array for array; asserts more than 20 moves.
- `move` after 0 to 400 creatures jumped (short steps or anywhere; every third round with positions scattered to NaN, infinity and outside the world), 60 rounds; asserts more than 20 moves and more than 5 fallbacks past the bound.
- The reuse case counted a rebuild every tick for the shared phase; it now asserts more than 20 rebuilds.
Both new cases go red (16 differences each run) with a mover placed after the creatures of its cell instead of by index (mutant checked).
Focused files (wasmCrowd wasmKernels thinkEvery ecoPool residentBodies wasmStep) 122 passed, exit 0; tsc clean, exit 0. Fingerprints 708687555 and 10334191 unchanged.

## Verdict

Do not merge: exact, but 2.4% to 2.9% slower per tick, and the ceiling of a better version (0.4% to 0.5%) is under the 1.5% bar. The shared-phase rebuild is dominated by its gather and `cellStart` tail, which any exact update has to redo or patch.
