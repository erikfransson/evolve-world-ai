# Reference profile on main at 20k, 30k, 50k

Branch `worktree-agent-a8b20b1b52df8fc34`, from main at 8d5fff1. Profiler ported from `worktree-agent-a6d063fc3cb59d409` (`sim/profile.ts`, `ecoBench --profile`), with laps in ecosystem, creature, senseKernels and ThinkPool. Laps read process user CPU (`process.cpuUsage`), not wall time.

Fingerprints with the profiler on match main: `--seconds 30 --pop 600` 494818766 serial and `--threads 3`; `--predators --seconds 40` 792910110.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Phase profiler (`--profile`) | no profile | same fingerprints | n/a | yes | none measured | about 90 | Keep as a tool |

## Setup

`ecoBench --width W --seconds 20 --profile`, default founders scaled by area. Steady part is after the first quarter of ticks. `nice -n 19`, one process at a time. Load average 17 to 43 during the runs, and swap was full (2047 of 2047 MB) for most of them, so wall times are inflated. CPU per tick is the steadier number.

Medians of 3 repeats unless marked. Per-1000 figures divide by the steady mean population.

## Serial, CPU ms per steady tick

| Config | CPU ms/tick | Steady pop | ms per 1000 creatures | Peak RSS |
|--------|-------------|------------|-----------------------|----------|
| Ecosystem 20k | 21.7 | 2581 | 8.4 | 251 MB |
| Ecosystem 30k | 53.2 | 5825 | 9.1 | 435 MB |
| Ecosystem 50k | 100.8 | 9345 | 10.8 | 560 MB |
| Great Hunt 20k | 57.8 | 6117 | 9.4 | 450 MB |
| Great Hunt 30k | 150.3 (2 reps) | 10000 | 15.0 | 508 MB |

## Three threads, CPU ms per steady tick

Process CPU includes helper threads, so the phase laps that wait on helpers carry helper work.

| Config | CPU ms/tick | Peak RSS | Runs ok |
|--------|-------------|----------|---------|
| Ecosystem 20k | 33.8 | 509 MB | 3 of 3 |
| Ecosystem 30k | 77.4 | 936 MB | 3 of 3 |
| Ecosystem 50k | 130.1 | 1385 MB | 1 of 3 |
| Great Hunt 20k | 81.2 | 907 MB | 3 of 3 |
| Great Hunt 30k | 134.0 | 1378 MB | 1 of 3 |

Three helper runs at 50k and 30k predators died with "helper threads stopped answering" (the 5 s tick timeout in ecoPool.ts), about 18 s into the run. Load was 35 to 43 with full swap, so the cause is probably starved helpers. This is not confirmed.

## Ranking at 50k, Ecosystem serial

| Rank | Phase | ms/tick | Share |
|------|-------|---------|-------|
| 1 | wasm senser run (item and crowd rays, input build) | 41.2 | 41% |
| 2 | wasm brain forward | 17.3 | 17% |
| 3 | memory and steer | 11.1 | 11% |
| 4 | collisions | 8.7 | 9% |
| 5 | eat | 8.3 | 8% |
| 6 | wasm brain copy out | 4.0 | 4% |
| 7 | sort batch | 3.6 | 4% |
| 8 | crowd grid | 3.6 | 4% |

At 30k predators the senser run is 43%, brain forward 19%, memory and steer 14%.

## Phases that grow faster than population

Ms per tick per 1000 creatures, serial Ecosystem, 20k, 30k, 50k:

| Phase | 20k | 30k | 50k | Trend |
|-------|-----|-----|-----|-------|
| wasm senser run | 3.5 | 3.7 | 4.4 | rising |
| wasm brain forward | 1.87 | 1.85 | 1.85 | linear |
| memory and steer | 0.92 | 1.03 | 1.19 | rising |
| collisions | 0.63 | 0.66 | 0.94 | rising |
| eat | 0.58 | 0.72 | 0.88 | rising |
| crowd grid | 0.23 | 0.24 | 0.38 | rising |
| sort batch | 0.26 | 0.34 | 0.39 | rising |

Crowd grid and the senser's per-tick copy are O(grid cells), which is O(area). Population fell during each run, so density fell and the per-creature cost of those area terms rose. This explanation is inferred from the code, not measured separately.

## Memory breakdown

Measured only as total peak RSS (table above). Per-component sizes are from reading the code and are not measured.

- Item grid (World): per slot 25 B (xs, ys as f32, kinds, nextItem, itemCell, freeSlots, freePos). Capacity is food plus poison caps. At 50k that is about 125k slots, about 3 MB. Cell arrays cellHead and cellStamp are 8 B per cell, about 1.3 MB.
- Senser per tick: copies the item arrays (xs, ys, kinds, nextItem, cellHead) into WebAssembly memory every tick, about 14 MB at 50k, unverified.
- Crowd grid: about 70 B per creature for the rebuild copy and the grid arrays, plus 8 B per crowd cell for cellStart and cursor. About 1 MB at 9k creatures.
- Per creature: Creature and EcoCreature objects, RayHit objects and Float64 ray caches, the brain (weights in the WASM bank). Not sized.
- Snapshot buffers (worker/ecoRunner.ts, outside ecoBench): 36 B per creature times 1.25 cap, plus 9 B per item slot, up to 3 in flight at 30 Hz. About 4 to 5 MB at 50k. The item scan runs O(item slots) per snapshot, not measured.

## Not done

- Per-component memory was not measured with a probe. A 50k probe was skipped under the new limits.
- Helper-thread phase breakdown at 50k and 30k predators is partial (one run each).
- The 50k run used 20 s and the population was still falling, so steady-state numbers are rough.

## Cost in code

About 90 lines: sim/profile.ts (new), laps in sim/ecosystem.ts, sim/creature.ts, sim/wasm/senseKernels.ts, worker/ecoPool.ts, and `--profile` in ecoBench.ts.
