# Idea 53: JS side of the tick at the cap and in an aged world (study, nothing built)

Branch `pl-capprof` from `perf-live` 3d33e82. Stopped at the study: no JS function is above 1.2% of the tick and the one that is (`mutate`) has no exact cut worth its lines.

## How
`node --cpu-prof --cpu-prof-interval 200` on `server/src/liveBench.ts`, 1800 ticks (60 s) and 18000 ticks (600 s), with `--trace-gc`; kernel phases from a separate `--profile` run.
Profile samples are wall time (load 17 to 29, so the tick runs about 5x slower in wall than in CPU); only shares are used: samples from the first `sharedPhase` on, first quarter of them dropped, share times the run's `cpuMsPerTick`.
WebAssembly functions are unnamed in the profile and counted as one block.
Cases: mixed (4 founders x 800), cap60 (`--only juggernaut --copies 4900`, 60 s, population 4900 all run), cap600 (same seed, 600 s, population falls to about 3000 after the first 200 s).

## Kernel phases (`--profile`, ms per steady tick)
| Phase              | mixed 60 s | cap 60 s | cap 600 s |
|--------------------|-----------:|---------:|----------:|
| cpuMsPerTick       | 14.41      | 17.46    | 12.53     |
| steady population  | 3306       | 4900     | 3202      |
| crowd grid         | 0.21       | 0.50     | 0.58      |
| slots              | 0.36       | 0.53     | 0.39      |
| senser             | 5.70       | 7.18     | 4.36      |
| brain forward      | 5.02       | 5.12     | 3.66      |
| memory and steer   | 1.40       | 1.71     | 1.48      |
| eat                | 1.17       | 1.56     | 1.11      |
| collisions         | 0.24       | 0.32     | 0.21      |
| settle and deaths  | 0.09       | 0.14     | 0.14      |
| births             | 0.10       | 0.26     | 0.50      |
| regrow             | 0.08       | 0.08     | 0.07      |
Fingerprints 708687555 (mixed) and 10334191 (cap 60 s) as expected; cap 600 s: 409868860, births 31151.

## JS functions by self time (ms per tick, share of the tick)
JS (everything outside WebAssembly) is 4.8% of the tick mixed, 5.6% cap 60 s, 8.3% cap 600 s.
| Function                              | mixed        | cap 60 s     | cap 600 s    |
|---------------------------------------|--------------|--------------|--------------|
| `patchCell` (senser.ts)               | 0.127 (0.83%) | 0.191 (1.02%) | 0.072 (0.57%) |
| `mutate` (ga.ts, in `giveBirth`)      | 0.010 (0.06%) | 0.035 (0.19%) | 0.141 (1.13%) |
| `forwardRun` (brainKernel.ts)         | 0.115 (0.75%) | 0.117 (0.63%) | 0.084 (0.67%) |
| `sharedPhase`                         | 0.081 (0.53%) | 0.088 (0.47%) | 0.083 (0.67%) |
| `runRows` (senseKernels.ts)           | under 0.01    | under 0.01    | 0.062 (0.49%) |
| `setOffsets` (senser.ts)              | under 0.01    | 0.015 (0.08%) | 0.043 (0.34%) |
| `swapRemove` + `admit` (memberTable)  | under 0.02    | 0.050 (0.27%) | 0.067 (0.53%) |
| `giveBirth` + brain `set` + `reset`   | under 0.02    | 0.03          | 0.065 (0.5%)  |
| `randomSpot` (item regrow)            | 0.030 (0.19%) | 0.032 (0.17%) | 0.024 (0.19%) |
| `bump` (contacts)                     | 0.009         | 0.025 (0.14%) | under 0.01    |
| garbage collector                     | 0.011 (0.07%) | under 0.01    | 0.034 (0.27%) |
Everything else (contacts bookkeeping, the eat loop, itemEconomy, the Map and array churn) is under 0.03 ms each. The eat loop, settle and `itemEconomy.regrow` do not show above 0.03.

## Allocation
`--trace-gc` with the semispace fixed at 1 MB (`--min-semi-space-size=1 --max-semi-space-size=1`), scavenges of the steady 1800 ticks as the difference of a 60 s and a 120 s run:
| Case   | Scavenges 60 s | 120 s | Per 1000 ticks | Allocated per tick | Mark-compacts after start-up |
|--------|---------------:|------:|---------------:|-------------------:|-----------------------------:|
| mixed  | 748            | 770   | 12             | about 12 KB        | 0                            |
| cap    | 779            | 846   | 37             | about 37 KB        | 1                            |
(The 60 s counts include the start-up build.) With the default growing semispace the cap run scavenged only 3 times in its 1800 ticks.
At about 0.5 ms a scavenge with nearly nothing surviving, the cost is 0.01 to 0.02 ms a tick (0.1%).
Per-tick allocations that remain, all per call or per event and none per creature: the `subarray` views and result list of `WasmMembers.run` (settle and birth scans), `ops.push({...})` objects in `collectOps` for each item set or removal (more at the cap, where more is eaten and regrown), and the `Set` in contacts for kills. Births reuse dead `EcoCreature` objects from `spare`.

## Findings
- At the cap the JS side is not different in kind from mixed: no function above 1.1% of the tick. The cap costs more in the kernels (crowd grid 0.5, senser 7.2, eat 1.6).
- In the aged world births grow (0.10 to 0.50 ms; 52 births a second). `mutate` is the largest JS item there at 0.14 ms (1.1%): it runs the mulberry32 stream inline once per gene (80 us a child, about 3 ns a gene), so it is at the floor for scalar JS. An exact cut would be a SIMD WebAssembly version of the draw (mulberry32 output depends only on `state + k*0x6d2b79f5`, so four draws go in one `i32x4.mul` pass) with a hit-mask fallback to `rng.normal()`. That would save at most 0.1 ms (0.8% aged, 0.2% mixed) for about 60 lines plus a kernel regenerated, so it is not built.
- `patchCell` is 0.8 to 1.0% mixed and cap 60 s: each changed item cell does three `copyWithin` calls that shift the rest of the row. Patching all dirty cells of a row in one pass would cut part of it (at best 0.1 ms, 0.5%) but changes `syncItems` structure; below the bar.
- Allocation is small and young-generation only; GC is at most 0.3% of the tick. Nothing to remove.

## Verdict
No build. JS is 5 to 8% of the tick spread over 20 functions, the largest 1.1%. The remaining time is the kernels (senser, brain forward, memory and steer, eat), already covered by other ideas. Reconsider `mutate` in SIMD only if populations with high birth rates (aged worlds) become the target.
