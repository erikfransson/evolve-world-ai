# Area-scaling costs (items, grids) at fixed population

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Any cut of area-linear per-tick work (dirty tracking, sparse grids, compact items) | 38.7 / 41.2 ms CPU per tick at 38k / 50k wide, pop 5000 | not built | at most about 1.007x (patchCell 0.27 ms of 40 at 70k) | would be exact | none | 0 | Nothing to gain, not worth it |

`--pop 5000 --set eco.maxPopulation=5000`, 15 s runs (450 ticks), serial, nice 19, load 7 to 11, `node --cpu-prof`. Mean population 4860 to 4872.

| Width | Area (Mpx2) | cpuMsPerTick | Peak RSS |
|-------|-------------|--------------|----------|
| 38000 | 900  | 38.7 / 39.5 (profiled) | 211 / 223 MB |
| 50000 | 1560 | 41.2 | 216 MB |
| 70000 | 3055 | 37.0 (profiled) | 232 MB |

- Self time per function, 70k vs 38k: only `patchCell` (senser.ts) grows with area, 80 to 200 ms over 450 ticks (0.27 ms per tick extra). It shifts the rest of the packed item row (cols entries) per dirty cell. Every other function is equal or lower at 70k (noise, population matches).
- Per-tick full-grid sweeps are already gone: crowd rebuild (radix over occupied cells, a gap fill of about 150k Int32 at 50k), item sync by dirty cells, `crowd.cellStart` copy (0.63 MB at 50k, about 50 us). Regrowth, `tooClose` and `eatAt` are local lookups and do not show in the profile.
- Memory: RSS rises about 4 KB per Mpx2 (item arrays, cell heads, WASM packed rows), 9 MB for 70k vs 38k on a base of about 220 MB. Creatures dominate (about 23 KB each).
- Startup (scatter of 125k to 300k items and the first full pack) is one-off.
- A cheaper `patchCell` (gap buffer per row, or per-cell slack) would add a new invariant to save under 1%. Not done.
