# Brain kernel: touching the next brain's weights (software prefetch in WASM)

Branch `pl-brain3`, change in `src/typescript/src/sim/wasm/brain.wat` only (+28 -5).
Question: can brain.wat close part of the gap to the native kernel (`native.md`, 1.8x, mostly prefetch) and stay bit-identical?

## What changed
- `$layer` takes `pf` and `pe` and returns `pf`. In the 1- to 4-vector column loops (layers up to 16 outputs) every input iteration does `drop (i32.load pf)`, `drop (i32.load offset=64 pf)` and moves `pf` 128 bytes while below `pe`.
- `forward` points `pf` at the next brain's weight block and `pe` 256 bytes before its inputs, or both at 0 for the last brain or a tiny block, so every touch is in bounds.
- Sums, order and tanh are untouched; only extra loads, so the bits cannot change. V8 keeps a dropped load (it can trap), the gain shows it.

## Why this shape
The live mix splits as 1597 x 55-12-12-4, 889 x 55-16-16-4, 828 Oracles. Per brain (ns, kernel A/B): 55-12 1047 cold in the mix, 707 when the subset fits L3, 500 with one slot in L1; Oracle 3060 in the mix, about 1200-1500 in L1.
So about half the kernel is memory stall, even though cold and hot runs are equal (24 MB of weights never fits the 12 MB L3 either way).
A WASM load that misses blocks retirement, unlike `prefetcht0`. What works is a sequential stream of touches spread over the current brain's loop: the touches mostly hit lines the L2 streamer already fetches, and the next brain finds its block in cache.

## How measured
Kernel: `scratchpad/br3/kab.ts` (the brainblock A/B, with shape filter and memory hash past the scratch area): one tick's real brain run on the live memory at tick 600, user CPU, median of 21-41, interleaved, cold = 48 MB eviction. Output memory hash equal in every variant.
Tick: `liveBench --seconds 60`, perf-live worktree as base, alternating pairs, load 7-15.

## Kernel variants (live mix, ratio to base, cold / hot)

| Variant                                                                 | Live mix          | Notes                                    |
|-------------------------------------------------------------------------|-------------------|------------------------------------------|
| burst at brain start: next brain's used first-layer rows (+ 0-8 lines of later layers) | 0.95-0.98x | needs the next list one brain early      |
| burst: every line of the next block                                     | 0.91x             | the misses stall retirement              |
| touch list of the used rows, consumed in the loops (1-3 per iteration)  | 0.77-0.87x        | scattered touches are real misses        |
| sequential stream, 1 line per iteration                                 | 0.99x             | does not reach far enough                |
| sequential stream, 2 lines (64 B apart) per iteration, summed into a sink | 1.08x           |                                          |
| same, dropped loads                                                     | 1.09-1.12x        |                                          |
| 3, 4, 6 lines, or 128-192 B apart, or two brains ahead                  | 0.72-1.04x        | skipping lines defeats the streamer      |
| dropped stream in the 1-4 vector loops only (committed)                 | 1.10-1.12x (4.45 ms) | Oracle loops left alone              |

Per shape for the committed variant's parent (all loops touched): 55-12 1.26x, Oracle 0.95x (in-core cost of the touches, no memory gain). Without touches in the 5- and 6-vector loops the Oracle is 1.00x.
Juggernaut x 4900 (55-16-16-4): 3.92 to 3.29 ms, 1.19-1.20x.

## Whole tick (cpuMsPerTick)

| Case                               | Base                    | brain3                  | Ratio of medians | Fingerprint      | Peak RSS MB          |
|------------------------------------|-------------------------|-------------------------|------------------|------------------|----------------------|
| 4 founders x 800                   | 13.51, 13.46, 13.37     | 12.97, 12.87, 12.94     | 1.04x            | 708687555 both   | 213-249 / 215-217    |
| same, `--profile`                  | 13.46, 10.22, 13.43     | 12.92, 9.74, 12.98      | 1.04x            | 708687555 both   | 216-217 / 212-218    |
| brain forward phase (`--profile`)  | 4.73, 3.59, 4.71        | 4.28, 3.22, 4.30        | 1.10x            |                  |                      |
| Juggernaut x 4900                  | 16.41, 16.68, 16.83     | 15.78, 16.19, 15.81     | 1.05x            | 10334191 both    | 255-257 / 251-256    |

Every pair favours brain3.

## Not tried or not kept
- Interleaving two brains' dense layers: needs equal shapes and 12+ accumulators; native's 4-brain grouped variant gained nothing over its plain kernel.
- Splitting an output's add chain: each output is one straight chain (bias then inputs in order), so a split is not exact.
- Sparse gather unrolling and tanh fusion: tried in `brainblock.md`, slower.

## Verdict suggestion
Merge: exact (both fingerprints equal), kernel 1.10x on the live mix and 1.20x on small brains, tick 1.04-1.05x, no RSS change, 28 lines. The touch pattern is tuned to this machine's prefetcher (Tiger Lake); other CPUs should lose at most the few extra loads.
