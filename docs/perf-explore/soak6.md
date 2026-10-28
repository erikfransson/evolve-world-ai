# Idea 81: 6 h soak of the perf-live server (validation)

Question: with ideas 75 to 77 and 59 merged (kernel release on drop, save retry, stop budget, cheaper births), does the server stay bounded over 6 hours? Repeats soak.md (60 min, peak 478 MB).

## Setup
As soak.md: `node --max-old-space-size=768 src/main.ts` from the perf-live code (f0941e3), pinned `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, 0 helper threads, ports 18787/18788, fresh temp state dir and token in the scratchpad, `seed-copies` 300 (1200 start), production untouched. One viewer sending the text `ping` every 10 s, one sample a minute (stats speed and population, VmRSS and VmHWM from /proc). Admin `save` at hours 1, 3, 5, the 4 h periodic save once, SIGTERM at 6 h by PID. 360 minute samples, no gaps.
Monitor note: the first monitor sent the ping as JSON, so the server dropped it every 15 s (4 reconnects a minute) for the first 5 minutes; it was restarted with the correct ping and has one connection since. Minutes 1 to 5 therefore include reconnect churn.

## RSS per hour (MB; 60 samples each)
| Hour | min | mean | max | HWM at end | Population | Speed mean (min) |
|------|-----|------|-----|-----------|------------|------------------|
| 1    | 261 | 329  | 380 | 382       | 1316-3492  | 2.94 (2.28) |
| 2    | 409 | 420  | 426 | 550       | 1318-3460  | 2.94 (2.19) |
| 3    | 424 | 427  | 431 | 550       | 1352-3460  | 1.84 (0.75) |
| 4    | 311 | 397  | 444 | 550       | 1309-3430  | 2.36 (1.13) |
| 5    | 401 | 410  | 478 | 554       | 1324-3404  | 2.55 (0.85) |
| 6    | 436 | 447  | 487 | 554       | 1287-3425  | 3.06 (2.29) |

Overall speed mean 2.61 (target 3). Speeds under 2 in hours 3 to 5 coincide with load average about 25 on the shared cores (uptime at 8:51), not the server (hour 6 ran at 3.06).

## Does RSS return after a population crash
No. Mean RSS at population below 1500 against above 3000, per hour: h1 317/340, h2 420/420, h3 428/426, h4 344/416, h5 408/418, h6 447/445. RSS follows a ratchet, not the population: it steps up once to about 420 MB in hour 2 (HWM 550 MB came from the 1 h admin save) and then sits at 400 to 450 whatever the population, with dips only after a save (311 MB in hour 4). The kernel release and pool cap bound the growth, but V8 does not hand the heap back at troughs. The last 8 minutes (population 1287 to 2012) read 451 MB flat, higher than the hour-1 troughs (261 to 317 MB) and about 30 MB above the hour-2 plateau. Slow creep: hourly means after the plateau 420, 427, (397), 410, 447. A rise of roughly 5 to 10 MB an hour cannot be excluded from 4 plateau hours, but it is small against the 768 MB heap cap and the saw-tooth is larger than the trend.

## Saves
| When                  | Trigger        | Tick stall | Admin round trip | Json  | Retry |
|-----------------------|----------------|-----------|------------------|-------|-------|
| start (fresh world)   | startup        | 92 ms     | n/a              | 19 MB | no |
| 1 h                   | admin save     | 40 ms     | 6.5 s            | 24 MB | no |
| 3 h                   | admin save     | 130 ms    | 22.1 s           | 20 MB | no |
| 4 h                   | periodic       | 89 ms     | n/a              | 25 MB | no |
| 5 h                   | admin save     | 27 ms     | 5.5 s            | 17 MB | no |
| 6 h                   | SIGTERM (stop) | 18 ms     | n/a              | 18 MB | no |
SIGTERM exit code 0, stop save written. HWM: 382 MB before the first save, 550 MB after the 1 h save (the save is the peak, as in soak.md: up to about 100 MB over running), 554 MB at the end.

## Errors and warnings
None. `grep -ci "warn|error"` on the server log gives 0; the log holds only startup, the saves above and the ready line. No `save retry` line. Admin save replies show only in the admin CLI output, not the server log.

## Population
Boom and bust as in soak.md: 1287 to 3492 in every hour, no collapse and no cap hit (5000), births and deaths continuing to the end.

## Against soak.md and production
- soak.md (60 min): peak 478 MB, RSS 266 to 478. Here hour 1 matches (HWM 382, RSS to 380), hours 2 to 6 plateau at 400 to 450 with max 487 and HWM 554.
- Production (prod.md): 514 MB idle, 787 MB peak at 10.8 h at 1893 creatures. The soak peaks at 554 MB at up to 3492 creatures, 230 MB lower, and its plateau (about 430) is under production's idle.

## Verdict
Pass. 6 h with no errors, no retries, stalls 18 to 130 ms, RSS plateau 400 to 450 MB with a 554 MB save-time peak, far under the 1 GB cap and under production. RSS does not shrink at population troughs and may creep a few MB an hour, so a 12 h or longer run would settle the trend; no unbounded growth seen.
