# Brain kernel: two same-shape brains in lockstep (idea 71)

Branch `pl-pairs`, docs only. Stopped after the step-1 microbench: the paired loop gains nothing over two sequential loops, and pairing as a whole is slower than the current kernel.
Question: do small layers (1-4 vectors) wait on the add latency of their 1-4 accumulators, so that a second brain's independent chain in the same loop (twice the accumulators, each output's add order unchanged) fills the gap?

## What was built (scratch, not committed)
Scratch files in the session scratchpad `pairs/` (`gen.py`, `fwd.wat.part`, `pair.wat`, `seq.wat`, `kab.ts`, `count.ts`).
- `pair.wat` = brain.wat plus `$layerPair` (layers of up to 16 outputs, vectors 1-4 per brain, both brains' chains in one input loop, the shared count is the smaller of the two nz counts, then a single-chain tail for the longer list, so the first layer works with different non-zero counts), `$tanhRange`, `$same` (layer sizes equal) and a `forward` that pairs run-order neighbours of equal shape in the kernel (second scratch pair and nz list passed in), unpaired and wider layers through `$layer`. Prefetch touches kept: one stream per brain onto the next pair's two blocks (4 loads per paired iteration).
- `seq.wat` = the same `forward` with `$layerPair` switched off (each layer of A, then B, through `$layer`): isolates the cost of the pairing structure from the effect of the paired loop.
- Output memory hash equal to base in every run (A/B harness of brain3: one tick's real brain run on the live memory at tick 600, user CPU, median of 41, interleaved, cold = 48 MB eviction).

## Pairable fraction (greedy adjacent equal-shape pairs in run order, share of brains)

| World                         | Tick | Brains | Shapes | Adjacent | Within next 4 | Within next 16 |
|-------------------------------|------|--------|--------|----------|---------------|----------------|
| 4 founders x 800              | 400  | 3331   | 6      | 0.985    | 0.991         | 0.998          |
| same                          | 1500 | 3294   | 6      | 0.982    | 0.990         | 0.998          |
| same                          | 3000 | 3269   | 7      | 0.981    | 0.989         | 0.997          |
| Juggernaut x 4900 (cap)       | 400  | 4900   | 5      | 0.999    | 0.999         | 0.999          |
| same                          | 1500 | 4900   | 7      | 0.997    | 0.998         | 0.998          |

In the live bench almost every brain is pairable (a handful of one-off mutant shapes).
In a world whose brain sizes keep mutating (brain2.md: 4281 shapes among 9411 creatures) pairing would be opportunistic and the fraction far lower, so the bench numbers are the ceiling.

## Kernel (ms per run, ratio to base; `--no-liftoff` so every variant is TurboFan code)

| Subset                          | Weights | Base (cold / hot) | pair      | seq       | pair vs seq   |
|---------------------------------|---------|-------------------|-----------|-----------|---------------|
| 55-12-12-4 (1597 brains)        | live    | 1.381 / 1.346     | 0.929x / 0.923x | 0.901x / 0.905x | +3% / +2% |
| 55-12-12-4, one slot repeated   | L1      | 1.071 / 1.013     | 0.995x / 0.970x | 0.971x / 0.936x | +2% / +3% |
| 55-16-16-4 (889 brains)         | live    | 0.969 / 0.919     | 0.945x / 0.929x | 0.938x / 0.911x | +1% / +2% |
| 55-16-16-4, one slot repeated   | L1      | 0.689 / 0.661     | 0.941x / 0.938x | 0.943x / 0.950x | 0% / -1%  |
| whole live mix                  | live    | 4.998 / 4.956     | 0.943x / 0.935x | 0.935x / 0.921x | +1% / +1% |

Without `--no-liftoff` the first runs sit in Liftoff and tier up late for the larger `forward`, which made pair.wat look 15-18% slower (0.82-0.88x); that is a tiering artefact of the harness and the figures above are the steady state.

## Why it does not pay
- The paired loop is only 0-3% faster than the same brains run one after the other, with weights in L1 or in the live memory alike. The single-brain column loop is therefore not add-latency bound: per input it issues about 20 uops (index load, source load and splat, address multiply, 3 loads, 3 multiplies, 3 adds, touches, counter), about 5 cycles at 4 wide against the 4-cycle add latency, so a second chain has no latency left to hide.
- The pairing structure (shape compare, two compactions, two scratch sets, second prefetch stream, bigger `forward`) costs 5-10% on its own (seq vs base), more than the paired loop recovers. Even with that overhead trimmed to zero the gain is at most 2-3% of the paired kernel, which is under 1% of the tick (brain forward is 5.2 of 15.2 ms), below the 2% bar.
- native.md's 4-brain grouped interleave (3.24-3.56 ms) is 1.08-1.18x faster than the scalar-compaction exact kernel (3.83-3.87) but equal to the AVX2-compaction one (3.37-3.49); native.md does not say which compaction the grouped variant used, so that gain cannot be attributed to the interleave (unverified). brain3.md read it as no gain.

## Verdict suggestion
Reject at step 1. Exact (hash equal) but 0.93-0.95x of base on the mix and about 0-3% over a sequential run of the same pairs; step 2 (TS pairing, tests, tick pairs) was not built. Nothing merged, no engine change on the branch.
