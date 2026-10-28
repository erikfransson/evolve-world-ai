# Idea 123: the small phases, what is left (scout, nothing built)

Branch `pl-smallphases` from `perf-live` 6f81ad5. (`smallphases.md` is an older, unrelated note of the same name, so this one is `smallphases2.md`.) All runs `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load 7-9, `kernelTimers.ts --copies 800 --ticks 400` (wasm rows, thread CPU) and `liveBench --seconds 30 --copies 800 --profile` (fingerprint 654925885 at 30 s). Result: no structural exact cut reaches 1.5% of the tick; the best measured is 0.4%.

## Breakdown (ms per tick, mixed 3300; head tick 11.4-12.3 under this load)

| Piece                                   | ms     | Note |
|-----------------------------------------|-------:|------|
| tick-start grid (refresh 0.7 / rebuild 0.3 calls) | 0.18-0.20 | `crowd grid` phase |
| prepare (slots phase)                   | 0.31-0.35 | of it ground lookup 0.17-0.21 (below), rest 0.084 |
| fill kernel                             | 0.27-0.33 | |
| pack (of it `Math.exp` 0.18)            | 0.21-0.24 | idea 109 parked |
| shared-phase rebuild (1 call per tick)  | 0.33-0.36 | inside `eat` |
| touch                                   | 0.37-0.42 | inside `eat`; hot second call 0.29 |
| eat JS                                  | 0.09      | `eatcost.md` |
| collisions (sweep 2.8 calls)            | 0.15-0.20 | `collide3.md` floor |
| settle (kernel 0.037, wrapper 0.065), births 0.045, regrow 0.057-0.10 | 0.2 | regrow = 15 `addRandomly` per tick at 3.8-4.5 us: 1.85 `accepts`, 1.06 `touchesRock`, one `tooClose` each, cold lines |

## Measured

1. Ground lookup in `prepare` (ablation `G_EMPTY` forced 1, timing only): prepare 0.294 to 0.084, fill unchanged within noise, so the lookup is 0.17-0.21 ms (1.5-1.9% of the tick, 64 ns per creature). Warm (second call) prepare is 0.157, so about 0.14 of the cold cost is cache misses (raster lines, 2 per creature, rows in slot order) and the rest compute.
2. 82% of creatures sit in a raster cell with no corner >= 128 in either layer (block of 8x8 nodes: 79%, 16x16: 75%; 17% have a nonzero ground value). Prototype: one byte per 8x8 node block (`bc*br` bytes, 1 KB, built where the raster is copied), tested after the clamps and `trunc`, skipping `$hit` calls when quiet. Exact (fingerprint 654925885 in 3 of 3 pairs), 25 lines in `fill.wat`, `fillKernel.ts`, `layout.ts` (reverted, not committed).
   Result: prepare 0.334 to 0.259 (4 pairs, -0.075), but fill +0.02 (0.29 to 0.32, the cold row misses move), net prepare+fill -0.05 to -0.06 (0.4-0.5%). liveBench pairs (slots / cpuMsPerTick): base 0.356 12.058, 0.353 12.129, 0.350 12.287; mask 0.273 11.922, 0.276 12.192, 0.309 12.577. Tick gain inside the noise.
   Ceiling: with the quiet path for every creature (branch never taken) prepare is 0.132; the 20% non-quiet creatures cost the other 0.13 (about 190 ns each, raster misses plus unpredictable branches). That is the remaining 1.1%, but it needs the lookup in an order where neighbours share raster lines (prepare in crowd cell order, rows then gathered) and was not tested.
3. Lookahead load of the raster lines 8 creatures ahead (dummy loads, no mask): prepare 0.33 to 0.55-0.62, much worse (cause not diagnosed, extra row and raster loads ahead stall the loop). Reverted.
4. Fusing prepare into fill: ablation floor of prepare+fill without the lookup is 0.43 against 0.62; fusing removes the extras f64 store and load, a second loop and row address loads, estimate 0.03-0.05 (fill's narrowing is already compute bound, `fillcut.md`). Row misses are paid once either way.
5. Regrow: all pieces cold JS lookups (rock grid, weight map, `cellHead`, caps); no exact cut found above 0.03.

## Ranked ideas

| # | Idea | Bound (ms, of 11.4) | Exact | Generality | Verdict |
|---|------|--------------------|-------|-----------|---------|
| 1 | Quiet-block mask for the ground lookup | measured -0.05 (0.4%) | yes, fingerprint equal | any raster size and map, mask built from the field, falls back to the full lookup in flagged blocks | Small, safe; mergeable only as part of a bundle |
| 2 | `prepare` in crowd cell order (raster lines shared), with #1 | up to -0.13 more, untested; likely half after the scattered row access | yes | any map | Worth a prototype only if a bundle is wanted; risk: fill moved +0.02 in #1 |
| 3 | Cell keys written by the step kernel, read by the shared-phase rebuild | rebuild key stage 19% of 0.34 = 0.065, minus the step cost, -0.04 | yes (same positions) | any | Not worth the cross-kernel contract |
| 4 | Fuse prepare into fill | -0.03 to -0.05 | yes | any | Marginal |

Together #1 + #4 + #3 ~ 0.12-0.15 ms (1.0-1.3%), three kernels touched; with #2 landing the best case is about 1.5-1.8%. Nothing here is the 1.5% single cut. The ground lookup (#1, #2) is the only small piece with a measured gap above 0.1 ms.
