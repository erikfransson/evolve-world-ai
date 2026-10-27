# Production tick against liveBench (idea 45, study)

Question: does `liveBench` stand for the live server's tick, and is there server-side cost above 2% of the tick that an exact, general change could remove? Nothing built (server changes need the push gate).

## What the server reports (read-only, 2026-10-27 19:30, released code ae5699b, `main`)

- `./live check` and `status`: service up 10 h 49 min, 0 helper threads, `Memory 466M` (cap 1 G), RSS 514 MB now, peak RSS (VmHWM) 787 MB.
- Public `GET /stats`: 1893 creatures, 0 viewers.
- CPU from `/proc`: 8 h 08 min over 10 h 49 min = 75% of a core on average; 63% in a 10 s window (634 clock ticks of 100/s).
- The achieved speed (`stats.speed`) and tick ms are not in `status` or `logs`; they ride on the WebSocket stats message only, so I did not read them (a viewer connection would be a change to the server's state).
- Logs hold only the saves: 1.7 s, 4.9 s, 4.4 s tick stalls, one per 4 h (0.03% of the time).
- Scale: 63% of a core at speed 3 (90 ticks/s) is 7 ms per tick at 1893 creatures if it keeps full speed, about 3.7 ms per 1000 creatures. The bench gives 4.4 ms per 1000 (14.4 ms at 3306). Same order, bench slightly dearer per creature (the server's mix and the unknown speed shortfall could explain the gap). Unverified.

## Bench pairs (perf-live, `--seconds 60 --copies 800`, taskset 2,3,6,7, load 12-14)

| Pair | cpuMsPerTick plain | cpuMsPerTick --frames | frameMsPerTick | frameKBPerSecond |
|------|--------------------|-----------------------|----------------|------------------|
| 1    | 14.377             | 15.027                | 0.621          | 110              |
| 2    | 14.767             | 14.969                | 0.556          | 110              |
| 3    | 14.160             | 14.550                | 0.689          | 110              |
| median | 14.377           | 14.969                | 0.621          | 110              |

Fingerprint 708687555 in all six; steady population 3306; peak RSS 212-227 MB (frames add up to 12 MB).
`--frames` adds 0.59 ms per tick (4.1%) on cpuMsPerTick, which matches `frameMsPerTick`. That one is wall time on a loaded machine, so it overstates CPU.

Parts by CPU (`parts.ts` in the session scratchpad, 3322 creatures, one call each):

| Part                              | ms per call | per tick at the real rate |
|-----------------------------------|-------------|---------------------------|
| creatureFrame (63 kB), 5 Hz       | 4.3-4.7     | 0.25 ms (1.7%)            |
| stats (with observe), 1 Hz        | 9-13        | 0.10-0.14 ms (0.8%)       |
| takeDelta, no item changes        | 0.03        | 0                         |
| itemsFrame (full set, per new viewer) | 17     | not per tick              |
| death hook (3 leaderboard offers, 0.13 deaths per tick) | within noise (step 13.3-15.1 with, 13.4-14.7 without) | under 0.1 |

So encoding costs about 0.4 ms per tick CPU (2.6%); the bench's 0.6 ms is inflated by wall-clock under load.

## Fan-out (public.ts)

- Encoded once per frame: `lastCreatures = live.creatureFrame()` once in the 5 Hz `frameLoop`, `takeDelta` once, `feed.delta(...)` cached per distinct `lastFrame`, `itemsFrame()` once per frame when a viewer needs the full set. Stats JSON is stringified once and sent to all.
- Per viewer: only `ws.send` of the same `Uint8Array` (ws writes header plus the buffer unmasked, no copy in JS) plus the kernel copy. The 3 MB/s budget (`maxSendBytesPerSecond`) caps this at about 47 frame sends/s of 63 kB through round-robin `sendStride`, up to 100 viewers. Estimated at a few ms per second at most (about 0.03 ms per tick, not measured).
- `sendDetails` is per distinct selected creature (cached), `heartbeat` is a 1 Hz loop over viewers.
- The frame loop does not look at the viewer count: with 0 viewers (now) it still runs `creatureFrame`, `takeDelta` and, each second, `stats` with the full members offer loop.

## Left out by the bench

| Item | Size |
|------|------|
| Pacing: `advance`, `setTimeout`, 15 ms slices | negligible; the server idles when ahead (63% busy at 1893) |
| Periodic save (every 4 h): JSON, gzip in workers | 1.7-4.9 s stall per 4 h = 0.03%; the bench has `--save` for it |
| Admin channel, heartbeat, per-viewer message handling | idle or tiny; bounded by the abuse limits |
| Records in stats (every 5th) | one `snapshot()` copy of 3 short lists, under 1 ms per 5 s |
| Logging | a few lines per 4 h |
| GC and memory growth over days | server peak 787 MB against 227 MB in a 60 s bench; saves and long-lived lineages, not the tick |
| Viewers' sockets (kernel copies, TLS is in the Funnel not in node) | estimated 0.03 ms per tick, unmeasured |

The bench starts from a fresh seed at 3300 creatures, while the server world runs at 1900 with other lineages, so the per-creature cost differs a little. The engine phases dominate in both.

## Verdict

- The bench stands for the production tick to within about 3% of the engine cost plus the frame encoding (`--frames` is the closer match: 14.4 plain, 15.0 with frames at 3300 creatures). Engine ms per tick is the number that moves the server.
- Nothing server-side exceeds 2% of the tick except the creature frame at the edge (1.7%) and frames plus stats together (2.6%), and both are needed when someone watches.
- One exact, general candidate, not built. Idle skip: while `viewers.size === 0`, the frame loop skips `creatureFrame` (set `lastCreatures = null`, still `takeDelta` and `feed.push` so the item log stays complete) and `stats` skips the creature-offer loop in `Chronicle.observe`, running only the history and lineage sampling that needs no per-creature pass. A viewer who connects then gets items and creatures on the next 200 ms frame through the existing `lastCreatures === null` path in the connect handler, which `onReseed` and `forgetFrames` already exercise. Simulation state is untouched (fingerprint unchanged). Size: up to 0.35 ms per tick (about 2.4% of the 14.4 ms bench tick) only while nobody watches, zero with viewers. It changes what a first-second viewer sees (records of living creatures may lag one second), so it is not byte-exact on the wire; it needs the push gate (public attack surface and protocol reviews) and a test that a viewer joining after an empty period still gets a full set and frame.
- Not worth building: `eco.get` per creature in `creatureFrame` (idea 11, 0.08 ms), the per-viewer fan-out, saves.
- Open: read `stats.speed` and the real tick ms from a viewer-side stats message once, to check the 7 ms per tick estimate; the gap to the bench (3.7 against 4.4 ms per 1000) is unexplained.
