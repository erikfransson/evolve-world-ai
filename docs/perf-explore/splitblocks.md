# Split brain blocks: ray rows in their own region (idea 125)

Branch `pl-splitblocks` (pl-packarena merged with perf-live f66c2b5). Idea from `residency.md`: 90% of the rays of a brain are dead, and their layer-0 rows were 98% of the dead bytes the brain kernel streamed. Take them out of the streamed block.

## What changed
`brain.wat` (+28 -11), `brainKernel.ts` (+37 -7), `senseKernels.ts` (1 line), a test (+23); generated kernels regenerated.
- A brain's block holds the dense part back to back in packarena's chunks: layer-0 rows of the extras and memory inputs, the bias row, later layers, input and output vectors. The layer-0 rows of the first `rayInputs` inputs (`rayCount x rayFeatures`, from the plan) live in a region of their own (`Arena.alloc`, freed with the slot). `set(slot, sizes, genome, rayInputs = 0)`; any split from 0 to the input size gives the same bits.
- Descriptor: word 4 = ray inputs, word 5 = ray region address, sizes start at word 6, so the layer limit drops from 11 to 9 layers (the plan allows 6).
- `$layer` takes the init vector (bias row, or a partial sum) and a tanh flag instead of the input count. Layer 0 runs as two passes over the same column groups: the non-zero entries below the split (ray rows, virtual base at the ray region) store their partial sum to `dst`, then the rest (virtual base `dense - split x stride`) starts from `dst` and applies tanh. The non-zero list is ascending, so the add order per output is today's order, and an f32 store and reload is lossless. With no ray entry the first pass is skipped and the second starts from the bias row.
- The touch stream (`pf`, `pe`) is unchanged: it runs over the next brain's dense block, start of block to its input minus 256. The ray rows are read on demand when a ray hits.

## Measured
`liveBench --profile`, alternating base (perf-live, docs-only differences) and splitblocks, `taskset 2,3,6,7`, load 12-17. Fingerprints equal in every run (708687555 mixed 60 s, 10334191 cap, 164690887 mixed 600 s, 847136415 mixed 1800 s).

| Case | cpuMsPerTick base / new | brain forward base / new | brain / senser base / new | peakRssMB base / new |
|------|-------------------------|--------------------------|---------------------------|----------------------|
| mixed 60 s, 3 pairs | 11.11, 11.05, 11.00 / 10.96, 10.91, 10.71 | 4.21, 4.22, 4.20 / 4.06, 4.05, 3.98 | 1.039, 1.052, 1.048 / 1.013, 1.010, 1.010 | 217, 215, 219 / 221, 223, 219 |
| cap, juggernaut 4900, 60 s, 3 pairs | 13.10, 11.98, 13.08 / 12.34, 12.46, 12.71 | 4.26, 3.84, 4.29 / 3.74, 3.82, 3.88 | 0.854, 0.837, 0.864 / 0.770, 0.784, 0.775 | 252, 256, 257 / 257, 253, 252 |
| mixed 600 s, 3 pairs | 10.05, 10.30, 10.29 / 9.36, 10.18, 10.07 | 4.12, 4.23, 4.17 / 3.71, 4.01, 3.99 | 1.287 / 1.214 (pair 1) | 221, 224, 227 / 259, 221, 223 |
| mixed 1800 s, 1 pair | 8.60 / 8.08 | 3.54 / 3.18 | 1.40 / 1.29 | 235 / 235 |

Ratios of medians (new / base): mixed 60 s cpuMsPerTick 0.987, brain phase 0.962; cap cpuMsPerTick 0.952, brain phase 0.896; mixed 600 s cpuMsPerTick 0.979 (per pair 0.931, 0.989, 0.979), brain 0.96 (pairs 0.90, 0.95, 0.96); mixed 1800 s 0.939, brain 0.90. The brain phase gain grows with the world's age, as packing matters more there.
Memory: wasm memory top 45.6 vs 45.7 MB (600 s) and 51.3 vs 51.4 MB (1800 s). The one RSS outlier (259 MB, 600 s pair 1) did not repeat (221, 223 in pairs 2 and 3; base 221-227), so it is run noise of the JS heap, not the arena.

Harness bound (residency.md) was 1.03-1.07x mixed and 1.07-1.12x cap for the kernel; in the tick: 0.96x and 0.90x of the brain phase. No other phase moved (senser 0.98-1.00, slots 0.99).

## Verdict suggestion
Exact (four fingerprints equal), memory unchanged, 4.8% of the cap tick, 1.3% of the mixed tick at 60 s and 2-6% at 600-1800 s, about 130 changed lines on top of packarena. Clears the 1.5% bar at the cap with the mixed case not worse, but it needs the packarena allocator (parked, 0-3% of the brain phase on its own) merged first. Recommend merging the pair. The 9-layer limit (was 11) is the only rule change.
