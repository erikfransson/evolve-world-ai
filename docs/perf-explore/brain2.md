# Brain kernel, round 4 (B2): new exact angles

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| `v128.load32_splat` instead of `f32x4.splat (f32.load)` | 10.7-11.0 ms kernel (min of 40) | 10.7 | within noise | yes (same hash) | none | 0 net | Rejected |
| `i32.popcnt` instead of the count table load in compaction | 11.0 | 10.9 | noise | yes | none | 0 net | Rejected |
| Skip empty 4-input groups with a branch in compaction (70% of groups are empty) | 10.98 | 11.01 | none | yes | none | +2 | Rejected, mispredicts cancel the saving |
| Dense layers walk src and weight rows by pointer (no iota list, no per-input multiply) | 10.41 | 10.40 | none | yes | none | +60 wat | Rejected |
| Touch all weights of creature c+2 before c (software prefetch upper bound) | 10.8 | 12.5 | 0.86x | yes | none | | Rejected |
| Memory-unit update fused into the kernel | `remember` 3.2 ms/tick (of 12 ms memory and steer) | not built | at most 3 ms (4% of 70) | would be | | | Not tried, needs units as f64 in WASM memory (SoA move, see trig.md) |

Microbench: the real Inland world dumped at tick 400 (9411 creatures, 75 MB WASM memory), `forward` timed alone, variants interleaved, output md5 compared (all identical). Load 20-40, so only same-run ratios mean anything. Baseline run: fingerprint 830514026, cpuMsPerTick 70.9, peak RSS 352 MB (matches the brief). No code was merged; the branch holds this note only. Scripts are in the scratchpad `b2/brain2/`.

## Shape distribution (Inland, 9411 creatures)
- 87% have one hidden layer (3 sizes), 8% two, 3% three, 2% four. 4281 distinct shapes, the most common holds 63 creatures (0.7%), so grouping by identical sizes and weight streaming across creatures has nothing to work with.
- First hidden 4 to 32 (mean about 17), outputs 2 to 18 (mean about 9), inputs 17 to 117.
- Non-zero inputs: mean 13.5 of about 60 (p10 6, p50 13, p90 21, max 54). The last 16 or so inputs (extras, memory units) are nearly always non-zero, the ray part is sparse. 70% of aligned 4-groups and 49% of 16-groups are all zero, but the zeros are scattered, so branching on them mispredicts. 192 inputs are -0.0, treated as zero already.
- A superset list (zeros included) is not bit-safe in theory (-0 accumulators, inf weights), so moving the non-zero test into the senser was not tried.

## Cost split (ablation, same dump, kernel 11.2 ms)
- Second and later layers including tanh and output store: 3.6 ms (33%).
- First layer, compaction, MACs, tanh: 7.5 ms. Compaction alone 2.4 ms (21%, partly first touch of the input vector). tanh in all layers: 1.2 ms (11%).
- Cache: 1200 creatures run 0.9-1.0 us each, all 9411 run 1.17 us, so at most 20% is memory, and touching ahead made it slower. Instruction trimming shows nothing either, so the cost is neither op count nor memory.

## Verdict
Nothing found that is exact and faster. Not worth merging. Remaining bigger moves: interleave two creatures (large), or move creature state into WASM (SoA) which also takes `remember` and steer.
