# Deep profile of the live server process (idea 133, study)

Question: where does the whole CPU of the real server process go, outside the engine phases the bench times, and is any of it worth 1.5% or more?
Nothing built. Branch `pl-deepprof` from `perf-live` a63560d.

## Setup

- The production command from `server/evolve-live.service.template`: `node --max-old-space-size=768 src/main.ts` in `server/`, 0 helper threads, fresh state dir with a `seed-copies` file, ports 18987/18988, empty web root, all under `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`.
- Mixed: 4 founders x 800 (3200 seeded, 3080-3330 in the windows). Cap: Juggernaut alone x 4900 (it crashed to 2422 during the run, so the cap rows are a mix of 4900 down to 2400).
- Viewers: a ws client process (4 viewers, 2 of them follow a random creature, re-picked every 20 s, text `ping` every 15 s), 1.0-1.5 MB/s of frames.
- A preload (`--import probe.mjs`, session scratchpad `deepprof/scripts/`) wraps `Ecosystem.step`, the `LiveWorld` methods, `Chronicle.observe`, `whenIdle` jobs by kind, `WebSocket.send` and `advance` with `process.threadCpuUsage()`, records the gaps between slices, event-loop delay (`monitorEventLoopDelay`, 10 ms) and per-thread CPU from `/proc/self/task`. Windows start 130 s after process start (after build, seeding, the start save and wasm tier-up) and end before the exit save.
- Load average 22-26 on 8 cores for runs R1-R10, 6-8 for R11 and 7 rising to 20 during R12. Under that load the server got 330-515 ms of CPU per second and stayed behind (speed 0.8-1.4 of 3) at 3300 creatures.

## Attribution of the process CPU (probe, clean runs without a profiler)

ms of CPU per wall second and share of the whole process.

| Run | Viewers | Pop | Ticks/s | Process ms/s | Engine step | Tick rest | creatureFrame | refreshWatched | ws.send | Stats (chronicle) | Gap rest | Other threads |
|-----|--------:|-----|--------:|-------------:|-------------|-----------|---------------|----------------|---------|-------------------|----------|---------------|
| R4  | 0 | 3287-3091 | 32.8 | 382 | 336.5 88.1% | 2.2 0.6% | 13.0 3.4% | 0     | 0       | 8.2 2.2% | 16.2 4.2% | 5.3 1.4% |
| R3  | 4 | 3223-3081 | 34.3 | 414 | 356.3 86.1% | 2.4 0.6% | 13.1 3.2% | 5.3 1.3% | 5.6 1.3% | 8.5 2.1% | 15.6 3.8% | 6.5 1.6% |
| R9 (`--trace-gc`) | 4 | 3246-3086 | 43.9 | 515 | 454.7 88.3% | 2.9 0.6% | 12.9 2.5% | 5.2 1.0% | 5.3 1.0% | 8.4 1.6% | 17.3 3.4% | 7.2 1.4% |
| R6 cap (`--cpu-prof`) | 4 | 4900-2422 | 23.3 | 343 | 263.3 76.7% | 1.7 0.5% | 19.5 5.7% | 7.4 2.1% | 6.1 1.8% | 11.7 3.4% | 9.7 2.8% | 23.5 6.9% (profiler 17) |
| R10 ahead | 0 | 750 (cap set to 800) | 90.0 | 320 | 275.7 86.1% | 2.9 0.9% | 2.1 0.6% | 0 | 0 | 1.8 0.6% | 34.9 10.9% | 2.5 0.8% |

- Tick rest: `advance` and `tick` outside `eco.step` (collectOps, maybeReseed, the await): 0.5-0.9%.
- Per call: creatureFrame 2.8-2.9 ms at 3200 (4.3 ms at the cap mix), `Chronicle.observe` 8.0-8.3 ms (11.3 cap), refreshWatched 1.05-1.14 ms (1.64 cap) for at most 2 followed creatures, `ws.send` 108-123 us. Detail and genome encodes, takeDelta, hello and history are under 0.2% together.
- The frame job (5 Hz) and the stats job (1 Hz) run on wall time, not ticks, so their share grows when the server is starved: 5.6% of the process at 0 viewers and 8.0% with 4 viewers here, against about 2% and 3% for a server that gets a full core.
- Gap rest: main-thread CPU between two slices outside the frame and stats jobs (timers, the event-loop turn, sleep and wake, GC finalisation, ws message handling). It is 0.5 ms per gap at 32 gaps a second when behind, and 0.53 ms per wake at 62 wakes a second when ahead (R10).
- Other threads: V8 worker threads (concurrent GC, tier-up) 2-7 ms/s. The save worker threads only at saves (not in the windows).
- GC (R9, main isolate, 190 s steady): 58 scavenges a minute, 2.9 ms each (wall under load), 2.8 ms/s, plus 0.9 mark-compacts a minute, 0.45 ms/s: under 1% of the process. The server allocates far more than the bench (alloc.md saw one scavenge per 10 s), but GC is still not a lever.

