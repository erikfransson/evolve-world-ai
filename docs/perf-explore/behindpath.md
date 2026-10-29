# Behind path of the tick loop: setImmediate instead of setTimeout(loop, 0) (idea 144)

Idea 1 of `deepprof.md`. Branch `pl-deepprof`. Server code, so the push gate applies (not run here, not pushed).

## What changed

`runTicks` (`server/src/liveWorld.ts`): when `advance` returns 0 (more ticks owed than the slice ran), the next slice is queued with `setImmediate` instead of `setTimeout(loop, 0)`. Every other return (ahead, paused, a failed tick) keeps `setTimeout(loop, wait)`.
Node clamps `setTimeout(0)` to 1 ms, so a behind server slept after every 15 ms slice. Under SCHED_IDLE on a busy host it then waited several ms to get the CPU back (deepprof.md: 5.5-6 ms of wall and 0.5 ms of CPU per gap).

Bounds that stay as they were, all in `advance`: at most `sliceMs` (15 ms) of ticks per event-loop turn, the catch-up cap (`maxCatchUpS`, 30 ticks owed at most), the pause, the failure count and the exit after `maxTickFailures`, and the stop and save paths (they run between ticks through `whenIdle`, which does not depend on the timer). libuv runs the timers phase and polls sockets with a zero timeout on every turn while an immediate is queued, so the frame and stats loops, the heartbeat, the admin port and visitors' messages are served between slices as before. The engine and the wire are untouched (`liveBench` does not use `runTicks`, so its fingerprint cannot change).

## Why the trade-off is right on the production host

While behind, the server no longer hands the CPU to other idle-class jobs after each slice.
- The unit runs at nice 19 under SCHED_IDLE, so every normal-priority task (Erik's own work, the desktop) still preempts it at once. The laptop stays as responsive as before.
- The 1 ms sleep was not a chosen yield. It is Node's clamp of a zero timeout, and it gave other idle-class jobs a free turn after every slice while visitors watched a world running below its set speed.
- Behind, the server now competes with other idle-class jobs on equal terms instead of losing a turn per slice. Ahead, the normal state at the production population, nothing changes: it still sleeps until the next tick is due.
- Memory and the CPU quota of the unit are unchanged, and the slice budget still bounds every turn.

## Tests (`tests/typescript/liveSync.test.ts`, 3 new)

- Behind with no work per slice, the loop runs more than 1000 slices in 300 ms. Red with `setTimeout(loop, 0)`: 80 slices.
- Behind with 10 ms of work per slice, a viewer gets its hello, a `ping` gets its `pong` and a 30 ms timer fires while the loop runs. Red with a microtask loop on the behind path: the test hangs (killed at 120 s).
- A 10 s stall on a mocked clock: the catch-up takes several behind slices and runs between cap - 1 and cap + 15 ticks. Red without the cap in `advance`: 1092 ticks.
- Pinned, `--maxWorkers=2`: `vitest run live publicLeak ecoLive` 19 files, 310 tests, exit 0. Full suite 122 files, 1260 tests, exit 0. `tsc --noEmit` in `server/` exit 0.

## Measured on the built code

In-process A/B: the probe (`deepprof/scripts/probe_rev.mjs` in the session scratchpad) turns the loop's behind-path `setImmediate` back into `setTimeout(loop, 0)` every other 30 s window of one server process. 3300 mixed creatures, pinned to 2,3,6,7 at nice 19 idle, load 28-35. Windows from 100 s after start.

| Viewers | Windows (old / new) | Ticks/s old -> new | CPU ms/s | CPU ms per tick | Paired ticks/s ratio |
|--------:|---------------------|--------------------|----------|-----------------|----------------------|
| 0 | 5 / 4 | 33.76 -> 39.91 | 382.0 -> 442.8 | 11.315 -> 11.096 (-1.9%) | 1.167 (4 pairs, 1.072-1.308) |
| 4 | 5 / 4 | 33.55 -> 41.83 | 384.7 -> 477.6 | 11.465 -> 11.416 (-0.4%) | 1.232 (4 pairs, 1.019-1.453) |

Before the build, the same A/B with the switch the other way round (deepprof.md R7, R8, R12, load 7-25) gave ticks/s 1.18-1.23 and CPU per tick -2.2 to -3.5%.

## Verdict

One line of loop code and 80 lines of test. On a busy host the behind server runs 17-23% more ticks per second, and its CPU per tick is equal or a little lower (-0.4 to -3.5%). Ahead nothing changes. Merge after the push gate.
