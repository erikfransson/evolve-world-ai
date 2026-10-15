| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Body inputs and ground factor computed in fill.wat from the rows (imported Math.exp, ground raster copy, per-species table); `prepareRows` removed; row 192 to 144 bytes | 46.53 ms per tick (slots 2.8 + senser 17.7) | 45.79 (senser 19.5) | 1.016x | bit-identical, every fingerprint | +0.5 MB (noise) | +133 / -67 (net +66 incl. 40 generated) | Marginal, mergeable |
| Crowd copy by typed-array set (xs, ys, owners, species) | 19.55 senser+slots | 19.50 | 1.00x | yes | 0 | - | Rejected |
| Fill visits creatures in record order (sequential record writes, ground lookups coherent) | fill 4.06 ms/call | 4.18 | 0.97x | yes | 0 | - | Rejected |

Branch `onecall` on origin/development 5f17c6e. Inland Sea, 10000 creatures, serial, wasm on, 12 s, `--profile`, 3 alternating pairs, medians of cpuMsPerTick (base 46.43 / 46.71 / 46.53, onecall 45.78 / 46.08 / 45.79), load 13 to 14. Fingerprints equal base: 739359978 (also `--threads 3`), 877945501 (`eco.wasm=false`), 410981010 (predators), Trials 727564408, Inland 15 s 830514026. vitest wasmKernels, residentBodies, ecosystem pass (the Inland residentBodies test timed out once under the full parallel suite, passes alone; the live* tests need server/node_modules).

## What changed
- The per-creature JS loop (`prepareRows`) is gone. `fill.wat` now computes the five body inputs and the ground factor itself, from the row fields, with the arithmetic of `Creature.writeBodyInputs` in the same order. Offsets come from `layout.ts` (new call block fields F_SPECIES, F_GROUND*, F_FACTOR_*); `wasmAssemble.ts` also substitutes GROUND_HALF and GROUND_PAD from groundField.ts.
- Exactness: the energy signal calls the host `Math.exp` through a WASM import, so it is the engine's own value (no fdlibm port). The ground value is `GroundField.valueAt` in f64 on a per-call copy of the raster (under 0.5 MB, copied whole so a hand-edited field cannot go stale).
- The row no longer stores the five extras, so it shrinks from 192 to 144 bytes (timing equal to 192).
- The fill and sense are still two WASM calls with the crowd copy between them. Fusing them into one call saves only the call boundary (microseconds), so it was not built.

## Where the time goes (fill call, ms, base JS prepare plus fill 2.8 + 1.84 = 4.6; now 4.3)
Ablations on the WAT: no exp 3.6, also no ground 2.2. So exp via import about 0.7, ground lookup about 1.4 (raster reads, cache bound, same as in JS), arithmetic and extra stores about 0.4. The JS version of the same work was already about as fast, so moving it saves only the JS loop overhead.

## Verdict
1.016x for +66 net lines and no new concept besides one import. Mergeable but marginal. A bigger gain would need the ground lookup itself cheaper (coarser raster cache, or storing the ground value per creature from the previous step, which is not exact).

## New ideas, not tried
1. Ground value of the next tick computed in the move pass in WASM (positions are final then) and stored in the row, so fill reads it; only exact if collisions never move a creature afterwards (they do), so it would need a recheck pass.
2. A step kernel for remember and stepBody in WAT with imported Math.sin, cos and exp (exact via the engine's own functions, no fdlibm port): memory and steer is 6.8 ms, wasmstep.md measured the copies away now.
3. Crowd grid gather (rebuildRows) in WAT from the row list: about 2.1 ms.
