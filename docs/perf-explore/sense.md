# WASM sense kernel: fewer ray tests, cache-ordered batch

Branch `worktree-agent-a8989a874a0dee67e`. Bench: `ecoBench --width 38000 --seconds 10` and `--width 50000 --seconds 8`, serial, both about 9.9k creatures (population is higher than the 5k estimate in the brief). User CPU ms per tick, 3 alternating base/new pairs, load average 22-27 (shared laptop, absolute numbers inflated about 2x). Fingerprints equal in every pair (38000: 133019634, 50000: 608346714) and equal to the brief's (847633506 with 0 and 3 threads, 303607739 predators). vitest 681 passed (the 2 live*.test.ts files fail to import `ws` in this worktree, unrelated).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Candidate-major item trace with a two-ray f64x2 prefilter (a ray misses a disc unless its perpendicular distance is <= r) before the exact test | kernel 22.5 ms/tick (38000, 9867 creatures) | 18.1 ms | 1.24x kernel | yes, brain-input hash of all creatures equal | none | about +40 net in sense.wat | Merge |
| Batch placed in item-grid row order (counting sort in `senser.run`, kernel walks rows in order) | kernel 24.1 / 23.6 ms | 21.1 / 21.9 | 1.09x kernel | yes (order is free per creature) | +1 small Int32Array per row and per creature | +20 in senser.ts | Merge |
| Branch-free item and crowd walks (write candidate, advance by mask) | 23.9 ms | 22.9-23.3 | 1.02-1.04x kernel | yes | none | about +0 | Kept (cheap) |
| Branch-free item trace (selects instead of ifs), alone | 23.9 | 23.5 | 1.02x | yes | none | | Superseded by the prefilter |
| All of the above, whole tick, 38000 | 79.8 ms | 76.1 | 1.05x | yes | 326 -> 325 MB | | |
| All of the above, whole tick, 50000 | 85.0 ms | 73.7 | 1.15x | yes | 335 -> 338 MB | | |
| Narrow each row's cell range to the circle, SIMD f32 prefilter for the item walk, SoA item rows for f64x2 walks | not built | | | would be | | | Estimated under 8% of the kernel each, mispredicts eat it; skipped |

## Work per creature (38000, 9867 creatures, tick 150)

8.4 rays, mean ray length 149. Item grid: 17.9 cells in the box, 13.5 items scanned, 6.3 inside the distance circle, 4.1 candidates after the wedge cull (histogram: 20% have none, 12% have 10+). That is about 33 ray-candidate tests per creature before this change. Crowd grid: 17.9 cells, 3.0 entries scanned, 2.0 inside, 1.7 candidates.

## Where the kernel time went (variants with one loop disabled, same state, hot repeated calls)

Before: item walk plus trace 63% (trace about 7.7 of 26 ms, walk about 8.7), crowd walk 17%, rest 20%. After: item walk plus the new trace 47%, crowd walk 17%, feature merge 18%, crowd SIMD trace 8%, setup 9%.
The cost is instruction count, not memory or branches: warm repeated calls are only 14% faster than live ones, and branch-free rewrites changed little. The old trace did 8 rays x 4 candidates of f64 tests; the prefilter rejects most pairs with 2 muls, a sub, an abs and one compare for two rays at once.

## Exactness

A ray misses an item disc unless |perpendicular distance| <= r. The prefilter keeps |s| <= r + 1e-6 + 1e-9 L, far above the rounding of the exact test (about 1e-10 in the discriminant), and runs the unchanged exact arithmetic on survivors. Candidates are still applied to each ray in walk order, so ties resolve as before (wall wins an exact tie, first item wins among equals). Test "items grazing the rays" puts 270 items within 0.2% of the radius from the ray lines and compares every ray bit for bit with `World.castRays`.

## Not done / notes

- The JS half of `senser.run` (record fill, `writeBodyInputs`, crowd copy) is 7-8 ms/tick at 10k creatures versus 18 ms of kernel, left to the glue slimming planned by the RL session. `placeByRow` adds one pass over the batch (cheap) and keeps its own scratch arrays, so it composes with caching views per memory buffer.
- Per-creature kernel caching of candidate lists (rays.md: 95% cache validity) is not worth it any more: the walk is 36% of the kernel and a cache needs per-creature storage and stamp checks.
- Not measured: Great Hunt speed (fingerprint equal only).
