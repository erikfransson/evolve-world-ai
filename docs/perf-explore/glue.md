| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Per-slot cache of ray count, offsets pointer, input offset and ray length (drops `c.plan`, `bank.inputAt`, `offPtr` reads in the fill loop) | fill 9.9 / 10.6 / 10.1 ms per call | 9.6 / 9.8 / 9.7 | about 1.03x of the fill, below tick noise | yes (10 s fingerprint equal to base) | +0 | +20 | Not worth it |
| Reuse the crowd copy's energy signal for the creature's own first body input (one `exp` less per creature) | 9.6 / 9.8 | 10.3 / 10.0 / 10.5 | none measurable | yes | +0 | +4 | Not worth it |
| Fill loop in its own method (own type feedback) | 11.5 / 11.2 / 10.1 | 10.7 / 10.3 / 10.5 | within noise | yes | +0 | +6 | Not worth it |
| Prefetch touch of creature k+8 | 10.5 / 10.0 | 12.0 / 11.9 | 0.85x (slower) | yes | +0 | +4 | Rejected |
| Fill in row-sorted order (sequential record writes, coherent ground lookups) | 10.2 / 10.8 / 10.8 | 19.5 / 18.5 | 0.55x (slower) | yes | +0 | +4 | Rejected |
| Shared clearance raster for keepOut and the kernel | - | not built | at most senserock's 1.02x | would be exact | +0.4 MB | est. +45 (sense.wat +16, senser.ts +20, terrain.ts buildNear rewrite) | Skipped, not "little code" for 1% |

Branch `glue` on `b2int`. Inland Sea, 10000 creatures, serial, wasm on, 10 s, load 11 to 18. Temporary `performance.now` timers (reverted) around the blocks of `WasmSenser.run`, ms per senser call at about 9800 creatures. cpuMsPerTick was 62 to 66 for every variant, i.e. noise (about +-3%) swamps anything below 2 ms. Only the 10 s fingerprint (415480571) was compared between variants, not the full brief set, since nothing is merged.

## Where the fill loop goes (ms per call, 2 to 3 repeats of each switch)
- Place + fill 10.0 (placeByRow alone 1.1). Kernel 19. Crowd copy 1.1. Item sync 0.4 to 0.8.
- Switching a part off (wrong results, timing only): body inputs off takes 10.0 to 4.0, so `writeBodyInputs` is about 6. Inside it: energy `exp` about 1.0, ground lookup about 2.2, memory units loop about 2.2. The rest of the record loop is about 3.
- Row-sorted visiting order costs +9 ms: the loop is bound by creature object traffic (creature, state, heading, units, plan objects), cheap only in heap order, as SenseBatch already sorts. A prefetch touch ahead only adds instructions.
- V8: no megamorphic or deopt problem in the loop (`--trace-deopt` shows only warm-up OSR).

## Conclusion
The glue is the cost of reading about five heap objects per creature. Per-slot caches and the saved `exp` are 1 to 3% of the fill (about 0.3 ms of 62), not provable against tick noise. Only a resident state layout (wasmstep.md, 1.2x estimate, large refactor) cuts it. Nothing merged.

## New ideas not tried
1. Write the memory units' f32 copy into the brain input region inside `remember()` (steer phase, already touching `units`), so the fill loop skips the units object (about 2 ms), at the cost of the creature knowing the bank offset.
2. Compute next tick's ground value in the move pass right after the position update, where the creature is already hot, instead of in the sense fill (about 2 ms moves, may net out).
3. Fold the per-creature traversals (slotOf, placeByRow row, fill) by recording `state.y` in the slots loop of SenseKernels.run.
