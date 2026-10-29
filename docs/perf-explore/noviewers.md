# Idle skip: no per-frame work while no viewer is connected (idea 48)

Question: can the server skip what only a viewer reads while `viewers.size === 0` (prod.md: about 0.35 ms per tick, 2.4%), exactly for the simulation and with nothing a later viewer or a save misses? Server code, so the push gate applies (3 reviews, not run here, not pushed).

## What changed (server only, engine untouched)

- `public.ts` frame loop: with no viewer it does not call `creatureFrame` and sets `lastCreatures = null`; `takeDelta`, `feed.push` and the `deltaBytes` smoothing still run, so the item log stays whole. `sendFrames`, `sendDetails` and the history loop are skipped (nothing to send to), `resync` is reset. New scalar `skippedBytes` (size the frame would have, `creatureFrameBytes(population)`) keeps `room()` and the upload budget exact for a connect burst right after an empty period; it is zeroed in `onReseed` and `forgetFrames` like `lastCreatures`.
- `LiveWorld.stats(viewers)` passes `viewers > 0` to `Chronicle.observe(..., viewed)`. Unviewed, `observe` still takes the population and lineage samples (history, lineage ring, `historyJson`) but skips the family table (`namedTop`) unless a lineage sample is due, the lineage rows, and the per-creature offer loop with best, depth and records. `stats.lineages`, `depth`, `best` and `records` are then absent or zero in a message nobody receives.
- Not touched: simulation, saves (the chronicle is not saved, it restarts on load), `onDeath` offers (dead creatures still enter the records), admin, `GET /stats`.
- No new state a visitor can grow: one number (`skippedBytes`) and a boolean argument. Cost with viewers is unchanged. The viewer-less path does less than before, so it cannot exceed an existing bound.

## What on the wire may differ

- A viewer joining after an empty period used to get the last creature frame and the full item set at once from the connect allowance. Now `lastCreatures` is null at that moment, so both arrive with the next frame tick (at most 200 ms later), through the same `lastFrame < 0` path that a reseed uses (full set from the resync share of the budget).
- Everything else is the same: the join's `hello` and `stats(viewers.size)` run with `viewers >= 1`, so that stats message is a full pass (lineages, best, depth, offers of every living creature). Records ride only on every 5th stats message, and a full offer pass has always run just before, so the records on the wire are not stale. The prod.md worry (records lagging one second) does not occur; the only difference is the up to 200 ms for the first frame.
- Item deltas, history and lineage samples, and saves are byte-identical (test below).

## Tests (`tests/typescript/liveNoViewers.test.ts`, 7 tests)

- Empty period (3 frame ticks): `creatureFrame` is never called; a viewer then joining gets hello, history, an items message and a creature frame within 1.5 s.
- Join, leave, join again inside one frame interval: the second viewer gets the full set; after the last leaves, encoding stops (call count frozen over 700 ms); a later viewer again gets the full set.
- Connect burst of 40 viewers after an empty period, budget for 3: at most 3 admitted. Weak guard: with `skippedBytes` forced to 0 it still passes, because the handshakes are slower than the first frame tick. The code path is covered by the review, not by this test alone.
- Chronicle: two worlds, same seed, 4000 ticks, stats every 30 ticks, one with `stats(0)` and one with `stats(1)`: every `sample` and `lineageSample` equal, `history()` JSON byte-equal, three seeds. After a final viewed pass, lineages, depth, best and the age board are equal. Unviewed passes carry no lineages or records.
- Against the pre-change code, 6 of 7 fail (the seventh is the budget guard above).
- Four existing assertions that read `lineages` from `stats(0)` (liveAdd, liveInland) now call `stats(1)`, because `0` now means nobody watches.
- `vitest run live publicLeak ecoLive` (19 files, 300 tests) and the 4 files touched, exit 0.

## Bench

`liveBench --seconds 60 --copies 800 --frames`, taskset 2,3,6,7, load 20-24, alternating base (perf-live), mine (viewer path) and idle. New switch `--idle` (with `--frames`): the frame tick as the server runs it with no viewer (`takeDelta` only, `stats(0)`). Base `--frames` is the old no-viewer cost too (the old loop encoded the frame and ran the full stats pass whether or not anyone watched). Fingerprint 708687555 in all 18 runs, peak RSS 215-227 MB, 110 kB/s of frames (7 kB/s idle: the deltas).

| Run | base cpu | base frame | viewer cpu | viewer frame | idle cpu | idle frame |
|-----|----------|------------|------------|--------------|----------|------------|
| A1  | 14.685   | 0.989      | 14.687     | 0.960        | 14.496   | 0.203      |
| A2  | 14.737   | 0.946      | 14.777     | 1.016        | 14.555   | 0.219      |
| A3  | 14.231   | 0.809      | 14.688     | 0.977        | 14.210   | 0.174      |
| B1  | 14.414   | 0.918      | 14.671     | 0.819        | 14.310   | 0.040      |
| B2  | 14.236   | 0.835      | 14.479     | 0.791        | 14.129   | 0.032      |
| B3  | 14.327   | 0.839      | 14.592     | 1.065        | 14.240   | 0.036      |

Round A is the first version (frame skip, offer loop skipped, `namedTop` still run); round B adds the lazy `namedTop` (idle frame ms 0.2 to 0.04). cpu is `cpuMsPerTick`, frame is `frameMsPerTick` (wall, inflated by load).

| Median | base | viewer | idle |
|--------|------|--------|------|
| A cpuMsPerTick | 14.685 | 14.688 | 14.496 |
| B cpuMsPerTick | 14.327 | 14.592 | 14.240 |
| B frameMsPerTick | 0.839 | 0.819 | 0.036 |

Idle against base: A -1.3%, B -0.6% on cpuMsPerTick (-0.19 and -0.09 ms); frame work 0.84 to 0.04 ms wall. The viewer path is the same code as base and sits 0 to +1.8% above it, which is noise of this machine and shows the CPU comparison cannot resolve less than about 0.2 ms. The idle gain is below the 0.35 ms estimate of prod.md because `cpuMsPerTick` counts user CPU only and the frame encode partly overlaps allocation that the GC pays elsewhere. Unverified.

## Verdict

Exact for the simulation (fingerprint equal), bounded and small, wire difference limited to the first frame of a viewer joining an idle server (at most 200 ms). Worth about 0.1-0.2 ms per tick (0.6-1.3%) only while nobody watches, which on the production server (0 viewers at the last check) is most of the time. Keep if the push gate passes; it does nothing for the bench numbers of a watched server.
- A tie at the edge of a record list reached while nobody watched is settled by member order when offers resume, as the always-offered path already did at exact ties (review round 14).
