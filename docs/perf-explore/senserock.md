| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Rock clearance raster (64-unit cells, u8 lower bound of distance to the nearest disc edge); kernel skips the rock walk when it exceeds the ray length | cpuMsPerTick 71.0 (median of 3 pairs), senser 30.7 ms | 69.6, senser 30.4 | 1.02x tick, 1.01x senser | yes, fingerprints 830514026 / 739359978 / 410981010 equal, wasmKernels and maps tests pass | +0.7 MB (raster 400 KB in wasm memory, plus a copy in JS) | about +60 (senser.ts +45, sense.wat +16, test +25) | Marginal, not worth merging alone |

Inland Sea, ~9600 creatures, serial, load 17-22. Pairs (base/new cpuMsPerTick): 71.49/69.37, 70.78/71.31, 70.95/69.64.

Where the senser time goes (ms per call, 9619 creatures, instrumented, load ~20-28, so absolute values inflated):
- Kernel 65%, JS glue 35% of the senser phase. Glue: record fill loop (state reads, `writeBodyInputs`, ground lookup) 11.9 of ~41 ms, crowd copy 1.8, row sort 1.6, item sync 0.6, params ~0.
- Inside the kernel: rock gather plus rock pass cost 4.5 of 19.1 ms before the raster, about 1.9 after. The rock walk is mostly overhead: only 0.25 rock candidates per creature survive the distance test (4.4% of creatures have any), 3.5 discs scanned and 18 cells visited per creature, 8.4 rays per creature. Massif edges do not make the candidate count large because rays are only about 100 long against 300-unit rock cells.
- So a per-ray early exit or a tighter candidate cull has nothing to cut: the exact ray tests on rock are already about 2 per creature. A prefilter for the rock pass was therefore not built.

Exactness argument: a disc is a candidate only if its centre is within L + r of the creature, so its edge is within L (1 + 1e-9) of it; the raster stores floor(distance from the cell rectangle to the edge / 4) - 1, so when 4q exceeds L (1 + 1e-9) + 0.001 no disc can pass the existing distance test and the walk would add nothing. 255 means far or unknown and never skips; positions outside the raster take the full walk. Test "a hair either side of the ray length from a rock edge" guards the boundary (it passes with and without the raster, being a parity guard).

Not done, glue is the larger part: the record fill loop (11.9 ms of ~41) is per-creature object traffic; `soa.md` found typed-array state 1.00x, but the ground lookup and `writeBodyInputs` are only part of it and were not split further.
