# Viewer frame path budget (idea 131)

Scout only, nothing built. Branch `pl-framepath` from `perf-live`. Base: 3300 creatures (`--copies 800`), speed 3 (90 ticks/s, 5 frames/s, 1 stats/s), taskset 2,3,6,7 nice 19 idle, load 13-29.
Scripts (CPU = `process.threadCpuUsage`, user + system; copy to `server/src/` to run): `framepath/fpParts.ts` (pieces per call), `fpViewers.ts` + `fpClients.ts` (the real `runTicks` + `startPublic` with N loopback `ws` viewers in a second process, optionally each following a creature), `fpProbe.ts` (upper bounds), `fpDetail.ts`.

## What `liveBench --frames` models, and what it misses
It calls `creatureFrame`, `takeDelta` and `stats(1)` at the server's rates (`--profile` phases are the engine only, frame work is outside them). Today's run: cpuMsPerTick 11.70, frameMsPerTick 0.64 (wall, inflated by load), 110 kB/s, fingerprint 708687555, peak RSS 219 MB.
It models no viewer: no `ws.send`, no `sendFrames` fan-out, no `sendDetails`, and above all no `refreshWatched` (the senses of followed creatures), which turns out to be the biggest viewer-dependent item. `fpViewers.ts` models all of these with 1, 5, 20 viewers, followed or not (not modelled: real network, slow readers, joins in bursts).

## Budget (CPU ms per wall second, medians of the pieces; engine tick 11.7 ms, so 90 ticks/s = 1053 ms/s)

Per call, `fpParts.ts` (3253 creatures, 150 frames, 30 stats):
| Piece                                   | ms per call | per second at speed 3 |
|-----------------------------------------|-------------|-----------------------|
| readCreatures (rows to 8 f32/i32 arrays) | 0.50       | 2.5                   |
| ages (`eco.get(id)` per creature)       | 0.58        | 2.9                   |
| encodeCreatures (DataView)              | 1.76        | 8.8                   |
| creatureFrame total                     | 2.50        | 12.5                  |
| takeDelta + feed.push/delta             | 0.15 + 0.03 | 0.9                   |
| stats(1) total (1 Hz)                   | 7.9         | 7.9                   |
| of it: members offer loop (4 boards)    | 3.8         |                       |
| of it: namedTop                         | 2.5         |                       |
| of it: best/depth scan                  | 0.8         |                       |
| of it: JSON.stringify(stats), records snapshot | 0.11, 0.07 | under 0.2        |
| itemsFrame (one per joining viewer, 85k items) | 13.7  | one-off               |

Real loops, `fpViewers.ts` (40 s each, 4.5 frames/s reached because the machine is loaded; ms/s):
| Viewers          | creatureFrame | takeDelta | ws.send | refreshWatched | detail | stats | itemsFrame | Sum  | % of tick |
|------------------|--------------:|----------:|--------:|---------------:|-------:|------:|-----------:|-----:|----------:|
| 0                | 11.3, 10.9    | 0.4       | 0       | 0              | 0      | 6.7, 6.5 | 0       | 18.4 | 1.7%      |
| 1                | 10.8          | 0.6       | 3.6     | 0              | 0      | 6.8   | (join)     | 21.8 | 2.1%      |
| 5                | 11.9          | 0.3       | 4.8     | 0              | 0      | 6.9   | 0          | 23.9 | 2.3%      |
| 20               | 12.1, 11.2    | 0.4, 0.5  | 5.5, 5.4 | 0             | 0      | 7.1, 6.8 | 0       | 25.1 | 2.4%      |
| 5, each following one | 11.1     | 0.3       | 6.8     | 9.9            | 0.8    | 7.0   | 0          | 35.9 | 3.4%      |
| 20, each following one | 11.3, 9.6 | 0.3, 0.5 | 11.2, 10.5 | 11.1, 10.8 | 2.6, 2.3 | 7.5, 6.5 | 0.4 | 44.4, 40.2 | 4.0%  |

- The engine tick does not change with viewers (phases with `PROFILE=1`, 0 against 20 following: crowd grid 0.28/0.29, senser 4.43/4.44, brain 4.66/4.59), so the viewer cost is exactly these pieces. System time adds 0.04 to 0.19-0.48 ms per tick (kernel socket work).
- The frame path is 1.7% of the tick with nobody watching (as in idea 48: that part is skipped there), 2.3-2.4% with plain viewers, 3.4-4.0% when viewers follow creatures.
- `ws.send` is 0.07-0.09 ms per 63 kB send. The upload budget (`frameBudget` 2.2 MB/s, `sendStride`) caps frame sends at about 35 per second whatever the viewer count (100 viewers each get a frame every 14th), so the send path is at most about 3 ms/s plus text. Not an opportunity.
- Sends are bound to frame size: every creature moves every tick, so "encode only creatures that moved" saves nothing and any delta scheme is a protocol change. Reusing the frame buffer is unsafe (`ws` queues the very `Uint8Array` until the socket drains). Allocation of the 63 kB array is in the noise (alloc.md).

