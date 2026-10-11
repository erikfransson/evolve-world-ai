# Brain kernel exploration

Branch `worktree-agent-a07783fcea3af73cf`. Measured under load 25-45 (user CPU is inflated about 5x versus an idle core, so only A/B ratios mean anything).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| All kept items below, kernel alone (746 real evolved shapes x3, real inputs, interleaved A/B) | 1.42 us/creature | 1.06 us | 1.33x | bit-identical (0 differing outputs of 2238 creatures) | none | about +60 wat, +25 ts | Recommended |
| Same, ecoBench width 20000 (2626 creatures), cpuMs/tick, 4 pairs | 22.5 median | 20.7 median | 1.08x | fingerprint 179585160 both | 250 vs 248 MB | | Recommended |
| Same, width 30000 (6115 creatures), 3 pairs | 56.7 median | 50.2 median | 1.13x | fingerprint 326816534 both | 440 vs 438 MB | | Recommended |
| Grouping by identical layer shape | | | | | | | Rejected: 1663 distinct shapes among about 4000 creatures |
| Batch whole population in one call | already so | | | | | | Nothing to gain |
| Branch-free SIMD packing of non-zero first-layer inputs (80% of inputs are zero, the per-input zero test mispredicted) | | | about 1.2x of kernel | yes, same order and skips | | | Kept |
| Pad outputs to 4 instead of 8, last layer stores straight to the output, no copy loop | | | part of 1.33x | yes | less weight memory | | Kept |
| Slot list passed to the kernel instead of copying 64-byte descriptors per creature in JS | 0.2 us/creature | | part of 1.33x | yes | | | Kept |
| Creature reads outputs in place from kernel memory (`adoptOutput`) instead of a JS copy loop | copy was about 4.5% of a tick | | part of the 1.08-1.13x | yes | none | about +12 ts | Kept |
| Merge layer and block calls | 1.067 | 1.061 | none | yes | | | Rejected |
| tanh variants | | | | | | | Unchanged: about 27% of the kernel but needs the exact Pade ops and the division |

## Findings
- The kernel is latency bound, not memory bound: per-creature time is the same for 746 or 5968 creatures. Dependent add chains (order fixed by exactness), then tanh with its division, then the next layer waits. With the MACs removed the kernel still costs 80%, so unrolling and weight layout gain little. Only interleaving two creatures would hide the latency (shapes differ, large complexity, not tried).
- Safe WASM features: base SIMD128 only (i8x16.swizzle, i32x4.bitmask, f32x4.ne; Chrome 91, Firefox 89, Safari 16.4). Relaxed SIMD (fma) is not used and would change results.
- Microbenchmark and A/B scripts are in the scratchpad `opt2/brain/` (brainBench.ts, brainKernelOld.ts, ab.sh, pairs.sh), not committed.
- Checked: ecoBench `--pop 600 --seconds 30` = 494818766, `--predators --seconds 40` = 792910110; vitest wasmKernels, creature, ecosystem, ecoPool pass (new test for sparse inputs of any length).
