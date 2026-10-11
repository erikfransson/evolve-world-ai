# Rays: exact speedups for sensing at 20k+ worlds

Branch `worktree-agent-a37a13906432bc563`. Bench: `node src/ecoBench.ts --width 20000` (new flag: height and default population scale with area, so 20000 x 12500 and 2778 founders), 400 ticks, steady last 300. Timings use in-process wrappers. Machine load was 25-50 throughout, so absolute ms are inflated about 2x and noise is +-5%. Numbers are medians of 4 alternating pairs, cpu is process user ms per tick. All fingerprints are identical to before (JS 565757636, WASM 48753914) and the unit tests pass (world, ecosystem, ecoPool, tsc).

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| Skip wall math when no wall is within ray length | cpu 38.4 ms/tick (item rays 13.5 ms) | cpu 36.9 (12.1) | 1.04x tick, 1.10x item rays | yes, bit-identical | Kept |
| Block stamps (4x4 cells) for cache validity | cpu 37.0 (item rays 13.2) | cpu 36.2 (11.4) | 1.02x tick, 1.12x item rays | yes, bit-identical | Kept |
| Both together, JS path | cpu 37.2 (item rays 11.0) | cpu 35.5 (9.4) | 1.05x tick, 1.17x item rays | yes | Kept |
| Both together, WASM path (default) | cpu 32.7 (item rays 11.8), wall 42.4 | cpu 31.3 (9.7), wall 39.5 | 1.04x cpu, 1.07x wall | yes | Kept |
| Candidate scratch shared in World instead of per creature | cpu 36.9 | 36.9 | 1.00x | yes | Rejected, no gain |
| Crowd cell size 50 / 200 / 300 instead of 100 (pop 8000) | crowd rays 22-29 ms | 21-33 ms | none | no, fingerprint changes (collision order uses the same grid) | Rejected |
| Exact reuse of a creature's rays when nothing changed | n/a | n/a | n/a | would be | Dead: 0 of 265k creature-ticks had the same pose, 9.5% only stood still while turning |
| Occupancy bitmaps, DDA traversal, sort by distance bound | not built | not built | n/a | would be | Not worth it, see below |

## What dominates at 20k+

Per-creature work does not grow with world size. Density is held constant, so 20k costs the same per creature as 12k. What grows is the working set (one RayCache per creature, 25k grid cells) and the number of creatures.
Profile at width 20000, 2600 creatures, JS path: sparse first layer 18%, item rays (World.castRays plus listValid and rebuildList) about 21%, forward 10%, encode 8%, crowd rays 7%, the rest below 5% each. With WASM on, item rays are the largest single piece (about 22% of the tick) because brains and crowd rays moved to WASM.
At pop 8000 on the same world (3x density, a Predators & prey proxy): item rays 26%, crowd rays 17% of sense time.

Counts from an instrumented run (20000 world, 600 ticks):
- The ray cache is valid on 95% of casts. Rebuilds are 5.3% of casts, 4.5% of them from invalidation, the rest from moving past the slack. Average 30 cells per rebuild.
- Average list 9.7 items, 3.7 candidates after the distance and wedge cull, 8 rays per creature, 90% of rays hit nothing, 7.8% food, 1% each poison and wall.
- The validity check walked 50 cell stamps per cast on average, now about 9 block stamps.

## What I tried

1. Wall skip. Rays only test walls when the creature is within length*(1+1e-6) of one. Rays are unit length to rounding, so the skip is exact. Round 2 rejected this at 2% in Trials (small world, most creatures near walls). At 20k only about 4% of creatures are near a wall.
2. Block stamps. `blockStamp` records the last change per 4x4 cells. `listValid` skips unchanged blocks and only looks at cell stamps inside changed ones, so the answer is the same as before.
3. Shared candidate scratch: tested and reverted. Saves memory per creature but not time.
4. Crowd cell size: not exact. The same grid orders the collision pass, so any change moves the fingerprint. Timing was flat anyway.

## Why the big ideas are not worth it

- Occupancy bitmaps and DDA early exit would replace the gather step. The gather is already small: lists hold about 10 items, 3.7 candidates, and the list is reused for 95% of casts. A DDA would only touch the 5% rebuild path (about 2% of the tick).
- Sorting candidates by distance bound: with 3.7 candidates per creature there is nothing to prune.
- Narrower exact invalidation: the hit rate is already 95%, and a rebuild or reuse gives the same candidate set in the same order, so invalidation precision only changes speed.
- Fan reuse across ticks: poses never repeat (measured).

## Promising but untried

- Item rays in WASM with f64 arithmetic. WASM f64 add, mul and sqrt are IEEE exact, so it would stay bit-identical with the JS item path. Item rays are about 22% of the WASM tick, and scalar f64 WASM is likely only 1.2-1.5x over this JIT code, so at most 5% of the tick. About 150 lines of wat.
- Pooling every creature's RayCache into one structure-of-arrays buffer for cache locality at 10k creatures. The scratch experiment hints that the gain is small.

## Cost

Wall skip 8 lines, block stamps 20 lines (both in sim/world.ts), `--width` flag in ecoBench 4 lines. The Predators & prey branch has the same World code, so both changes transplant unchanged.
