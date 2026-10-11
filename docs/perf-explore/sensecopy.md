# Sense kernel copy cost: is the per-batch item grid copy worth removing?

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Keep item grid resident in WASM, apply item changes only | grid copy 0.18 ms of 24.2 ms (20k), 1.0 ms of 104 ms (50k) | not built, upper bound = removing the whole grid copy | at most 1.007x at 20k, 1.010x at 50k (serial) | would be exact | none to -2 MB per owner | est. 60-100 (change feed on coordinator, replay in each owner) | Not worth it |
| World arrays stored directly in WASM memory | same | not built | same bound | exact | -2.3 MB per owner at 50k (of about 580 MB) | est. 50 + risk: memory.grow detaches views | Not worth it |
| Copy only cells near the batch's creatures | same | not built | below the bound | exact | none | est. 60+ | Not worth it |

Measured with temporary hrtime timers around each block of `WasmSenser.run` (reverted, nothing to merge). Serial, `nice -n 19`, load 11 to 14, steady ticks, per call (one call per tick serial).

| Width | Item capacity | Cells | Grid copy (xs, ys, kinds, nextItem, cellHead) | Crowd copy loop | Per-creature records | WASM kernel | cpuMsPerTick | WASM memory | Peak RSS |
|-------|---------------|-------|-----|-----|------|------|-------|-------|--------|
| 20000 | 20000  | 25000  | 0.09-0.18 ms (0.9 MB) | 0.42-0.46 ms | 2.3 ms | 9.2-10.3 ms | 23.4-24.2 | 20 MB | 260 MB |
| 50000 | 125000 | 156500 | 0.75-1.0 ms (2.3 MB)  | 1.9-2.4 ms   | 11.8-16 ms | 48-52 ms | 104-105 | 76 MB | 581 MB |

- The capacity does grow 6.25x from 20k to 50k, but so does the tick, so the grid copy stays at 0.4 to 1.0% of CPU per tick. It is about 2.8 GB/s, plain typed-array `set`.
- The per-creature loops that remain are bigger than the grid copy: crowd copy (includes the `energySignal` exp per crowd member) 1.8%, record writing (needs each creature's state, heading, body inputs) 11-15%. Neither is removable by a resident grid.
- Threads 3 at 20k: fingerprint 105589597 for this seed/length, cpuMsPerTick 37.2, RSS 522 MB. Each of the 4 owners copies its own grid, so total copy CPU is about 4x the serial figure (at 50k about 3 to 4 ms per tick of roughly 105+ ms CPU, 3% at most), but it runs in parallel so the wall cost stays about 1%.
- Bit-identical fingerprints are unaffected (timers only, reverted).
- Resident grid costs: coordinator and helpers both need a change feed (the journal exists for helpers only, the coordinator has no `log`), and World writes during eating/regrow happen in many places. Direct-in-WASM World arrays are fragile since `memory.grow` (brain bank allocs) detaches every typed-array view.

Recommendation: leave as is. A gain over 1% is not reachable from this copy, at several dozen lines and a new invariant.
