# Idea 68: process memory settings against the server's peak RSS

Branch `pl-memset` (from perf-live 8e3d177). Docs plus one bench switch (`liveBench --keep`, keeps the `--save` temp dir). The unit template is not changed.

## How measured
`liveBench --seconds 3600 --copies 800 --save 900`, one run at a time, `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, node flags/env in the table, a side loop sampling `/proc/<pid>/status` every 15 s. Population grows to about 4500 by 900 s, crashes, steady 2244 (fingerprint 878889589 in all six runs, so all settings are bit-identical).

| Run | Setting | peakRssMB | heapUsedMB | cpuMsPerTick | saves that completed (of 4) |
|-----|---------|-----------|------------|--------------|-----------------------------|
| 1 | base `--max-old-space-size=768` | 484 | 24 | 9.71 | 1 |
| 2 | `--max-old-space-size=256`      | 483 | 24 | 9.48 | 2 |
| 3 | `--max-old-space-size=128`      | 508 | 24 | 8.23 | 3 |
| 4 | base + `MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=262144 MALLOC_TRIM_THRESHOLD_=131072` | 542 | 23 | 8.88 | 3 |
| 5 | cap 256 + malloc env            | 484 | 24 | 8.02 | 4 |
| 6 | base + `--minor-ms`                | 540 | 24 | 8.42 | 4 |

## Findings
1. No setting lowers the peak. All six are 483-542 MB, within the spread of identical runs (the saved-file count differs, see 3). The V8 slack of mem.md (157 MB heap capacity for 10-25 MB live) is not the peak here: heapUsed is 24 MB at the end in every run and the main heap cap does not touch the peak.
2. The peak sits at a save, not in the tick loop. RSS climbs steadily 210 to 315 MB between saves (run 1), then jumps by 100-200 MB while a save packs (pack worker with its own 384 MB cap, `PARSE_HEAP_MB`, plus the transferred snapshot copies). Peaks: run 1 at its last save (26 MB JSON), run 2 at 22 min, run 6 at the first save (41 MB JSON, minute 6, 527 MB). The main-heap cap cannot see this memory.
3. Confound: the pack has a 10 s wall timeout (`PACK_TIMEOUT_MS`) and this machine ran at load 17-20 on 4 shared cores, so 3 of 4 saves failed in run 1, 2 in run 2, 1 in run 3 and 4. A failed save aborts early and has a lower peak, so peakRssMB across runs is not comparable one to one. Runs 5 and 6 (all saves completed, including the 41 MB first save) are the like-for-like pair: 484 (cap 256 + malloc env) against 540 (`--minor-ms`). Run 5 is also the lowest of the full-save runs. One run each, so a 56 MB gap is suggestive only.
4. cpuMsPerTick 8.0-9.7 follows machine load (run 1 ran 40 min wall at load 20, the rest 15-22 min), not the setting. No speed claim either way.
5. `--minor-ms`: no misbehaviour seen. Save stalls 29-109 ms (base 82-159, cap runs 31-111), fingerprint equal, all saves complete. It gave the highest peak (540), so it does not help the soak case.
6. RSS 60 s after each save could not be sampled cleanly: the save files are removed at the end and failed saves leave no marker. The timelines (minutes:MB every 3 min) show the drift instead. Run 1: 3:212 12:225 21:276 30:300 39:315. Run 5: 3:212 6:304 9:323 12:371 15:375.

## Restore test (cap world)
Save of 4900 juggernaut (`--only juggernaut --copies 4900 --save 30 --seconds 40 --keep`): 40 MB JSON, 2.3 MB gz. Loaded with `parseSave` (worker, 384 MB cap) then `LiveWorld.restoreState`, after building a fresh world as the server does. Main heap (MB):

| Cap | fresh world | after parse | peak heapUsed | peak heapTotal | peak RSS | result |
|-----|-------------|-------------|---------------|----------------|----------|--------|
| 768 | 14 | 52 | 73 | 132 | 477 | ok, fingerprint 906134928 |
| 256 | 13 | 52 | 78 | 128 | 478 | ok, same fingerprint |
| 128 | 13 | 52 | 64 | 129 | 491 | ok, same fingerprint |
| 96  | 12 | -  | -  | -   | -   | parse worker out of memory ("save parser failed") |

The main-heap transient is about 80 MB (52 MB when the parsed state arrives, plus the restored world). With 2x headroom the smallest cap is 160 MB, so 256 is the smallest round value that has it. Cap 128 restores but with 1.6x. Cap 96 fails in the parse worker (reason not investigated), so a cap under about 128 breaks the restore.

## Verdict suggestion
- No evidence yet that any of these settings cuts the server's peak, since the peak is the save worker, not the main heap. Do not edit the unit for RSS on these numbers.
- If a main-heap cap is wanted anyway (mem.md showed -110 MB at 60 s), `ExecStart=@NODE@/bin/node --max-old-space-size=256 src/main.ts` is safe: restore transient about 80 MB, 3x headroom at the 4900 cap world, fingerprints equal. Not below 160. Malloc env and `--minor-ms` are not recommended (no gain shown, minor-ms experimental).
- Open: the real cut is the save pack (reduce the snapshot copies or the pack worker peak), and the 10 s pack timeout fails under host load, worth its own idea. A rerun on an idle machine would settle the peak ordering of runs 1-4.
