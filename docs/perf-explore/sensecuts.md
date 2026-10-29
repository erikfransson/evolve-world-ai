# Sense kernel exact cuts (idea 8)

Three of the four exact cuts from `senselive.md` are implemented, one is rejected. All bit-identical: fingerprints 708687555 (4 founders x 800) and 10334191 (`--only juggernaut --copies 4900`) unchanged. Branch `pl-sensecuts`.

| # | Cut | Where | Kernel gain (cold, p25, t400 / t1500) | Verdict |
|---|-----|-------|---------------------------------------|---------|
| 1 | Ray offset tables shared by content | `WasmSenser.setOffsets` (senser.ts) | -0.50 / -0.45 ms | kept |
| 2 | Rock lower-bound table, rock walk skipped | `rockLowerBound` (senser.ts), `S_ROCK_LB`, sense.wat | -0.23 / -0.22 ms | kept |
| 3 | Feature writes: one v128 store for closeness and the one-hot, branch-free species flag and energy for stride 6 | sense.wat merge pass | -0.18 / -0.18 ms | kept |
| 4 | Wall loop skipped when no wall is within the ray length (init of best and kind folded into the direction loop) | sense.wat | -0.12 ms (0.8% of the tick) | rejected, under 1% |

Kernel timings: snapshot harness from `senselive.md` (memory snapshot of the real LiveWorld at tick 400 and 1500, 3331 and 3294 creatures, cache swept before each call, variants interleaved, 80-120 reps, `--no-liftoff`, load 12-25). Input vectors of all creatures hashed equal for every variant (b101b365, 50357cc0). Each cut measured against the previous state. Gain of 1 is vs the unshared snapshot (`mem400i` interned vs `mem400`). Quiet machine, all cuts together on the interned snapshot: 3.22 -> 2.94 ms (t400), 2.85 -> 2.61 ms (t1500).

## What bounds the offset pool

A table is created only for an offset set not in the pool (key: the float32 bits). Each slot holds one table and the table counts its holders; when the last holder changes plan the table goes back to the arena and leaves the pool. So tables in memory never outnumber slots (what the old per-slot tables used to cost), and mutation churn reuses freed blocks of the same size class (256 B steps, at most 4 classes for 64 rays). A creature reset with the same offsets keeps its table and does no work. Measured: 273 distinct among 3331 creatures.

## Rock lower bound

Per rock cell (167 x 105 on The Inland Sea, 70 KB, built once per `Terrain` when the rock tables are copied): the least over all discs of (distance from the cell rectangle to the disc centre - radius), capped at 2048 and shrunk by 1e-6 relative. The kernel skips the rock walk when the creature's cell value exceeds `L * (1 + 1e-6) + 1e-3`; any disc the walk would keep is within `L (1 + 1e-9)` of the creature, so only discs that fail the test are skipped. A position outside the grid or NaN walks as before. 95% of creatures have no rock candidate. Memory +70 KB, one time.

## Whole tick (liveBench, nice 19, 60 s, 3 alternating pairs, base = `f6fe979` detached worktree)

cpuMsPerTick, ratio of medians:

| Case | Base | Yours | Ratio |
|------|------|-------|-------|
| 4 founders x 800 | 15.156, 15.145, 15.112 (med 15.145) | 14.439, 14.365, 14.507 (med 14.439) | 0.953 |
| juggernaut x 4900 | 19.423, 19.558, 19.793 (med 19.558) | 18.093, 18.745, 18.518 (med 18.518) | 0.947 |

Peak RSS 214-219 MB vs 216-218 MB (800 case), 252-254 vs 254-258 (4900 case): within the run-to-run spread, +70 KB rock table, less offset memory.

`--profile` pairs (4 founders x 800), senser phase in ms (brain forward, slots, crowd grid unchanged within noise: 4.85/5.47/5.54 vs 4.82/5.57/5.53):

| Pair | Base senser | Yours senser |
|------|-------------|--------------|
| 1 | 5.16 | 4.51 |
| 2 | 6.02 | 5.32 |
| 3 | 6.08 | 5.28 |

Senser phase -0.65 to -0.80 ms, about 12% of the phase and 4.7% of the tick.

A first run of the pairs used the moving `perf-live` worktree as base after it had merged a faster brain forward; that comparison was unfair and is discarded (its senser delta, -0.82 ms, agrees).

## Tests

`wasmKernels` (generated-kernel drift test, sense, rock, species), `sensors`, `rayRecast`, `residentBodies`, `wasmStep`, `wasmCrowd`, `rlKernelReuse` green; full suite `--maxWorkers=2`: 120 files, 1211 tests, exit 0. New tests: offset sharing and freeing (red on the old per-slot tables), rock lower bound never above the true edge distance, one-species stride 6 features (red when the flag is broken). The existing rock test goes red when the skip is made unconditional.

## Verdict suggestion

Merge `pl-sensecuts`: 4.7-5.3% of the tick, exact, +138 lines. Cut 4 left out.
