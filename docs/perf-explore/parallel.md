# Multi-core scaling at 20k worlds

Note: the shared-memory helper mode this write-up studies was removed (see `docs/perf-notes.md`).

Branch `worktree-agent-acfda11bfbd556398`, 2026-10-11. World 20000 x 12500 (same aspect and densities as the default 12000 x 7500, 2.8x the area), founders 2800 and 5000, WebAssembly on, shared-memory helpers.

| Idea                                                                                    | Before (ms/tick, 7 threads, pop 2800) | After | Speedup | Exact? | Verdict |
|-----------------------------------------------------------------------------------------|---------------------------------------|-------|---------|--------|---------|
| Helpers also do memory, motion and the item lookup for their creatures (coordinator too) | 14.3 (H=6), 16.5 (H=4), 20.0 (H=2)    | 11.6, 13.4, 17.5 | 1.23x, 1.23x, 1.15x | bit-identical | Recommended, 154 lines changed |
| Same, pop 5000                                                                          | 25.7 (H=6), 28.8 (H=4), 33.7 (H=2)    | 20.3, 24.4, 30.5 | 1.27x, 1.18x, 1.10x | bit-identical | same |
| Serial fraction of a tick                                                                | 30% (9.5-10.4 of 31.4 ms)             | 19% (5.7-6.1 ms) | Amdahl ceiling 3.3x to 5.3x | | |
| Work stealing instead of the static split                                               | n/a                                   | n/a   | at most 1.02x | would be exact | Not worth it, imbalance is 2-7% |
| State permanently in shared memory (no publish/collect copies)                          | not built                             | est. -2 ms of ~6 serial | est. 1.1x | exact | Promising, large refactor |
| Spatial strips for collisions                                                            | not built                             | est. -2 to -3 ms | est. 1.1x | needs care | Untried |

## How it was measured

The machine was shared (load average 40-60 on 8 logical cores, 4 physical) the whole time, so wall-clock ms/tick is useless: at 4 helpers the wall time was often worse than serial. Everything above is the per-tick critical path rebuilt from thread CPU time (`process.threadCpuUsage`), which does not count time spent preempted:
model = coordinator CPU outside its own sensing + max(coordinator sensing CPU, slowest helper CPU).
This leaves out barrier wake-up latency and counts hyperthread slowdown, so it is a no-contention estimate, not a wall-clock promise.
CPU clock granularity is about 1 ms, so single numbers are good to roughly +-1 ms. Values are medians of the last two thirds of 100 ticks (80 at pop 5000), 3 alternating before/after rounds at pop 2800, 2 rounds at 5000.
Scripts (not committed): `cpumodel.ts`, `cpuhelper.ts`, `scale.sh`, `fp.sh` in the scratchpad `perf-explore` folder.

Scaling curve, pop 2800, model ms/tick (speedup over 1 thread, 31.4 ms):

| Helpers | Threads | Before         | After          |
|---------|---------|----------------|----------------|
| 0       | 1       | 31.4 (1.00x)   | 31.5 (1.00x)   |
| 1       | 2       | 23.3 (1.35x)   | 21.4 (1.47x)   |
| 2       | 3       | 20.0 (1.57x)   | 17.5 (1.80x)   |
| 3       | 4       | 16.8 (1.87x)   | 15.3 (2.05x)   |
| 4       | 5       | 16.5 (1.90x)   | 13.4 (2.34x)   |
| 6       | 7       | 14.3 (2.20x)   | 11.6 (2.71x)   |

Pop 5000 (1 thread 56.3 ms): H=2 33.7 to 30.5, H=4 28.8 to 24.4, H=6 25.7 to 20.3 (2.19x to 2.78x).
Serial phase CPU at pop 2800 (before / after): publish 1.0, collect 0.2-0.4 / 1.0, finish (memory, motion, eating, collisions, settle, births, regrowth) 6.5-7.0 / 2.0. The remaining 6 ms serial is publish + collect + finish + pool bookkeeping.

