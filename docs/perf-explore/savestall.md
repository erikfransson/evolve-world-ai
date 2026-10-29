| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Save: main thread takes only a snapshot (typed-array copies), a worker packs base64, stringifies and gzips | tick stall 3.2-6.0 s per save | 41-191 ms | about 50x on the stall | Yes (same JSON bytes, fingerprints unchanged) | about -180 MB (796 to 597 MB at 3300, 775 to 620 at 4900) | about 90 code, 25 test | Merge (server code: 3-review push gate) |

Measured with `node src/liveBench.ts --seconds 60 --save 15` (new option: saves every 15 simulated seconds through the server's `Saves` into a temp state dir, timing each yield between ticks while a save runs).
`maxBlockMs` is the longest single main-thread block, `cpuMs` the main thread's CPU across the save (`process.threadCpuUsage`), the stall is the save's own log line.
Base is the bench commit `2e91bc9` with the old saves code (worktree `savestall-base`), alternating base/new, 5 pairs per case (3 without `cpuMs`, 2 with). Load 9-12 on 8 cores, idle priority, so the stall is about 2x the 2.8 s noted in `docs/perf-notes.md`.

## Numbers

| Case                          | JSON  | Stall base (log, ms) | Stall new (log, ms) | Longest block base / new (median) | Main CPU per save base / new | Peak RSS base / new (median) |
|-------------------------------|-------|----------------------|---------------------|-----------------------------------|------------------------------|------------------------------|
| `--copies 800` (3306)         | 41 MB | 3490-5950            | 43-155              | 5813 / 128 ms                     | 5426, 5476 / 175, 211 ms     | 796 / 597 MB                 |
| `--only juggernaut --copies 4900` | 40 MB | 3164-5528        | 41-191              | 5263 / 93 ms                      | 5150, 3512 / 160, 170 ms     | 775 / 620 MB                 |

The first save of a run is the slowest new one (91-191 ms, the snapshot code is cold), later ones 41-89 ms.
Fingerprints equal base and new (708687555, 10334191).
Wall time per save is unchanged (9-19 s, mostly the existing verify parse).
`cpuMsPerTick` is process-wide and includes the worker, so it is not a tick number here.

## Design

`snapshotState` (ecoState.ts) is the old `saveState` without `pack`: fresh typed-array copies plus the plain parts. `packState` turns it into the EcoState, keys in the old order; `saveState` is now `packState(snapshotState(eco))`, so every other caller is unchanged.
`packSave` (saveParse.ts) starts `saveWriteWorker.ts` inside `whenIdle`, so the snapshot is cloned (columns transferred, they are copies) before the next tick. The worker packs, stringifies, checks `maxSaveJsonBytes` and gzips, under the parser's heap cap (384 MB; a 39 MB save packs at 96 MB) and a 15 s timeout, and transfers the gzip back.
`Saves.saveNow` then verifies with the existing `parseSave(..., true)` worker and writes through `StateStore.writeGzipped`. Jobs stay in the one `exclusive` queue, so a save, restore or reset never interleave. A too-big, failed or timed-out pack writes nothing.
Byte check: a test saves a world (thinkEvery 1 and 2, with mutation scales and bump kills) and compares the gunzipped file to `JSON.stringify(saveState())`; a one-off script compared the old `saveState` from the base worktree with the new path on Inland Sea worlds of about 1000 creatures: equal.

## Cost and risk

The main thread still does the snapshot (40-130 ms), the gzip message, the verify spawn and the `writeFileSync`, about 200 ms CPU per save.
The pack worker (2-5 s CPU) competes with the tick loop for the core the idle-priority server gets, as the old threadpool gzip did; no single stall remains.
