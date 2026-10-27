# Sense early-out for creatures whose item candidates miss every ray (idea 41)

Exact. Fingerprints 708687555 (4 founders x 800) and 10334191 (`--only juggernaut --copies 4900`) unchanged. Branch `pl-missout`, base `perf-live` 4e4320f. Verdict: no measurable gain, do not merge.

## What

`sense.wat`: extends idea 14 (`senseempty.md`). A creature with no rock disc candidate, no wall in reach and no detail record, but with item candidates, now computes its ray directions (a new `$directions` function, the old loop moved out unchanged; the full path skips it when already done) and runs the same two-ray cheap check the item pass uses (`s^2 <= rtv`) for each candidate against each ray, leaving at the first pass. If no candidate passes, no ray can be hit by any item (the full path would skip the exact test for all of them), so the existing crowd count and `memory.fill` of zeros apply. Odd ray counts: the unused lane past the last ray is written NaN so it never passes. `rtv`, `infv`, `ng` moved before the early-out (shared). Exact by construction: same test, same quantities as the pass it skips; walls, rock and the detail creature keep the full path.

## Counts (snapshot harness of `senselive.md`, 3331 / 3294 creatures)

| Tick | Old early-out (idea 14) | New early-out | Together | With item candidates | Walls, detail or rock |
|------|------------------------:|--------------:|---------:|---------------------:|----------------------:|
| 400  | 495 (14.9%) | 819 (24.6%) | 39.5% | 2711 | 211 |
| 1500 | 1038 (31.5%) | 694 (21.1%) | 52.6% | 2001 | 214 |

All-zero inputs are 44% of creatures at tick 400, so the fire rate is already near the ceiling; a second stage (exact test after the prefilter) can add about 5% at most.

## Kernel (cold, interleaved base/yours, 300 reps, `--no-liftoff`, pinned to cores 2,3,6,7, load 13-26)

Brain inputs of all creatures hash equal to the base kernel after NaN poisoning (b101b365, 50357cc0).

| Snapshot | base p25 | yours p25 | delta p25 |
|----------|----------|-----------|-----------|
| tick 400, 3 pinned runs  | 4.694, 4.634, 4.672 | 4.699, 4.631, 4.661 | +0.005, -0.003, -0.011 ms |
| tick 1500, 3 pinned runs | 3.987, 4.066, 4.191 | 3.843, 4.006, 4.130 | -0.144, -0.060, -0.061 ms |

(Earlier unpinned runs at load 26: tick 400 -0.18 to +0.0 ms, tick 1500 -0.03 to -0.28 ms, same sign.)

## Whole tick (liveBench `--profile`, 60 s, 3 alternating pairs, pinned)

| Case | cpuMsPerTick base | yours | median ratio | senser base | yours | peak RSS |
|------|-------------------|-------|-------------:|-------------|-------|---------:|
| 4 founders x 800  | 14.463, 14.433, 14.603 | 14.263, 14.588, 14.680 | 1.009 | 5.529, 5.502, 5.576 | 5.419, 5.559, 5.593 | 214-217 vs 211-219 |
| juggernaut x 4900 | 17.574, 17.896, 17.727 | 17.462, 17.734, 17.579 | 0.992 | 6.895, 7.028, 6.977 | 6.822, 6.901, 6.861 | 251-255 vs 252-255 |

## Reading

The pretest costs about what the skipped work saves: for the 25% that fire, directions are needed either way, and what is skipped (wall stores, closeness, 3 empty crowd groups, feature stores) is small, as `senseempty.md` found; for the busy ones the check is wasted. Gain is 0 at tick 400, about 0.06-0.14 ms (1.5-3% of the kernel, under 1% of the tick) at tick 1500, below the 1.5% bar and within the pair noise. Only the creatures-alone-late-in-the-run case moves.

## Tests

New `wasmKernels` test: brain inputs written by the early-out equal the detail (full) path for 3, 4, 5 and 7 rays over 4 seeds each, items around but none on a ray (26 such creatures, 174 that see something). Red when the cheap check is replaced by "never passes" (also turns idea 14's test red). Green: `wasmKernels thinkEvery residentBodies wasmStep` (65 tests, exit 0).
