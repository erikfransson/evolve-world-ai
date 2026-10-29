# Brain kernel: 24-wide column blocks and tanh in its own loop

Branch `pl-brainblock`, change in `src/typescript/src/sim/wasm/brain.wat` only (+92 -33).
Question: can brain.wat cut instructions for the Oracle's 24-wide layers (two passes over the inputs today, a 16-wide and an 8-wide block) and stay bit-identical?

## What changed
- `$layer` takes column blocks of up to six vectors (24 outputs): `left >= 96` runs 6, then exact cases for 5, 4, 3, 2, 1. A 24-wide layer and the Oracle's 20-wide output are one pass. Each output keeps bias then inputs in list order, so the bits do not change.
- tanh is no longer a `$tanh` function called per vector. The blocks store the raw sums and one loop at the end of `$layer` applies tanh in place, the polynomial written inline. V8 (Node 24) does not inline the call: `--no-wasm-inlining` changes nothing, and inlining by hand gained 3% on its own.
- TurboFan code checked with `--print-wasm-code`: the input loop is already unrolled by 4, the 6 accumulators stay in xmm registers, no spills in the hot loops.

## How measured
Kernel: a scratch A/B (`scratchpad/bb/kab.ts`) steps the server's LiveWorld (4 founders x 800, 600 ticks), copies the WASM memory into one instance per .wat variant and times one tick's real brain run (3318 brains, user CPU, median of 41-61, interleaved, cold = 48 MB eviction before each call). The memory after the run is hashed: equal in every variant and case.
Tick: `liveBench --seconds 60`, perf-live worktree as base, alternating pairs, load 10-14.

## Kernel (ms per run, ratio to base)

| Variant                                              | Live mix (cold / hot)       | Oracle only     | Juggernaut x 4900 | Bits  |
|------------------------------------------------------|-----------------------------|-----------------|-------------------|-------|
| base brain.wat                                       | 5.25-5.32                   | 4.62-4.65       | 5.28              | ref   |
| 6-wide blocks                                        | 1.05-1.06x                  | 1.14x           | 1.00x             | equal |
| 8-wide blocks (7..1 exact)                           | 1.05-1.07x                  | 1.14x           |                   | equal |
| 6 or 8-wide, input loop unrolled by 2                | 1.02-1.05x                  |                 |                   | equal |
| 6-wide, tanh inlined at every store                  | 1.07-1.09x                  |                 |                   | equal |
| 6-wide, tanh loop calling `$tanh`                    | 1.05-1.06x                  |                 |                   | equal |
| 6-wide, tanh loop inline (committed)                 | 1.09-1.10x (4.80-4.82 ms)   | 1.16-1.17x      | 1.04-1.05x        | equal |

wasmBench (wall time, random genomes) is bimodal on this machine (default plan 2.7 or 5.6 ms on either branch) and says nothing either way.

## Whole tick (cpuMsPerTick)

| Case                               | Base                                         | brainblock                                   | Ratio of medians | Fingerprint        | Peak RSS MB        |
|------------------------------------|----------------------------------------------|----------------------------------------------|------------------|--------------------|--------------------|
| 4 founders x 800                   | 13.89, 13.79, 15.22                          | 11.94, 14.77, 14.59                          | 0.95x            | 708687555 both     | 217-218 / 214-216  |
| same, `--profile`                  | 15.33, 13.07, 15.56                          | 14.49, 14.84, 14.96                          | 1.03x            | 708687555 both     | 213-216 / 213-217  |
| brain forward phase (`--profile`)  | 5.24, 4.51, 5.31                             | 4.69, 4.80, 4.82                             | 1.09x            |                    |                    |
| Juggernaut x 4900                  | 18.53, 18.44, 18.51                          | 18.34, 18.51, 18.64                          | 1.00x            | 10334191 both      | 253-256 / 250-256  |

The expected tick gain is about 0.45 ms of 15 (3%), below the 5-10% swing of the founders case under this load; the profiled brain phase shows the 1.09x of the kernel bench.

## Not kept
- Unrolling the input loop by 2: TurboFan already unrolls by 4, the manual version is slower.
- 8-wide blocks: same as 6 for the live mix, more code.

## Verdict suggestion
Merge: exact (fingerprints equal), 1.10x on the live kernel, 1.16x on the Oracle, 1.04x on small brains, no RSS change, and it helps the browser too. The tick gain (about 3%) is too small to show in 60 s pairs at load 13.
