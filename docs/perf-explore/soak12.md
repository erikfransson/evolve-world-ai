# Idea 118: 12 h soak of the perf-live server (creep check)

Question: soak6 plateaued at 400 to 450 MB from hour 2 with a possible creep of a few MB an hour. Over 12 h, does RSS keep rising?

## Setup
As soak6.md, from perf-live head 81d38d2 (idea 117): `node --max-old-space-size=768 src/main.ts`, pinned `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, ports 18787/18788, temporary state dir, `seed-copies` 300 (1200 start), one viewer sending text `ping` every 10 s (1 connection, no reconnects), one sample a minute (720 samples). Admin `save` at 2, 6, 10 h, periodic saves at 4, 8, 12 h, SIGTERM at 12 h by PID (exit 0). Two false starts (missing seed-copies) were discarded; the run below is the third.

## RSS per hour (MB)
| Hour | min | mean | max | HWM at end | Population   | Speed mean (min) |
|------|-----|------|-----|-----------|--------------|------------------|
| 1    | 283 | 346  | 410 | 415       | 1325-3425    | 3.00 (2.04) |
| 2    | 298 | 375  | 421 | 421       | 1316-3365    | 3.04 (2.43) |
| 3    | 419 | 426  | 433 | 587       | 1289-3438    | 3.01 (2.60) |
| 4    | 304 | 391  | 461 | 587       | 1349-3501    | 2.54 (1.26) |
| 5    | 430 | 439  | 445 | 587       | 1352-3469    | 2.52 (1.28) |
| 6    | 446 | 447  | 448 | 587       | 1340-3507    | 1.35 (0.76) |
| 7    | 407 | 423  | 447 | 587       | 1325-3478    | 2.26 (0.92) |
| 8    | 441 | 447  | 452 | 587       | 1345-3475    | 2.93 (1.91) |
| 9    | 451 | 457  | 468 | 587       | 1365-3540    | 1.60 (0.62) |
| 10   | 332 | 456  | 468 | 587       | 1331-3464    | 2.42 (0.95) |
| 11   | 346 | 430  | 455 | 587       | 1346-3452    | 2.75 (1.63) |
| 12   | 454 | 460  | 467 | 587       | 1334-3535    | 3.02 (2.26) |

High-water mark 587 MB, first seen at minute 121 (t = 7260 s), the 2 h admin save; no later save exceeded it. Slow hours (6, 9) coincide with shared-core load, as in soak6.

## Saves
| When | Trigger | Tick stall | Admin round trip | Json |
|------|---------|-----------|------------------|------|
| start | startup | 42 ms | n/a | 19 MB |
| 2 h | admin | 38 ms | 7.2 s | 26 MB |
| 4 h | periodic | 38 ms | n/a | 14 MB |
| 6 h | admin | 152 ms | 28.0 s | 17 MB |
| 8 h | periodic | 44 ms | n/a | 14 MB |
| 10 h | admin | 61 ms | 6.5 s | 15 MB |
| 12 h | periodic | 18 ms | n/a | 14 MB |
| stop | SIGTERM | 11 ms | n/a | 14 MB |
No retry, warning or error lines (0 matches on `warn|error|retry` in the server log). Stop save written, exit code 0. Final population about 1470 at the stop (range 1289 to 3540 over the run, never near the 5000 cap).

## Creep verdict
Hourly means after the plateau begins (saw-tooth hours 4, 7, 10, 11 dip after saves): 426 (h3), 439, 447 (h6), 447 (h8), 457, 456 (h10), 460 (h12). Using the undipped hours, the rise is about 3 MB an hour from hour 5 to 12 (439 to 460 mean, 445 to 468 max) and decelerating (h9 to h12 max 468, 455 or 468, 467). It is a slow ratchet, not unbounded growth: 12 h ends at 460 MB mean, 587 MB HWM at the save, against the 768 MB heap cap and production's 787 MB peak. The single stop-time sample read 509 MB (stop save in progress). A trend of this size cannot be separated from the post-save saw-tooth with certainty, so a 24 h run would be needed to call it flat; nothing here suggests a leak that matters at the 1 GB unit cap.
