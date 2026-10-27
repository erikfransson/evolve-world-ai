# Sense kernel at the live setting: cost per part, counts, candidate cuts

Question: where do the ~5.7 ms of the `senser` phase go at 3300 creatures on The Inland Sea? Measurement only, no production change. Scratch copies of `sense.wat` (parts cut out, one variant per stage, counters in exported globals) run over a memory snapshot taken from the real LiveWorld (`liveConfig`, 4 founders x 800 copies, snapshot at the call of tick 400 and tick 1500). Scripts: scratchpad `sp/` (`snap.ts`, `lib.ts`, `time.ts`, `count.ts`, `geo.ts`, `intern.ts`, `var1.ts`).

Method: one `sense` call timed with `process.cpuUsage`, variants interleaved in rotating order, 150-250 reps, `node --no-liftoff`, nice 19. Load was 9-18 on 8 cores (4 physical), so only the p25 of a run and same-run ratios mean anything. "Cold" evicts the caches before every call with a 32 MB sweep (the 24 MB brain forward does that in the server); it is the proxy for the server (kernel 5.4 ms here against 5.74 ms for the whole `senser` phase in liveBench). "Hot" repeats the call on warm caches. Stage rows are cumulative (kernel truncated after the stage, delta to the previous stage). Two cold runs agree within 0.02 ms per row, a loaded run moved everything by up to 40%.

## Cost per part (p25, ms per call)

| Part                                         | Cold t400 | ns/creature | Share | Cold t1500 | Hot t400 |
|----------------------------------------------|----------:|------------:|------:|-----------:|---------:|
| Record load, wall flags                      | 0.05      | 16          | 1%    | 0.05       | 0.03     |
| Ray directions (cos/sin offset tables)       | 0.62      | 186         | 11%   | 0.61       | 0.28     |
| Item cell walk and candidate gather          | 1.23      | 369         | 23%   | 0.98       | 0.87     |
| Rock walk                                    | 0.54      | 162         | 10%   | 0.54       | 0.32     |
| Wall loop (active for 1.8% of creatures)     | 0.19      | 57          | 4%    | 0.19       | 0.15     |
| Item and rock ray tests (prefilter + exact)  | 0.83      | 249         | 15%   | 0.65       | 0.71     |
| Closeness pass                               | 0.30      | 90          | 6%    | 0.29       | 0.37     |
| Crowd gather                                 | 0.58      | 174         | 11%   | 0.54       | 0.29     |
| Crowd ray tests                              | 0.13      | 39          | 2%    | 0.14       | 0.16     |
| Crowd merge and feature writes               | 0.93      | 279         | 17%   | 0.84       | 0.43     |
| Whole kernel                                 | 5.40      | 1620        | 100%  | 4.82       | 3.59     |

Cross-check by switching a part off in the parameter block (cold, t400, whole kernel 5.40): no rock 4.61 (-0.79), no crowd walk 4.88 (-0.52), no item walk 3.29 (-2.11, walk plus its tests), none of the three walks 2.08 (-3.32).

Reading: flat again. Item walk plus its tests 38%, crowd 14%, rock 10%, the four per-ray passes (directions, wall, closeness, features) 38% together. Cold costs 1.5x the hot costs; the cold excess sits in directions (+0.34), features (+0.5), item walk, crowd gather.

## Work per creature (counters in the kernel copy, 3331 and 3294 creatures)

| Count per creature                       | t400 (67k food) | t1500 (45k food) |
|------------------------------------------|----------------:|-----------------:|
| Rays                                     | 8.99            | 9.01             |
| Item grid rows visited / cells           | 4.46 / 19.9     | 4.48 / 20.0      |
| Items scanned / kept (distance + wedge)  | 7.68 / 2.19     | 4.83 / 1.43      |
| Creatures with no item candidate         | 18.6%           | 39.3%            |
| Rock rows / cells                        | 4.37 / 19.1     | 4.36 / 19.0      |
| Rock discs scanned / kept                | 3.34 / 0.24     | 3.09 / 0.21      |
| Creatures with no rock candidate         | 95.5%           | 95.4%            |
| Crowd rows / cells                       | 4.63 / 21.4     | 4.63 / 21.4      |
| Crowd entries scanned / kept             | 1.50 / 0.12     | 1.47 / 0.14      |
| Creatures with no crowd candidate        | 89.0%           | 87.8%            |
| Exact ray-candidate tests (items + rock) | 3.01            | 2.48             |
| Creatures with no candidate of any kind  | 15.3%           | 32.2%            |

