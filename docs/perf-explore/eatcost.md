# Cost of one eat in JavaScript (idea 113)

Branch `pl-eatcost`, base `perf-live` 598dec6. No engine code change: the per-eat cost is memory misses spread over about ten arrays, and no exact cut is worth more than 0.05 ms a tick.

## What was measured (3200 creatures, `kernelTimers` setup, 400-600 ticks, taskset 2,3,6,7, nice 19)

Eat JS per tick: 43 hits (touched item not yet taken, re-query count 0 per tick), `eat` loop in `sharedPhase` timed with two `performance.now()` reads per tick: 0.085-0.096 ms a tick, 2.1-2.3 us per eat (6 runs, median 2.2 us), 0.8% of an 11.5 ms tick. The 4-6 us per call of `scout-head.md` is two thread-CPU timer reads per call (0.23-0.30 us each, calibrated here with back-to-back reads) around every nested piece.

## Per-eat attribution (temporary `performance.now()` laps in `eatAt`, `removeItem` and `unlink`, minus the calibrated 0.23-0.30 us per read, 2 runs)

| Piece                                                             | us per eat (run 1 / run 2) |
|-------------------------------------------------------------------|----------------------------|
| member, species test, `eatItem` (`consume`, `kinds[item]`)        | 1.2 / 1.5                  |
| `Contacts.eatAt` tail (kind, `m.eaten++`)                         | 0.01 / 0.03                |
| `removeItem` log push (`number[]`)                                | 0.06 / 0.06                |
| `removeItem` version++ and `uncount` (cap counts)                 | 0.24 / 0.24                |
| `unlink` total                                                    | 1.1 / 1.3                  |
| of which `markDirty` push                                         | 0.03 / 0.08                |
| of which `itemCell` store and `stampCell` (two stamps)            | 0.01 / 0.03                |
| `kinds` store and free-stack push                                 | 0.5 / 0.3                  |

The laps sum to about 3 us against 2.2 us for the whole loop, so the nested timers still overstate by about a third. Shape: the log push, dirty-cell record, stamps and event buffer are each under 0.1 us (no object literal is allocated per eat; the journal and events are not written by eat). What costs is the first touch of cold lines: the creature object chain (member, creature, state, config) and the item arrays `kinds`, `itemCell`, `cellHead`, `nextItem`, `freePos`, `capOf`, `capCount`, `cellStamp`, `blockStamp` (about ten distinct lines, one eat per cell neighbourhood, no reuse).

## Cuts considered

- Swap-with-last instead of splice: `removeItem` has no array splice (linked cell lists, free stack already swap-based). Nothing to cut.
- Typed log buffer: the log push is 0.06 us, and `liveWorld.collectOps` reads `number[]`; gain under 0.003 ms a tick.
- Per-eat object literal: none exists.
- Doubly linked cell lists (no list walk in `unlink`): cells hold about 1.6 items, the walk is one or two loads of lines `unlink` reads anyway. No gain.
- Packing `itemCell`, `nextItem`, `freePos`, `capOf` into one strided array (one line instead of four): the only cut that attacks the real cost, but it changes `nextItem`/`itemCell` users in `senser.ts` (`patchCell`, `syncItems`, idea 112's area), snapshots and clones. Ceiling about 0.03 ms (0.25% of the tick), under the 2% noise.
- Warm-ahead loads of the next hit's member and item lines (exact, 3 lines in the loop, experiment only). 6 alternating pairs, eat loop us per eat, base / warm: 2.151/2.132, 2.317/2.152, 2.243/2.571, 2.132/2.255, 2.225/2.425, 2.204/2.766. Medians 2.21 / 2.34. No gain, not kept (the loads are in dependent chains of a short loop, JS cannot issue real prefetches).

## Numbers and verdict

No benchmark pairs: no code differs from `perf-live`, so the fingerprint (708687555 and 10334191), peak RSS and tests are unchanged by construction and were not run.

Reject: the eat JS is 0.09 ms a tick, 0.8% of the tick, and what remains is cache misses a JS-level change cannot hide. The largest possible cut (halving it by data layout) is about 0.04 ms, unmeasurable in the tick total. Same family as `eatlist.md` and `eatlive.md`.
