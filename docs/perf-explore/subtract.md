# Sense kernel: three subtractions (idea 83, "subtract")

Exact, but too small for the 1.5% bar. Branch `pl-subtract` from `perf-live` f577683. Kept A and C, dropped B (measured zero). Fingerprints 708687555 (4 founders x 800) and 10334191 (`--only juggernaut --copies 4900`) unchanged.

## What

- A. When the crowd gather kept no candidate (`ce == cand`) and there is no detail record, go straight to `$emit` (reads only kind@1536 and clo@1024). The f32 half of `$closePairs` (direction and start distance arrays, scalar tail, pad lanes) moved into `$crowdPrep`, called only when a creature candidate exists or the creature is the detail one. The wedge directions of the crowd walk come from `f32.demote` of `d0x, d0y, d1x, d1y` (the expressions of the idea 14 early-out), no f32 scratch loads. Skipped as a whole: f32 prep, group loop, `$unseen`. Scratch no longer written on that path: f32 arrays at 1792, 2048, 2304 (only the group loop and the merge hit branch read them).
- B. `$initPairs` folded into `$dirsPairs` (best = L, kind 0 in the same loop, wall loop starts at `select(0, evenCount, walls)`). Built and measured, not kept.
- C. The gather stores the item index in candidate slot 24; the kind (`ikd[idx] == 1` food else poison, 3 for rock) is computed at the hit update. The rock store is gone. The brief's branch-free `select(3, ..., pass)` would load `ikd[slot24]` for rock discs too, whose slot 24 is stale scratch (a trap risk), so the hit update uses `if (result i32) pass`. Scratch differing: slot 24 holds an index instead of a kind; it is read only at the hit update.

## Kernel ablation (snapshots of the real LiveWorld at ticks 400 and 1500, 3331 / 3294 creatures, cold = 32 MB sweep, interleaved, `--no-liftoff`, p25, 4 runs of 300-600 reps, load 7-10)

Brain inputs of all creatures hash equal to the base after NaN poisoning, for every variant (35f12a2d at tick 400, cb1ad30c at 1500). Base p25 about 2.83 ms (t400) and 2.45 ms (t1500). Delta of p25 in ms, mean of the runs (2 per tick), negative = faster:

| Variant | t400 | t1500 | Share of kernel |
|---------|-----:|------:|----------------:|
| A       | -0.077 | -0.078 | 2.8-3.2% |
| B       | -0.002 | -0.006 | 0.1-0.2% (noise) |
| C       | -0.010 | -0.023 | 0.4-0.9% |
| AC      | -0.102 | -0.086 | 3.4-3.6% |
| ABC     | -0.114 | -0.084 | 3.4-4.0% |

B adds nothing on top of A and C (ABC vs AC within 0.01 ms), so it is out. A is the only clear part (the skip applies to the 88% of creatures with no crowd candidate, but each saves only about 20 ns).

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, base = `perf-live` worktree f577683; the base has since sped up, hence lower absolute numbers than the brief's)

| Case  | Build | cpuMsPerTick (med) | senser ms (med) | peak RSS MB | fingerprint |
|-------|-------|--------------------|-----------------|-------------|-------------|
| mixed | base  | 10.736, 10.195, 10.639 (10.639) | 4.052, 3.878, 4.063 (4.052) | 218, 213, 217 | 708687555 |
| mixed | A + C | 10.784, 10.313, 10.636 (10.636) | 4.043, 3.885, 3.974 (3.974) | 219, 220, 216 | 708687555 |
| cap   | base  | 12.797, 12.828, 12.531 (12.797) | 5.126, 5.150, 5.046 (5.126) | 251, 256, 257 | 10334191 |
| cap   | A + C | 12.352, 12.731, 13.016 (12.731) | 4.894, 5.047, 5.132 (5.047) | 255, 252, 256 | 10334191 |

Ratio of medians: mixed 1.000, cap 0.995. Senser phase -0.08 ms in both cases (about 2% of the phase, 0.6-0.7% of the tick), matching the kernel (-0.09). Pair spread (+-0.3 ms) is larger than the gain; peak RSS unchanged.

## Tests (all exit 0)

`npm run wasm`; `npx vitest run wasmKernels thinkEvery residentBodies wasmStep --testTimeout=180000 --maxWorkers=1`: 4 files, 66 tests passed. New `wasmKernels` test: brain inputs of creatures that see items or walls but no creature equal those of the full path (the creature as detail), for 7, 8, 9 and 1 rays, 0 to 3 species (strides 5 to 8), creatures against the walls and in a small clump, NaN-poisoned before each run. It goes red when the skip ignores the crowd candidates; making it ignore the detail record turns the existing JS-equality tests red.

## Verdict

Exact, +50 / -29 lines of WAT, +25 of test, about 0.6% of the tick (senser -0.08 ms). Below the 1.5% bar; the sense kernel has no big subtractions left. Merge only as a free extra, or park.
