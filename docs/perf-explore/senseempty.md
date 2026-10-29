# Sense kernel early-out for creatures that see nothing (idea 14)

Exact. Fingerprints 708687555 (4 founders x 800) and 10334191 (`--only juggernaut --copies 4900`) unchanged. Branch `pl-senseempty`, base `perf-live` 31d339f.

## What

`sense.wat`: after the item and rock gathers, a creature with no item or rock candidate, no wall within the ray length (`walls` false) and no detail record (`det` 0) gets one more check, a count-only copy of the crowd walk (same f32 setup, same distance and wedge test, no stores). If no other creature is a candidate either, the rays can only read "nothing": the full path then writes closeness 0, an all-zero one-hot, species flags 0 and seen energy 0 (kind 0 gives `clo` 0, no crowd hit gives `k` -1, so flag and energy select 0), i.e. `nR * stride` floats of +0.0. The early-out `memory.fill`s exactly that and skips the per-ray passes (directions, wall loop, ray tests, closeness, crowd gather and ray tests, merge).

To gather before the per-ray passes, the directions loop moved after the gathers; the two outer ray directions (wedge) are computed on their own with the same arithmetic (bit-identical to the loop). The detail creature always takes the full path (its closeness, kind and crowd slot per ray go to the UI). Scratch is rewritten every call, so skipping its writes is invisible.

Creatures with all-zero input are 44% at tick 400, but most of them have candidates that miss every ray; the early-out fires for the 15% (tick 400) to 32% (tick 1500) with no candidate at all.

## Kernel (snapshot harness of `senselive.md`, cold, interleaved base/yours, 300-400 reps, `--no-liftoff`, load 11-15, only p10/p25/median mean anything)

Brain inputs of all 3331 / 3294 creatures hash equal to the base kernel (b101b365, 50357cc0), run after poisoning the input with NaN.

| Snapshot | base p25 / med | yours p25 / med | delta p25 |
|----------|---------------:|----------------:|----------:|
| tick 400, 3 runs  | 4.54 / 4.81, 4.71 / 4.81, 4.65 / 4.77 | 4.20 / 4.71, 4.64 / 4.73, 4.59 / 4.72 | -0.34, -0.07, -0.06 ms |
| tick 1500, 3 runs | 4.18 / 4.27, 4.14 / 4.25, 4.07 / 4.21 | 4.00 / 4.06, 3.95 / 4.05, 3.93 / 4.02 | -0.17, -0.19, -0.14 ms |

Tick 400 is noisy (first run lucky, the other two small); tick 1500 is steady at about -0.15 to -0.2 ms (4%), as expected from 32% of creatures skipping about 38% of their cost.

## Whole tick (liveBench, nice 19, 60 s, 3 alternating pairs, base = `perf-live` worktree)

cpuMsPerTick:

| Case | Base | Yours | Ratio of medians |
|------|------|-------|-----------------:|
| 4 founders x 800 | 14.979, 14.945, 14.681 (med 14.945) | 14.831, 14.648, 14.590 (med 14.648) | 0.980 |
| juggernaut x 4900 | 18.231, 18.356, 18.334 (med 18.334) | 17.877, 17.617, 18.061 (med 17.877) | 0.975 |

Peak RSS 214-217 vs 213-216 MB (800), 253-258 vs 251-256 (4900): unchanged.

`--profile` pairs (4 founders x 800), senser phase in ms (other phases within noise): base 5.33, 5.35, 5.33; yours 5.17, 5.09, 5.19. Senser -0.17 ms (3%), whole profile run 14.93, 14.88, 14.85 vs 14.76, 14.59, 14.82.

## Tests

New `wasmKernels` test: brain inputs of every creature written by the early-out equal those of the full path (the creature as detail), over 0, 1 and 3 species, with the input poisoned with NaN first (a creature in a clump, lonely ones, ones at the walls, sparse items). It goes red when the `memory.fill` is removed and when the crowd check is removed. Green: `wasmKernels` (includes the drift test), `sensors`, `rayRecast`, `residentBodies`, `wasmStep`, `wasmCrowd`, `rlKernelReuse`. Full suite `--maxWorkers=2`: 1218 of 1219 pass; `residentBodies` "Inland Sea" timed out at 20 s under load 12 in that run and passes alone (8 of 8).

## Verdict suggestion

Exact, +71 lines of wat and one test; 2.0-2.5% of the tick in the pairs, about 1.3% by the senser phase alone, more later in a run when more creatures are alone (tick 1500: kernel -4%). Borderline against the 1.5% bar: merge if the pairs are trusted, since it costs nothing and grows with sparse worlds.
