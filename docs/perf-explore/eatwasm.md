| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| WASM `touch` kernel: first touched item per creature from the packed item rows | 66.2 ms CPU/tick (Inland, 9760 creatures, serial, median of 4; eat 5.38 ms) | 65.6 (eat 4.85) | 1.009x (4 alternating pairs, load 16 to 18; base 64.7/65.9/66.4/68.0, new 65.5/65.5/65.7/67.5) | yes: 739359978, 877945501, 410981010, Trials 727564408, Inland 830514026 | none measurable (338 to 381 vs 342 to 383 MB; +4 bytes per packed item slot) | +57 wat, +53 senser.ts, +5 senseKernels.ts, +2 ecosystem.ts | Not worth it |

Branch `eatwasm`. Eat gains about 0.5 ms of its 5.4 ms. The rest is the one crowd rebuild (about 2.3 ms) and the JS eat loop, which a lookup kernel cannot touch.

## Exactness notes
- World item positions are `Float32Array`, so the packed f32 rows hold exactly the values `firstItemWithin` reads. The kernel promotes to f64 and uses the same subtract, square, add, `< reach^2` as the JS.
- Cell ranges use the same `floor((x -+ reach) * (1/cell))` clamps. NaN or infinite positions give -1 in both (empty range or NaN compare).
- The packed rows hold no item index, so a new i32 id array runs beside them (written in `writeCell`, shifted in `patchCell`).
- Freshness: `World.version` (now public) is recorded at the end of `syncItems`; the kernel is used only if it still matches, else `touchedBatch` runs as before. Items eaten earlier in the tick are handled by the unchanged eat loop (lookup done before it, item gone means re-resolve).
- The crowd xs, ys, owners are copied into wasm memory each tick (about 0.1 ms).