## Event loop and the tick scheduler

- Behind (R3, R4): slices run 806-821 ms of wall per second, the gaps 179-194 ms, of which only 38-49 ms are on the CPU. Each gap is a `setTimeout(loop, 0)` (1 ms in Node) and under SCHED_IDLE on a busy host the thread then waits for the CPU: mean gap 5.5-6.0 ms of wall for 1.2-1.5 ms of CPU.
- Event-loop delay p50 29-30 ms, p99 58-63 ms, max 380-410 ms (one slice is at least one tick, about 30 ms of wall under this load). Ahead (R10) p50 14 ms, p99 35 ms.
- Ahead (R10): `setTimeout(loop, wait)` asks 5.3 ms on average and fires 1.7 ms late; 62 wakes a second for 90 ticks.
- Loop floor without the engine (`micro/loopfloor.mjs`, 12 ms burst per slice, same pinning): `setTimeout(0)` costs 0.146-0.149 ms of CPU and 3.6-3.8 ms of wall per gap, `setImmediate` 0.007-0.014 ms and 0.08 ms; the burst got 349-370 ms/s of CPU against 437-454. A 3 ms burst with `setTimeout(8)` costs 0.18 ms of CPU per wake.

In-process A/B (the probe swaps the loop's timer every 30 s, same process, same world, paired with the two neighbouring windows):

| Run | Change | Load | Windows | Ticks/s | CPU ms/s | CPU ms per tick | Paired ticks/s ratio |
|-----|--------|------|---------|---------|----------|-----------------|----------------------|
| R8, 3300, 4 viewers | behind: `setTimeout(0)` -> `setImmediate` | 22-25 | 10 / 10 | 39.35 -> 46.30 | 460.9 -> 528.0 | 11.715 -> 11.403 (-2.7%) | 1.217 (9 pairs, 0.979-1.327) |
| R7, 3300, 0 viewers | same | 22-25 | 4 / 5 | 34.25 -> 43.06 | 427.8 -> 526.2 | 12.490 -> 12.218 (-2.2%) | 1.183 (3 pairs, 1.161-1.274) |
| R12, 3300, 4 viewers | same | 7-20 | 7 / 7 | 35.79 -> 45.65 | 427.1 -> 525.7 | 11.935 -> 11.517 (-3.5%) | 1.225 (6 pairs, 1.028-1.661) |
| R11, 750 (cap 800), 0 viewers | ahead: wait 22 ms longer (about 3 ticks per wake) | 6-8 | 6 / 7 | 89.98 -> 89.97 | 324.6 -> 318.6 | 3.608 -> 3.541 (-1.9%) | 1.000, CPU ratio 0.982 (5 pairs) |

R7 was meant as an ahead run, but the world grew from 600 to 3300 in two minutes, so it is a second behind A/B. In R11, at load 6-8, the 750-creature server was behind in 23 of its 42 slices a second (wakes fire 5.8 ms late), so the batching only touched 29 wakes a second.

## `--cpu-prof` (R1 0 viewers, R2 4 viewers, R6 cap; 500 us interval, main thread)

Shares of the busy samples (wall-weighted; under this load the sampler gets about 100 samples a second, and sample-count weighting gives the same shares).

| Context | R1 0 viewers | R2 4 viewers | R6 cap |
|---------|-------------:|-------------:|-------:|
| engine step | 90.1% | 86.9% | 82.8% |
| creatureFrame | 5.1% | 4.7% | 6.8% |
| Chronicle.observe | 2.6% | 2.3% | 3.4% |
| refreshWatched | 0 | 2.2% | 2.8% |
| sendFrames (writev) | 0 | 0.9% | 1.1% |
| sendDetails | 0 | 0.7% | 0.8% |
| GC (main thread) | 0.6% | 0.7% | 0.7% |
| tick rest, timers, node internals, (program) | 1.3% | 1.1% | 1.0% |

Top self time outside the engine step, R2 (share of busy samples): `encodeCreatures` 2.61% (DataView writes, two float `%` per record), `creatureFrame` 2.04% (the inlined `readCreatures` and the age loop through `eco.get`), `writev` 1.05%, `observe` 0.77%, `Leaderboard.offer` 0.39%, the `findIndex` closure in `refreshDetail` 0.31%, `forEachLiving` 0.25%, `namedTop` and its callback 0.36%, `Chronicle.offer` 0.16%, `encodeDetail` 0.14%, `get ageTicks` 0.14%, the name regex in `validName` 0.20%, ws `Sender.send` 0.10%, `listOnTimeout` 0.09%. Nothing else above 0.1%.
refreshWatched is 70% the crowd grid rebuild (`gridCrowd` once per refreshed creature) and 25% the `findIndex` over the members.
Micro split of creatureFrame at 3330 (`micro/frameparts.ts`, min wall right after a tick): readCreatures 0.35 ms, ages via `eco.get` 0.42 ms (0.29 via `members[i]`), `encodeCreatures` 1.55 ms, whole 2.41 ms.

`--prof` (R5) is not usable on this host: the sampler thread runs at idle priority and took 7253 ticks in 7 minutes, mostly the map build, the module compile and the exit save's parse worker, plus its own log writes (fputc 2.1%).

## Ranked ideas (exact for the simulation, nothing on the wire changes format)

| # | Idea | Measured bound | Lines | Notes |
|---|------|----------------|------:|-------|
| 1 | Behind path of `runTicks` (`liveWorld.ts`): `setImmediate` instead of `setTimeout(loop, 0)` when `advance` returns 0 | CPU per tick -2.2 to -3.5% (R7, R8, R12), gap rest 16 -> 10 ms/s; ticks/s +18 to +22% on this loaded host (R12: -3.5% and +22.5%) | 1-2 | Fingerprint untouched (only when ticks run). Timers and sockets still run every loop turn (libuv polls with timeout 0 while immediates wait). The server no longer sleeps 1 ms per slice while it is behind, so it takes more of the CPU that other idle-class jobs would get; nice 19 and SCHED_IDLE still yield to everything interactive. Server code: push gate |
| 2 | Idle skip while no viewer is connected (idea 48, built on `pl-noviewers`) | creatureFrame 13.0 + chronicle per-creature work up to 8.2 ms/s = 5.6% of the process at 3300 and 0 viewers (R4); about 12 ms/s, 1.7%, at the production 1900 creatures on a full core | about 40 changed server lines plus a 140-line test (built) | A viewer joining an idle server gets its first frame up to 200 ms later. Merges cleanly except liveBench.ts. Production had 0 viewers at the last checks |
| 3 | Fewer wakes when ahead: wait at least about 2 ticks more (or until 3 are owed) before the next slice | CPU per tick -1.9%, ticks/s unchanged (R11, 5 pairs); R10 shows 35 ms/s (10.9%) of gap CPU at 62 wakes a second under high load, so the bound is larger on a busy host | 2-3 | Frames then show the world up to 22 ms of wall older; tick count unchanged (the owed clock counts real time, maxCatchUpS is 1 s). Combine with 1 as one scheduler change |

Below the bar alone, worth one bundle only if the viewer path is touched anyway (with viewers, about 10-12 ms/s, 2.5-3% here, about 1% on a full core): byte writes in `encodeCreatures` and ages from `members[i]` (frames.md, about 1.5 ms per frame), `Chronicle.observe` offers only for creatures that beat a board's last entry or are on it (same condition as `Leaderboard.offer`, about 2.5 ms per call), and one crowd grid per `refreshWatched` call plus an id lookup instead of `findIndex` (about 0.5 ms per extra followed creature). Not levers: `ws.send` (1.0-1.8%, the kernel copy per viewer, bounded by the 3 MB/s budget), GC (under 1% main thread plus 1-1.6% V8 workers), timers, logging, the admin port, the tick wrapper (0.6%).

## Verdict

The engine step is 86-91% of the process in every steady run. Outside it, the server's own frame and stats work is 5.6% at 0 viewers and 8% with 4 viewers on this starved host, and the scheduler costs a further 4% of the CPU and about a fifth of the tick rate when the host is busy. Ideas 1 and 3 together are a few lines in `runTicks`/`advance` and are the cheapest win found in the campaign for a loaded host; idea 2 is already built and is the bigger CPU cut while nobody watches. All three are server code under the push gate.
