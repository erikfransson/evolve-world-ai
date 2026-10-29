# Brain kernel: hit mask from the senser steers `$compact` (idea 132, "hitmask")

Not built. Branch `pl-hitmask` from `perf-live` (a63560d), docs only. Verdict suggestion: reject on the bound.

## Premise
Checked in `sense.wat`: a ray that hit nothing has kind 0, and every path writes zero for it. `$emit` gives closeness 0 for kind 0 and a one-hot compare against kinds -1, 1, 2, 3 (all false for 0), then zeros; the early-out fills the whole input with zero; the merge loop (detail path included) only sets species flag and seen energy when a creature was seen (kind 4). So "mask bit = kind != 0" is a superset of the non-zero rays and the `f32 != 0` predicate inside the hit rays keeps the list identical. A mask of 64 bits covers the 16-ray plan limit.

## Bound (kernel harness, mask supplied for free)
Instead of building the senser store, the harness computes each brain's mask from its real input (tick-600 dump, same as compact16.md) and a prototype `$compact` visits only the hit rays (one `ctz` loop, `stride` floats each, partial nibble masked), then the extras and memory tail with the existing 16-wide and 4-wide loops. That is the best case: the mask costs nothing. Outputs hash equal to the current kernel in every run.

Per brain: mixed 9.0 rays, 0.86 hit, 64.5 inputs, 11.4 non-zero; cap 8.0 rays, 0.75 hit, 55 inputs, 7.8 non-zero. Median user CPU of 61 interleaved reps, two copies of each variant, load 15-22 (`hitmask/hm.ts` in the session scratchpad, not committed):

| Case  | Cache | current (2 copies)  | hitmask (2 copies) | ratio     |
|-------|-------|---------------------|--------------------|-----------|
| mixed | cold  | 4.318, 4.292 ms     | 4.271, 4.275 ms    | 1.010-1.011 |
| mixed | hot   | 4.418, 4.426 ms     | 4.461, 4.465 ms    | 0.989-0.990 |
| cap   | cold  | 4.185, 4.188 ms     | 4.146, 4.169 ms    | 1.004-1.009 |
| cap   | hot   | 4.288, 4.227 ms     | 4.274, 4.278 ms    | 1.002 (and 0.99 vs the faster copy) |
| mixed (first run) | cold / hot | 4.246 / 4.176 | 4.237 / 4.195 | 1.002 / 0.995 |

Cold gain 0.2-1.1% of the kernel (0.01-0.05 ms, under 0.4% of the tick), hot loss up to 1%. Below the 1.5% bar by a factor of three or more, before paying for the senser store (the nzlist.md lesson) and a header the kernel must clear.

## Why so little
After idea 99 the whole compaction is about 0.27-0.31 ms of the kernel (compact16.md). What a ray mask can remove is the zero-group test of dead 16-groups, which is four loads, four compares and a branch each, and the nibble steps of the groups that mix a hit ray with dead ones. What it cannot touch is the extras and memory tail (19 inputs, nearly always non-zero) and the hit rays themselves, which is most of the remaining cost. The per-ray loop with its `ctz`, partial-nibble mask and per-ray index splat costs about what the skipped 16-wide tests did, so the net is noise.

## Verdict
Reject. The oracle-compaction bound of residency.md (1.08-1.11x in-core) assumes a free, exact list; a mask delivers none of it. The full per-feature list was already tried and costs the senser more (nzlist.md). The compaction is not a worthwhile target. No engine change, no tests run.
