# Frame path bundle (idea 138)

Branch `pl-framepath`, built from the ranked ideas of `framepath.md` with idea 48 (`noviewers.md`, branch `pl-noviewers`) merged in (one conflict, the header comment of `liveBench.ts`, resolved by hand). Server code, so the push gate applies. Simulation untouched.

## What changed

- Detail refresh (`LiveWorld.refreshWatched`, `Ecosystem.refreshDetail(rebuild = true)`): the crowd grid is rebuilt for the first followed creature of a call only (nothing moves between the senses), and the member is found by `byId` and its `index` instead of `findIndex`. The default keeps the old behaviour for the worker.
- Creature frame (`server/src/memberFrame.ts`, `LiveWorld.creatureFrame`): one pass over the members straight into the `Uint8Array`. `Math.fround` stands where the old path stored into a Float32Array or Int32Array, the age comes from the state (no `eco.get`), and the two float `%` are exact branches (heading in (-4, 4), hue in [0, 360)) with the old expression as fallback. `readCreatures` and `encodeCreatures` stay as the reference (the worker and tests use them).
- Stats pass (`Chronicle.observe`, `Leaderboard.entries/floor`): one loop; a creature is offered only when `value > 0 && value >= floor(list)`. The comment on `Leaderboard.floor` has the proof (alive values only grow, so a listed creature is never below the last entry of its sorted list; lists are read live after every offer). `namedTop` parses each raw name once (`parsedName`, a pure function of the string, cleared at 2048 entries).
- Idea 48: no creature frame and no per-creature stats pass while nobody is connected (its 7 tests stay green).

## Equality (tests/typescript/liveFrame.test.ts, 8 tests)

- Frame bytes: old path (`readCreatures` + ages by `eco.get` + `encodeCreatures`) against `encodeMembers` and `creatureFrame()` every 20 steps of 1500 ticks, on a JS world and a resident (wasm) world, after forcing headings of 1e6, pi, -1e-30, NaN, Infinity, hues of -30, 360, NaN, negative and huge x, y, energy and ages. Plus 40000 synthetic members with ids and founders past 2^31 and 2^32, negative ids, NaN, 1e300, headings at +-pi, +-tau, +-4: 0 differing bytes in all.
- Stats: two seeded worlds, 1500 ticks, `stats(1)` every 30 ticks (records every 150), one with `Leaderboard.floor` forced to 0 (the old loop, every creature offered): `best`, `depth`, `lineages` and `records` JSON equal at all 50 calls; the records change at least 3 times before the injected high records (the slow path ran), and after injecting records far above any creature (as in an aged world) the number of `Leaderboard.offer` calls drops to a third or less. Separate property test: random monotone values with ties and zeros, skipped and full offering give equal snapshots over 400 rounds.
- Names: `namedTop` against the old function for starter marks, blanked `-`, invalid, 200 characters, mixed case, repeated and unicode names over three renames.
- Followers: six followed creatures, 120 ticks, detail rows byte-equal and `fingerprint()` equal between the old per-creature rebuild and `refreshWatched`.

## Numbers

`liveBench --seconds 60 --copies 800 --frames --profile`, 3 alternating pairs, taskset 2,3,6,7, load 25-31, base = `perf-live` at the branch point (a63560d). Fingerprint 708687555 in all 12 runs of the two rounds.

| Pair | cpuMsPerTick base / now | frameMsPerTick base / now | peak RSS MB |
|------|-------------------------|---------------------------|-------------|
| 1    | 11.537 / 11.141         | 0.276 / 0.179             | 223 / 221   |
| 2    | 11.432 / 11.295         | 0.284 / 0.211             | 221 / 226   |
| 3    | 9.867 / 10.792          | 0.201 / 0.183             | 220 / 231   |
| median | 11.432 / 11.141       | 0.276 / 0.183             |             |

cpuMsPerTick drifts more between runs than the 0.1 to 0.3 ms this changes (pair 3 shows it); frame work per tick falls by a third. An earlier round (before the last stats tweak) gave cpu 11.842 / 11.900 and frame 0.475 / 0.365.

Real loops with N loopback viewers (`framepath/fpViewers.ts`, 40 s each, CPU ms per second of the frame path pieces, the sum is the whole viewer cost; ms per call of `refreshWatched` 2.3 before, 0.55 now):

| Viewers                | base sum | now sum | creatureFrame | stats | refreshWatched |
|------------------------|---------:|--------:|--------------:|------:|---------------:|
| 0                      | 17.4     | 0.6     | 10.6 to 0     | 6.2 to 0.1 | 0         |
| 5                      | 23.0     | 18.5    | 11.6 to 7.9   | 6.4 to 5.5 | 0         |
| 20                     | 24.5     | 18.8    | 11.7 to 7.0   | 6.8 to 5.9 | 0         |
| 5, each following      | 35.4, 35.0 | 23.0, 23.2 | 11.5 to 7.0 | 6.5 to 5.6 | 9.4 to 2.8 |
| 20, each following     | 39.7, 41.3 | 27.6, 26.3 | 11.0 to 6.8 | 6.5 to 5.6 | 9.7 to 3.0 |

At 90 ticks/s and 11.7 ms per tick (1053 ms/s): nobody watching 1.7% to 0.06%, plain viewers 2.3% to 1.8%, followers 3.4-3.9% to 2.2-2.6%. Pieces per call (`fpParts.ts`, 3250 creatures): creatureFrame 2.3-2.6 ms to 1.8; `namedTop` 2.5 to 1.0; stats pass with records at aged levels (injected) 8.2-8.7 ms to 4.2-4.3, with a young world's low records 7.9-8.5 to 6.4-7.5 (most creatures are above the floors there, so the old offering work is real).

Less than the scout's 1.3 ms fused-frame estimate: in the server the states are read through getters of the member objects (1.8 ms, not 1.3). A wasm kernel over the rows remains the bigger step (0.25 ms projected, unbuilt). The `pl-alloc` per-call key string in `Leaderboard.offer` was not folded in: after the floor test the offer is on a rare path.

## Tests

- `vitest run liveFrame liveNoViewers`: 14 passed, exit 0 (before and after the last tweak).
- `tsc --noEmit` in `server/` and `src/typescript/`: no errors.
- Full `src/typescript` suite (`vitest run --maxWorkers=2`, 124 files, 1271 tests): 1264 passed, 7 failed, all load timeouts of child-process tests (`cli.test.ts` 20 s waits, `liveReset.test.ts` "packing the save took too long"). `liveReset` alone: 10 of 10, exit 0. `cli.test.ts` fails the same tests on the base worktree under the same load (4 of 16 there), so it is the machine, not the change.

## Verdict

Exact (bytes, records, family list, detail rows, fingerprint). Saves 5-6 ms/s with plain viewers (0.5%), 12-15 ms/s with followers (1.2-1.4%), and the 17 ms/s (1.7%) of an unwatched server through idea 48. Not measured: the 5000 cap case, a world with hours of records (only injected). Push gate: 3 reviews before it goes out; the new surfaces are `parsedNames` (bounded, cleared at 2048) and nothing a visitor can grow.