Setup: item and crowd cell 100 (500 x 313 cells), ray length about 170, so the cell box is 4.5 x 4.5; rock cell 300 (167 x 105, 5197 discs, `rockMaxR` 339 makes the rock box as wide as the item box). Ray counts: 8 rays for 75%, 12 for 25% (stride 6, one species flag). 76% of creatures have a fan under 180 degrees (mean fan 129 degrees). Only 0.7-0.9% of creatures share an item box with another creature, 1.01 creatures per occupied cell. The item grid has about 0.44 items per cell, so scanned items are 1.7 per row: the walk is row and branch bound, not item bound.

## Candidate cuts, ranked (all prototyped in scratch copies, not implemented; inputs of all creatures hashed equal to the full kernel unless noted)

Gains are cold p25 deltas of the whole kernel, tick 400 / tick 1500, in ms and as share of the 15.2 ms tick.

| # | Cut                                                          | Exact? | Gain t400 / t1500 | Tick share | Notes |
|---|--------------------------------------------------------------|--------|-------------------|-----------:|-------|
| 1 | Share identical ray-offset tables between creatures (intern by content in `setOffsets`) | yes (hash equal) | -0.45 / -0.29 ms (8% / 6%) | 2-3% | 273 distinct tables among 3331 creatures (390 at t1500). Directions stage 0.67 -> 0.23 ms: the cold miss on 144 bytes of private table per creature disappears. Needs a content-keyed pool in senser.ts with a size cap against mutation churn; JS work only when a creature attaches. |
| 2 | Rock lower-bound table: per rock cell, the least distance to any disc edge (static per terrain, 167 x 105 f32 = 70 KB); skip the rock walk when it exceeds L (1 + 1e-7) + 1 | yes (hash equal) | -0.23 / -0.22 ms (4%) | 1.5% | 95% of creatures have no rock candidate. Memory +70 KB, built once per world. A coarser empty-cell flag would not help because the box is rock-max-radius wide. |
| 3 | Branch-free species flag and seen-energy writes in the feature pass (flag = kind 4 and species[k] == 0, loop and `stride > 4` branch gone for stride 6) | yes by construction | up to -0.21 (flag loop removed) to -0.27 (whole species block removed) ms, so about -0.15 realistic | 1% | Bound measured with the code removed (not exact), hash not comparable. Stride 6 means a single flag, so the loop is one iteration plus its setup. |

Smaller exact ones not measured as prototypes, from the stage table: skip the wall loop when no wall is near and set `best`/`kind` in the direction loop (wall loop 0.19 ms, so about -0.1), and fuse closeness into the feature pass (0.3 ms stage, earlier campaign found about 5% of the kernel at best).

## Rejected by measurement

| Idea | Count effect | Time effect (cold p25, whole kernel) |
|------|--------------|--------------------------------------|
| Bounding box of the fan wedge for the item walk (exact: candidates outside it fail the wedge test) | cells 19.9 -> 12.7, rows 4.46 -> 3.53, scanned 7.68 -> 5.27, kept identical (0 mismatches) | +0.08 / +0.12 ms, slower |
| Same box for the crowd walk (f32) on top | | +0.35 / +0.43 ms, slower (more live locals in a function that is already register bound, f32 min/max) |
| Shared gather for creatures in one cell or box | 0.7-0.9% share a box, 1.01 creatures per occupied cell | not built, nothing to share |
| Early-out for the "no candidate" creatures (15-32%) | the empty pass loops are already near free | not built, bound is the two empty pass loops and 3 crowd group iterations |

So fewer cells, rows and scanned items do not make the walk faster, as in kernelprof.md: the walk cost is loop entry, branch mispredicts and cache misses per row, not items. What does pay is removing cold memory (cut 1) and whole stages that are almost always empty (cut 2).

## Verdict suggestion

Cuts 1 and 2 are exact, small and independent: together about -0.65 ms of the kernel (12%), about 4% of the 15.2 ms tick, worth a branch each. Cut 3 is about 1%. None of the walk geometry ideas pays; the item walk (1.2 ms cold, 23%) has no cheap exact cut left.
