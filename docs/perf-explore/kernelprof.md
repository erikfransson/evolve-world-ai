| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Wall-free ray state and f32 directions written in the direction loop, wall loop only near a wall (committed) | kernel 15.3 ms min, tick 64.9 ms (median of 4 pairs) | kernel 14.7 ms min (-0.5), tick 65.1 | 1.04x kernel, 1.00x tick | yes, wasmKernels 24 tests, all fingerprints incl. Inland 830514026 | none | +12 -10 wat | Not worth merging, invisible at tick level |
| Per-row cell range cut to the distance circle (sqrt per row) | 15.5 | 18.4 | 0.84x | yes (hash) | none | +12 | Rejected, per-row sqrt costs more than the 6.4 to about 4.5 items saved |
| f32 four-ray prefilter before the f64 item test | 15.5 | 16.1 | 0.96x | yes | none | +25 | Rejected |
| Crowd gather before the closeness loop, skip crowd ray pass and best-distance store when no crowd candidate (59% of creatures) | 14.8 | 14.7 | none | yes | none | +6 | Rejected, noise |
| Item scan loop split on wedge (no wedge arithmetic when the fan is wide) | 15.5 | 15.5 | none | yes | none | +20 | Rejected |
| Touch-ahead of offset tables, item and crowd row starts for creature j+3 | 15.4 | 15.6-16.2 | 0.95x | yes | none | +30 | Rejected, as in brain2 |

Microbench: the real Inland world dumped after the `sense` call of tick 400 (9411 creatures, 75 MB memory), `sense` timed alone, variants interleaved, 25-40 reps, inputs hashed (all variants equal bae5def...). Load 15-18, so only same-run ratios mean anything. Reference kernel 15.2-15.5 ms min (the 19 ms in the brief is under heavier load). Scripts in the scratchpad `b2/kp/`.

## Cost per part (ms of 15.4, 9411 creatures)
Two measures. Cumulative: kernel truncated after each stage, includes first touch of memory. Hot: stage run twice, the delta, caches warm.

| Part | Cumulative | Hot | ns per creature (cumulative) |
|------|-----------:|----:|----:|
| Record load | 0.1 | | 12 |
| Ray directions (cos/sin tables) | 1.45 | 0.5 | 154 |
| Item cell walk and candidates | 2.95 | 2.5 | 313 |
| Rock walk | 1.2 | 1.1 | 130 |
| Wall loop (almost never active) | 0.8 | 0.3 | 82 |
| Item ray tests (prefilter and exact) | 2.3 | 2.2 | 245 |
| Closeness loop | 1.1 | | 114 |
| Crowd gather | 2.45 | 2.1 | 260 |
| Crowd ray tests | 1.0 | 0.5 | 103 |
| Feature writes | 2.3 | 2.0 | 245 |

The four per-ray loops (directions, wall, closeness, features) are 5.6 ms, 36% of the kernel, and each is a separate pass over about 8.5 rays; the walks and tests are 7 ms.

## Per creature (counters in an instrumented kernel)
- 8.5 rays, 4.1 item grid rows visited, 6.4 items in the visited cells, 1.94 pass the distance and wedge test (the 36% have none, 23% one, 14% two, 8.6% three, rest up to 15+).
- Item ray tests: 8.5 two-ray prefilter groups, 0.57 rays pass and run the exact quadratic (0.57 exact tests per creature). The exact test is nothing, the cost is the loop structure.
- Rock: 0.26 candidates. Crowd: 3.1 scanned, 0.68 kept (59% none, 24% one, 10% two), 1.6 four-ray group tests, wedge active for 51% of creatures, near a wall 1.8%.

## Findings
- The kernel is flat: no part is above 20%, and the cost tracks loop and branch count (rows, rays, candidates), not arithmetic. Cutting arithmetic (sqrt-based range, f32 prefilter, wedge split) is slower or equal. Cutting passes (the wall loop) gains about 3%.
- Software touch-ahead is slower again, so the first-touch part of the cumulative column is not recoverable by prefetch loads.
- Remaining ideas would need larger structure change (one fused per-ray pass for closeness, crowd merge and features, about 5% of the kernel at best, under 1.5% of the tick).
