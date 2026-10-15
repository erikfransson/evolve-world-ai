# Brain kernel, tanh latency overlap (tanhil)

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Split the 64-wide layer loop in two halves so tanh of groups 0-1 runs while groups 2-3 accumulate | 10.91 ms kernel median (min 10.55) | 11.54 (min 10.90) | 0.95x | yes (same md5 on all outputs) | not measured, kernel only | +20 wat | Rejected, the second pass over the input list costs more than the overlap gains |

Microbench as in `brain2.md`: the Inland world dumped at tick 400, `forward` alone, 25 interleaved reps, load about 16.

The ceiling is small. The brain2 ablation shows tanh in all layers costs about 1.2 ms of an 11.2 ms kernel, and the four tanh calls at the end of a layer are already independent, so the divide pipelines across them. Interleaving two creatures would also need matching layer shapes for the fused loop. Brain2 found 4281 distinct shapes among 9411 creatures, so most pairs would fall back to the single-creature path. Not built: the ceiling is about 1.7% of a tick and the shape match makes the code large.

No kernel change is kept, so `npm run wasm` and the whole-tick bench were not run.

Branch `tanhil` holds this note only.
