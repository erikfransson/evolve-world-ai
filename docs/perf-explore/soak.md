# Idea 73: end-to-end soak of the perf-live server (validation)

Question: does the perf-live branch (fd6b311) run as a server for an hour without errors, at speed, with bounded memory?

## Setup
- `node --max-old-space-size=768 src/main.ts` from this worktree as the unit does, `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, 0 helper threads. Own ports (public 18787, admin 18788), fresh temporary state dir and token, no web root; the production service was not touched.
- Fresh Inland Sea world, live config. `seed-copies` set to 300, so the start is 1200 creatures (4 founders x 300) instead of the default 40, to reach the cap region within minutes.
- One scripted viewer for the whole run (reads frames and stats, sends the page's `ping` every 10 s; a viewer that stays silent is dropped as idle after about a minute, which cost a restart of the monitor in the first 7 minutes). Per minute it logs the stats message's speed and population and the server's VmRSS and VmHWM from `/proc`.
- `save-now` through the admin channel at minute 15 and 40 of the monitored hour. A second viewer joined at minute 25.
- The server was up about 67 minutes (7 before the monitored hour); the table below is the monitored hour.

## Results (60 one-minute samples)
| Item                         | Value |
|------------------------------|-------|
| Speed, mean of the samples   | 2.50 (target 3; min 1.16, max 3.16) |
| Speed at population >= 2500  | 2.20 (34 samples) |
| Speed at population < 2500   | 2.88 (26 samples) |
| Population range             | 1261 to 3414 (see below) |
| VmRSS                        | 266 to 478 MB |
| Peak VmHWM                   | 478 MB (at about 1400 to 3400 creatures) |
| Errors or warnings in log    | none (4 lines: start, ports, saves) |
| Process exit on SIGTERM      | clean: final save (15 MB json, 22 ms stall), exit |

- Population is a boom and bust cycle, not a plateau: 1200 start, 3200 at minute 1, 1360 at 13, 3400 at 27 to 28, 1260 at 37, 3400 at 48, 1400 at 60 (births and deaths about 200 000 each). The tick cost follows it: speed 3.0 near 1500 to 2200 creatures, 1.2 to 2.9 above 2800.
- Speed is held below 3 above about 2500 creatures by the shared cores (load average 6 to 14 on the pinned cores during the run), not by the server: a one-thread tick at 3300 creatures costs about 15 ms CPU in the bench, which is 66 ticks/s against the 90 needed for 3x. Production CPU was 63 to 75% of a core at 1893 creatures (prod.md), so full speed above about 2800 creatures was not expected on one core either.
- Viewer traffic: about 283 frames and 8 to 19 MB per minute, one full items set (168 kB) on connect and then deltas only.

## Saves
| When                | Trigger        | Tick stall | Admin round trip | Json  |
|---------------------|----------------|-----------|------------------|-------|
| start (fresh world) | startup        | 149 ms    | n/a              | 19 MB |
| minute 15           | admin save-now | 42 ms     | 15.1 s           | 19 MB |
| minute 40           | admin save-now | 44 ms     | 13.3 s           | 19 MB |
| stop (SIGTERM)      | shutdown       | 22 ms     | n/a              | 15 MB |

The stall is the snapshot on the tick loop; packing, gzip and the restore check run on a worker (the round trip). No tick-visible effect on the speed samples around minutes 15 and 40. RSS after a save: HWM rose 380 -> 442 MB (minute 15) and 457 -> 464 MB (minute 40), so a save costs up to about 60 MB over the running footprint at this population. The admin `save-now` replies in the log are not echoed to the server log; only the startup and stop saves are.

## Second viewer
Joined at minute 25 and received hello, stats, a full ITEMS frame (130 kB, the first binary message) and then a full CREATURES frame (64 kB), then 284 frames a minute like the first viewer (10 070 frames by the end, 1 items set). Viewer count in stats went 1 to 2 and both ran to the end with no drop.

## Memory against production
Production (prod.md, released `main`): 514 MB idle, 787 MB peak after 10.8 h at 1893 creatures. This soak: 266 to 478 MB, peak 478 MB, at up to 3414 creatures after 67 minutes. The peak is lower at a higher population, but the runs are not comparable on time: the production peak comes from hours of saves and long-lived lineages, which 67 minutes does not cover (idea 47 and the spare-pool cap, idea 54, address that side). Within the hour RSS rose in steps (317 -> 442 -> 464 -> 478 MB HWM) tied to population peaks and saves, and stayed flat from minute 55 to 60 while the population fell. No unbounded growth was seen, but 60 minutes cannot rule out a slow one; a longer soak (6 h or more) would be the check.

## Verdict
The branch runs as a server: no log errors, saves through the admin path work with 22 to 44 ms stalls, a late viewer gets a full frame, shutdown is clean, RSS far under the 1 GB cap. Speed met 3x only at populations below about 2500 on the shared cores, as expected from the tick cost.
