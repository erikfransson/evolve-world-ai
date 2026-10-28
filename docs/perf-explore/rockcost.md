# Rock stage of the sense kernel: attribution and one exact cut (idea 115, "rockcost")

Branch `pl-rockcost` from `perf-live` 598dec6. Fingerprints equal: 708687555 (mixed) and 10334191 (cap). Harness: the live world run to tick 300, then kernel variants (wat files) timed alternately on the same state (32 MB sweep and NaN poison of the inputs before each call, `node --no-liftoff`, 1000-1500 reps per variant, p25, `taskset -c 2,3,6,7 nice -n 19`). Brain inputs of every creature hashed per variant. Noise between runs is about 0.03 ms, so differences under 0.05 are not claims.

## Counters (kernel copy, one call at tick 300)

| Count                                                         | Mixed (3200) | Cap (4900) |
|---------------------------------------------------------------|-------------:|-----------:|
| Creatures walking the rock grid (lower bound table passes)    | 348 (10.9%)  | 531 (10.8%) |
| Row runs / cells / discs visited                              | 1533 / 6679 / 7691 | 2349 / 10371 / 12326 |
| Discs kept by the distance test (kept per walker)             | 842 (2.4)    | 1197 (2.3) |
| of them outside the ray wedge widened by the radius           | 335 (40%)    | 772 (65%)  |
| Creatures keeping at least one disc                           | 141          | 232 |
| of them with all kept discs outside the wedge                 | 49           | 106 |
| of them with no item, wall or detail record (rock-only busy)  | 32           | 84 |
| Disc x ray-group evaluations (pass 2 of the ray stage)        | 3812         | 4788 |
| of them passing a per-disc radius prefilter                   | 1363 (36%)   | 1374 (29%) |
| Hit groups / creatures with a disc hit                        | 328 / 83     | 354 / 119 |

So the scout's "154 creatures take the busy path because of a disc" is too high: only 32 (cap 84) have nothing else that forces it.

## Attribution (mixed, p25, ms; kernel 3.76)

Truncated copies of the kernel (inexact, timing only):

| Variant                                              | Kernel | Delta vs base |
|------------------------------------------------------|-------:|--------------:|
| base                                                 | 3.764  |               |
| rock stage off (`rcols` 0)                           | 3.295  | -0.469 (12.5%) |
| lower bound lookup only, walk skipped                | 3.376  | -0.388 |
| walk runs, no disc ever kept                         | 3.589  | -0.175 |
| discs kept, disc ray tests off                       | 3.597  | -0.167 |
| discs kept, pass 2 candidates empty                  | 3.602  | -0.162 |
| discs kept, busy decision ignores them (ray tests off; earlier run, 3.425 vs 3.429) | | 0 |

Reading: lookup 0.08, walk 0.21, keep and busy-path forcing under 0.01, disc ray stage 0.16 (candidate loop about 0.04, group prefilter about 0.07, exact path about 0.04). The cap case: rock off -0.54, ray tests off -0.17 (kernel 4.66).
The ray stage costs about 45 ns per disc x group evaluation whatever the prefilter does: a per-disc radius prefilter (`rtk` from the disc) removed 64% of exact tests and gained nothing (+0.01), and exact path forced off with the prefilter on also gained nothing. The cost is the group loop, so the lever is the number of kept discs.

## Tried

| Variant | Exact | Kernel delta mixed (1500 reps) | Verdict |
|---------|-------|-------------------------------|---------|
| W: wedge test at the keep (`cross(d0,f) >= -m`, `cross(d1,f) <= m`, `m` = radius + 1e-9 L, skipped when the fan is open, as for items) | yes, hash equal | -0.073 / -0.08 / -0.075 | kept |
| Per-disc radius prefilter in the ray stage | yes | +0.01 | dropped |
| Cell-order disc layout (idea in scout-head) | yes | -0.02 earlier, not repeated | dropped |
| Per-100-unit-cell candidate lists for L up to 320 (2.4 MB, no row loop, no order indirection) | yes | -0.05, -0.05 (W alone -0.08, W plus lists -0.07) | dropped, memory and code for less than W |
| Prefetch of the next creature's lower bound entry | yes | +0.08 | dropped |

The walk is not a cold-miss chain: replacing it by one list lookup removed only a quarter of its cost, and prefetching made it slower. It is instruction cost under a shared core.
Finer lower bound (idea 67) stays rejected: it only shrinks the 0.21 walk by the 40% of walkers it skips, 0.07 at best, and the scout measured a code generation loss of the same size.

## The cut (sense.wat, +10 -5 lines)

A rock disc is kept only inside the distance test and the same widened ray wedge the item walk uses (margin = disc radius + 1e-9 L instead of the item radius). A disc outside it cannot be hit by any ray: the wedge lines are shifted by the radius, rays lie between the two outer rays, and `open` (fan of 180 degrees or more, or one ray) keeps every disc. Kept discs keep their order, and non-hitting candidates never change `best`, so results are bit-identical.
Kernel (harness): mixed 3.709 -> 3.634 and 3.764 -> 3.691 (-0.073 to -0.08, 2.0%), cap 4.660 -> 4.551 (-0.11, 2.4%). Brain inputs hash equal (10b91cba mixed, 4cc9bd68 cap).

## Whole tick (liveBench `--profile`, 60 s, 3 alternating pairs, base = `perf-live` worktree)

| Case  | Build | cpuMsPerTick | senser ms | peak RSS MB | fingerprint |
|-------|-------|--------------|-----------|-------------|-------------|
| mixed | base  | 11.266, 10.924, 10.438 (10.924) | 4.071, 3.946, 3.797 (3.946) | 215, 217, 219 | 708687555 |
| mixed | yours | 10.892, 10.684, 10.895 (10.892) | 3.966, 3.882, 3.955 (3.955) | 221, 214, 216 | 708687555 |
| cap   | base  | 12.822, 10.975, 12.310 (12.310) | 4.948, 4.270, 4.772 (4.772) | 253, 254, 257 | 10334191 |
| cap   | yours | 12.736, 12.522, 12.804 (12.736) | 4.857, 4.786, 4.907 (4.857) | 253, 255, 256 | 10334191 |

Ratio of medians 0.997 (mixed), 1.035 (cap). The pair spread (+-0.5 ms) is ten times the 0.08 ms gain, so the tick shows nothing; the claim rests on the harness (same state, 1500 reps, hash equal).
No aged save exists in the scratchpad; not run.

## Tests

`npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000`: 5 files, 102 tests, exit 0. New `wasmKernels` test: rock discs whose tangent lies on an edge ray (a hair either side, 3 fans), bit-equal to the JS rays. With the radius term dropped from the margin it goes red (closeness differs); the 1e-9 L rounding term alone is defensive and not pinned by the test (review round 6). (It also passes on the old kernel: the cut is exact.)

## Verdict suggestion

Exact, small: 2% of the kernel (0.08 ms mixed, 0.11 cap), about 0.7-0.9% of the tick, +10 lines wat, +26 test. Below the 1.5% bar; merge only as a free extra. The rest of the rock stage (0.39 ms) is the lookup (0.08), walk (0.21) and 507 remaining discs x groups; no further exact cut found that pays (lists, prefilter, layout, prefetch all measured).
