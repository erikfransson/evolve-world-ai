# Idea 141: the ground lookup in crowd cell order (rejected), and what replaced it (built)

Branch `pl-groundorder` from `perf-live` 6935157. All runs `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load 8-20. Question from `smallphases2.md` #2: run `prepare`'s ground lookup in crowd cell order so neighbours share raster lines. Answer: it is slower in every form. The measurement showed instead that the lookup is mostly compute, and a quiet-block mask plus a branch-free two-layer blend cuts the slots phase by 0.10-0.14 ms (exact, built).

## Harness
`prepare` timed in the kernel harness of `sensebudget.md` (live world to call 300, memory restored and a 32 MB sweep before each call, thread CPU, 60-80 reps, p25, variants alternated; `WARM=1` calls once untimed first). Equal memory hash = exact. Mixed 3200 creatures, cap 4900 juggernauts. Raster of the Inland Sea: 628 x 394 nodes, 495 KB; 21% of creatures (674 of 3200 mixed, 1028 of 4900 cap) sit in a block of 8 x 8 cells with a corner at 128 or more. Each cell below is `variant (base of the same run)`, the runs differ in load; rows without a base share the first run (base 0.341, 0.253, 0.508, 0.362).

| prepare, ms (p25)                                        | mixed cold    | mixed warm    | cap cold      | cap warm      |
|----------------------------------------------------------|--------------:|--------------:|--------------:|--------------:|
| no lookup at all (floor)                                 | 0.101 (0.341) | 0.066 (0.253) | 0.152 (0.508) | 0.104 (0.362) |
| whole body in cell order (rows via owners)               | 0.683         | 0.580         | 1.145         | 0.864         |
| ground only in cell order, results gathered by row       | 0.457         | 0.264         | 0.702         | 0.401         |
| slot order, raster words loaded first, then branch       | 0.302         | 0.217         | 0.464         | 0.330         |
| quiet-block mask, old scalar blend                       | 0.296         | 0.241         | 0.452         | 0.360         |
| mask + f64x2 blend, first prototype                      | 0.246 (0.353) | 0.175 (0.253) | 0.363 (0.497) | 0.276 (0.392) |
| mask + f64x2 blend, as built                             | 0.240 (0.343) | 0.162 (0.239) | 0.333 (0.468) | 0.271 (0.372) |

The branch-free f64x2 blend without the mask is slower than base (0.393 against 0.351 cold mixed): the blend is only worth running in the 21% flagged blocks.

## Why cell order loses
The rows are 192 bytes (3 lines) and visited in slot order, which the prefetcher follows. In cell order every row is a scattered 3-line miss (plus the owners and member-index passes, about 0.02 ms), and that costs more than the raster lines it saves. Even the variant that only reads x, y in cell order and gathers a 4-byte result per row is +0.11 cold. The lookup itself is not miss bound: warm it still costs 0.19 of the 0.25, cold adds only 0.05-0.07.

## What the lookup costs
Quiet path only (mask test, nothing else): 0.145 against floor 0.102, so position, clamps and the mask byte are 0.04. The flagged 21% cost the other 0.10 in the old scalar code and 0.10 minus the mispredicts in the new one (a two-loop version that appends flagged creatures to a list and blends them afterwards ran the same, 0.243 against 0.248, so mispredicts are not the cost). The raster words of flagged creatures are cold (0.06 for 674 creatures); wasm has no prefetch and a lookahead load blocks retirement as well.

## Built
- `GroundField.blockFlags()`: one byte per 8 x 8 cells, 1 when a corner of one of its cells reaches 128 in either layer; copied beside the raster when the field changes (13-55 ms in JS for a dense random field of the largest size, once per map and field change, never per tick).
- `fill.wat` `prepare`: position and fractions as one f64x2 chain; flagged block only: both layers blended at once in f64x2 (lane 0 mud, lane 1 firm, the same operations in the same order as `GroundField.valueAt`), value and factor by selects, mud first. The old `$hit` early return (no corner at 128 or more) is gone, exact because a convex blend of corners of at most 127 stays under 127.5.
- Layout: `G_MASK`, `G_MASK_COLS`, `G_BLOCK_SHIFT`, `G_BYTES` 64 to 80. `prepareRows` (JS twin) is unchanged; its test now also runs hand-made fields (sizes off the block grid, weak 127 corners, 128 corners, both layers high, points on block edges and outside the map) and `blockFlags` has a brute-force test. Mutating `blockFlags` to skip the left or upper neighbour cell turns three tests red.

## Whole tick (`liveBench --profile --seconds 60`, 3 alternating pairs, base = perf-live worktree)

| Case  | Build | cpuMsPerTick                       | slots ms                 | peak RSS MB   | fingerprint |
|-------|-------|------------------------------------|--------------------------|---------------|-------------|
| mixed | base  | 10.776, 10.997, 11.105 (med 10.997) | 0.331, 0.344, 0.350      | 217, 224, 216 | 708687555   |
| mixed | yours | 10.918, 10.898, 10.885 (med 10.898) | 0.231, 0.228, 0.229      | 219, 217, 214 | 708687555   |
| cap   | base  | 12.705, 12.842, 12.638 (med 12.705) | 0.467, 0.483, 0.458      | 256, 255, 257 | 10334191    |
| cap   | yours | 12.581, 12.620, 12.632 (med 12.620) | 0.324, 0.324, 0.339      | 257, 252, 254 | 10334191    |

Ratio of medians 0.991 (mixed) and 0.993 (cap). The slots phase moves by the harness amount (-0.11 and -0.14 ms); the tick gain of 0.9% is at the pair-to-pair spread (about 1-2% here), so only the phase number is a claim.

## Verdict
Cell order: reject. Mask plus branch-free blend: small, exact, general (any raster size, map and member count; an empty map still skips the lookup), +72 -44 lines of source (+67 of tests). Mergeable alone or in a bundle; it is the largest cut left in `prepare`, whose floor without any lookup is 0.10 (mixed) and 0.15 (cap).