## What dominates at 20k+

- One tick at 2800 creatures costs 31 ms on one thread. About 22 ms is sensing and thinking (already parallel), the rest was serial.
- Serial coordinator work before: copy state into the packet (1 ms), crowd rebuild (1 ms, also done by each helper in parallel), memory update and motion (`remember`, `steer`, about 5 ms), eating lookups (about 4 ms of `eatAt`), collisions (about 3 ms), settle, births, regrowth (2 ms), copy results back (0.3-1 ms). Memory, motion and the eating lookup were 9 of the 10 ms and touch only one creature.
- Barriers: shared mode has 2 per tick (epoch bump and notify, done counter), the minimum for this design because the coordinator's shared phase must finish before the next tick's state exists. Fork-join by messages has the same two plus a copy per helper. Not reducible without pipelining ticks, which would change results.
- Balance: static assignment at birth to the least loaded thread (cost genome length + 30 per ray). Slowest helper vs mean helper CPU: 2-7%. The coordinator's share is up to 5% heavier because it also rebuilds the crowd. Chunked work stealing could win at most about that margin (0.3 ms at 7 threads), so it was not built.

## What was done

Moved the per-creature, order-independent tail of phase 1 and the lookup half of eating onto the thread that owns the creature:

1. Each helper (and the coordinator for its own creatures) runs `remember()`, `steer()` and `touched()` (the first item in reach, new `Creature.touched`/`consume` split of `eat`) right after thinking, and writes the new state, memory and the item index into result columns of the packet.
2. The coordinator copies those results into its creatures (`collect`) and the shared phase uses the looked-up item. Eating still walks creatures from a random start; items are only removed in that loop, so a looked-up item that is still present is still the first one touched, a looked-up "none" stays none, and an item an earlier creature took is looked up again on the coordinator. That is exactly what the serial code returns.
3. The packet now also publishes heading angle and ticks alive; helpers set the ageing rule on their creatures (`agingOf` in physics.ts shared with Ecosystem).
4. Because own creatures are now advanced before the join, a failed helper tick would leave them moved. `ThinkPool` calls `ShareCoordinator.undoOwn` (restores from the published packet) so the one-thread fallback still reproduces the same result (the three fallback tests in ecoPool.test.ts caught this).

Serial `Ecosystem.step()` is unchanged.

## Exactness

Fingerprints equal for every variant:
- 20000 x 12500, pop 2800: 58317937 for before and after at H = 0, 1, 2, 3, 4, 6 (3 rounds each); pop 5000: 460757444 for H = 0, 2, 4, 6.
- Default world, pop 1000, 60 s, with ageing and collision damage (159 births, 893 deaths): before serial, after serial, shared 1, 2, 3, 4, 6, fork-join 2 and 4 all 925921551.
- `tsc --noEmit` clean; vitest 366 of 368 pass. The two failures (`cli.test.ts` bench thread-count and buildPool) hit their 20 s timeout under load 50, in code this change does not touch.

## Promising but untried

- State in shared memory permanently: creature x, y, vx, vy, energy, turn rate, heading as SoA views of the packet, so publish and collect (2 ms) disappear and the shared phase reads and writes the columns directly. Estimated -2 ms of 6. Touches every user of `CreatureState`, so it is the large refactor.
- Collisions in parallel: pairs resolve in grid order and a bounce moves bodies into other pairs, so a plain split by strips changes results. An exact version needs a dependency order per creature (strip interiors first, boundary rows after) or a conservative candidate pair list built in parallel with a serial fallback check. Collisions are about 3 ms of the 6 ms serial.
- Births and settle are 1-2 ms and order dependent (random start, shared RNG), leave serial.
- Overlapping publish of tick t+1 with the collision pass is not possible, the packet needs the final positions.

## Cost

6 files, +154/-37 lines (ecoShare.ts +115, ecosystem.ts +39, creature.ts +17, ecoPool.ts +9, physics.ts +5), plus `--width`/`--height` flags in ecoBench.ts.