## Ranked ideas (all leave the simulation and its fingerprint alone; wire bytes identical)

No single idea reaches 1.5% of the tick. The creature frame is 12.5 of 1053 ms/s (1.2%) and stats 0.75%, so even a free frame gather gives 1.1%. The three together reach 1.6% (no followers) to 2.4% (5+ followers).

1. Shared grid for `refreshWatched` (new finding). `LiveWorld.refreshWatched` calls `eco.refreshDetail()` once per due followed creature (up to 5 per frame at the 25/s allowance), and each call rebuilds the whole crowd grid (0.29 ms of 0.41) and does an O(n) `members.findIndex` (0.055). The world cannot change between those calls, so build the grid once per `refreshWatched` and look the member up by `byId`/`index`. Per call 2.3 ms (5 followed) to about 0.45. Saves 7-9 ms/s = 0.7-0.85% with 5+ followed creatures (0.3% with one). Detail bytes identical (same grid, same sense). About 15 lines (`Ecosystem.refreshDetail(rebuild = true)` or a batch method, `LiveWorld.refreshWatched`), test: details of N followed creatures equal before and after.
2. Fused creature frame, 2.5 ms to 1.3 ms in JS (measured), about 0.25 ms as a wasm kernel (projected, not built). One pass over `members`/rows straight into the `Uint8Array`: no 8 intermediate f32/i32 arrays, no `eco.get(id)` for the age, `Math.fround` where the old path went through `Float32Array`, and the two `%` (heading, hue) replaced by branches that are exact in range with the old `%` path as fallback. `fpProbe.ts` fused versions give 0 differing bytes of 62994 against `creatureFrame()` (three variants, one world state; the real test needs NaN, infinities, negative ids and headings of many turns). JS saves 1.3 ms/frame = 6.5 ms/s = 0.6%, 40 lines in `liveWorld.ts`/`protocol.ts`. The wasm kernel (rows via `rowAt` and `F.x/y/heading/energy/ticks`, ids and founders from `MemberTable` columns, hue is set after spawn for inserted creatures, so read it live) leaves about 0.05 ms of JS reads plus about 40 ns per creature of f64 math: saves about 2.3 ms/frame = 11.5 ms/s = 1.1%, 120-150 lines (`.wat`, wrapper, generated file, equality test over random rows including edge values). JS first, kernel only if the 0.5% extra is wanted.
3. Stats pass: threshold test and cached names. (a) The offer loop calls `Leaderboard.offer` 4 times per creature (13k calls, a key string and a closure each) to learn that almost none qualify. Values only grow while alive, so a creature whose value is strictly below the last entry of a full list can be skipped exactly; one pass computes the four board values, compares with the four thresholds and does best/depth in the same loop. Measured pass 0.34 ms (slow-path calls not counted, they are few once records are high; the probe world was young) against 3.8 + 0.8 now: saves about 4 ms per stats = 0.4%. (b) `namedTop` re-parses every family name each second (`wireName`, `toLowerCase`, key string): a `Map<rawName, parsed>` is exact (pure function of the string, bound it) and went 2.58 to 0.90 ms with equal output; the bench has 2974 families, the server a few hundred, so 0.15% there at most. Together about 0.5%, 40 lines in `chronicle.ts` and `leaderboard.ts`, tests: records and `lineages` equal on seeded runs (as in `liveNoViewers.test.ts`).

Also seen, below the bar: `encodeItems` (14 ms per joining viewer, 160 ns per item, DataView per field) could be 5x cheaper, a hitch per join rather than average load, joins bounded by the connect allowance. `takeDelta` and the feed are 0.03%. Ideas 11 (frames.md, rejected as small) and 91 (alloc.md, parked on `pl-alloc`) overlap with 2 and 3a; neither is in `perf-live` (the code still has the `eco.get` age, the `DataView` writes and the per-call key string).

## Caveats
- Numbers are one machine under load 13-29, CPU-time based; pieces are per-call means, the real-loop runs carry about +-1 ms/s noise (two 0-viewer runs: 18.4, 17.8).
- Percentages use 90 ticks/s at 11.7 ms; at the bench reference of 15.2 ms divide by 1.3. A server that cannot hold 90 ticks/s has a larger share per tick, the same ms/s.
- With idea 48 (skip while nobody watches) the frame costs vanish at 0 viewers, so ideas 2 and 3 only pay while watched; idea 1 only while someone follows a creature.
- All three are server code: push gate (3 Opus reviews) applies at the merge. None adds a visitor-controlled resource; idea 1 reduces the work a follower can cause.
