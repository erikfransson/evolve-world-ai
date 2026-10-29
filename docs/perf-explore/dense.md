# Brain kernel: dense layers without the index list

Branch `pl-dense`, change in `src/typescript/src/sim/wasm/brain.wat` (+about 175 lines, mostly a copy of `$layer`) and the regenerated kernels.
Question: the layers after the first add every input, yet they run the index-list loop over the identity list `iota` (index load, shift, add, multiply per input). Does a loop that walks the inputs directly cut enough instructions?

## What changed
- `$layerDense` is `$layer` with the input loop walking `lp` over `src` and `p` over the weight rows (`p += stride` per input). Same column blocks (6..1 vectors), same prefetch touches, same per-accumulator order, same tanh loop.
- `forward` calls it for layers after the first. `iota` stays in the signature, now unused.

## How measured
Kernel: `scratchpad/dense/kab.ts` (the brain3 A/B on the dumped live memory at tick 600, median of 41 user-CPU calls, cold and hot). Output memory hash equal in every variant.
Tick: `liveBench --seconds 60 --profile`, perf-live as base, alternating pairs, 3 each, load about 10.

## Kernel (ms per run, ratio to base, cold / hot)

| Variant                                              | Live mix                | Juggernaut x 4900       | Bits  |
|------------------------------------------------------|-------------------------|-------------------------|-------|
| base                                                 | 4.58-4.63 / 4.57-4.58   | 4.71-4.85 / 4.68-4.85   | ref   |
| dense, two pointers (committed)                      | 0.973-0.987x / 0.966-0.972x | 0.976-0.977x / 0.943-0.974x | equal |
| dense, counter `i`, still a multiply for the row     | 0.960x / 0.949x         | 0.961x / 0.947x         | equal |

## Whole tick (cpuMsPerTick, `--profile`)

| Case              | Base                    | dense                   | Ratio of medians | Fingerprint    | Peak RSS MB      |
|-------------------|-------------------------|-------------------------|------------------|----------------|------------------|
| 4 founders x 800  | 13.30, 14.18, 14.00     | 13.59, 14.25, 14.23     | 0.984x           | 708687555 both | 216-221 / 214-219 |
| brain forward     | 4.55, 4.82, 4.81        | 4.70, 4.90, 4.89        | 0.984x           |                |                  |
| Juggernaut x 4900 | 17.00, 16.86, 15.36     | 17.40, 15.26, 16.59     | 1.017x (noise)   | 10334191 both  | 253-256 / 253-258 |
| brain forward     | 4.86, 4.82, 4.43        | 5.10, 4.53, 4.85        | 0.994x           |                |                  |

Every mixed pair favours base. The Juggernaut case swings 15-17 ms between runs, more than any effect here.

## Why it does not help
The index load is not the bottleneck: it is an L1 hit on a sequential list and runs in parallel with the weight loads. The direct loop trades it for a second loop-carried pointer add and gets no cheaper loop overall. TurboFan's code for the original loop (already unrolled by 4, `brainblock.md`) is at least as good. Both dense variants are slower in the kernel A/B, the multiply variant by more.

## Verdict suggestion
Reject: exact (both fingerprints, kernel hashes equal) but 2-4% slower in the brain kernel and no gain in the tick. Drop the branch; the bar of 1.5% of the tick is missed.
