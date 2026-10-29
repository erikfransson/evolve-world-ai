# Sense kernel: candidate gathers four entries per step (idea 60)

Rejected. Exact in every variant, but 2-4% slower than the scalar gather. Branch `pl-gather4` from `perf-live` 98a0eae; no production change committed (prototypes were scratch copies of `sense.wat`).

## What was built

Scratch `sense.wat` variants, brain inputs of all creatures equal to the base kernel after NaN poisoning (same hashes as rays8.md: b101b365 at tick 400, 50357cc0 at tick 1500):

- Item gather (a): per row step, 4 items as two f64x2 pairs (two v128 loads of the interleaved f32 pairs, shuffled to x and y lanes, `promote_low`; no layout change), the same f64 ops as the scalar loop, the keep mask from `i64x2.bitmask`, tail lanes past the row end masked by the remaining count (reads up to 3 slots past the row run), candidates stored lane by lane with `store64_lane` and advanced by the mask bit, so the order is the scalar walk's.
- (b) = (a) with the kind load and the lane stores skipped when no lane is kept. (c) = pairs only (2 items per step). (e) = hybrid: 4-lane vector while 4 or more items remain, the scalar loop for the tail.
- Crowd gather (crowd_a): 4 entries per step in f32x4 (`sx`, `sy`, `own` loaded as vectors), the same f32 ops, mask via `i32x4.bitmask`, the four 16-byte candidate records built with an 8-shuffle 4x4 transpose, stored one by one with the mask-bit advance. The early-out crowd walk was not vectorized.

## Why it cannot win here (senselive.md counts)

Per creature 4.5 item rows hold 7.7 scanned items, 1.7 per row; crowd rows 4.6 hold 1.5 entries in total. A 4-lane step is almost always one step with 1-2 live lanes, so it replaces about 2 cheap scalar iterations (touchskip.md: about one cycle per item) with 60+ vector ops (loads, shuffles, promotes, 13 per-creature splats, 16 v128 locals in a function that is already register bound). The only saving, the inner-loop exit mispredict, is smaller than that.
Control: adding the unused v128 locals to the base kernel alone costs +1.5% / +2.1% (t400 / t1500).

## Kernel harness (cold, interleaved, p25 of 40-60 reps, `node --no-liftoff`, taskset 2,3,6,7 nice 19, load 19; snapshots r8/mem400 and mem1500 from rays8)

| Variant                    | t400 p25 ratio to base | t1500 p25 ratio |
|----------------------------|-----------------------:|----------------:|
| base vs itself (noise)     | 1.004                  |                 |
| items (a), 4 lanes         | 1.029, 1.032           |                 |
| items (b), skip when empty | 1.025, 1.017           | 1.033           |
| items (c), 2 lanes         | 1.034                  |                 |
| items (e), hybrid          | 1.042                  |                 |
| crowd gather, 4 lanes      | 1.041, 1.036           | 1.037           |
| control: unused locals only| 1.015                  | 1.021           |

Base p25 4.6-4.75 ms (t400), 4.0 ms (t1500). Best case is +1.7% kernel, about +0.1 ms of the 15 ms tick, against a bar of 1.5% of the tick (-0.23 ms).
liveBench pairs were not run: every kernel variant is slower, so no whole-tick pair could show a gain, and fingerprints cannot change (inputs equal).

## Verdict

Reject. The gathers are bound by per-row work (loop entry, cell-index loads, cold misses), not by items, as in senselive.md and touchskip.md; widening the per-item arithmetic does not touch that. What could still help is cutting rows or touching fewer cache lines per row, for example one pass over the row's cell range for several creatures in the same area (0.7-0.9% share a box, so no) or a coarser grid for the sense walk. The packed layout stays interleaved, nothing to change in `senser.ts`.
