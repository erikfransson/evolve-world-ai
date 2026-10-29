# Idea 106: parts of the crowd grid rebuild, refresh and sweep, and the exact cuts that pay

Branch `pl-rebuildparts` from `perf-live` e561432. Exact (fingerprints 708687555 and 10334191 equal), about 1.3% of the tick at 3300 and 1.5% at the cap from the two phases that hold the grid.

## Parts of one `rebuild` call (3300 creatures, 156k cells, in the live tick)

Truncated copies of the kernel (`stage` global, early return), one variant per tick in rotation, run right before the real rebuild so the caches are as in the tick. 197 samples per variant, medians of wall microseconds, machine load about 12 on 4 shared cores at 1.4 GHz, so only the shares count.

| Part                                              | us (median) | Share |
|---------------------------------------------------|------------:|------:|
| cell keys (row loads, 2 divides, clamps, key)     | 97          | 19%   |
| identity permutation                              | 4           | 1%    |
| radix pass 1: histogram / prefix / scatter        | 16 / 2 / 28 | 9%    |
| radix pass 2: histogram / prefix / scatter        | 15 / 1 / 21 | 7%    |
| gather into x, y, energy, species, owners, occupied | 81        | 16%   |
| `cellStart` gap fill (156k entries, 626 KB)       | 239         | 47%   |
| sum of the stages                                 | 505         |       |
| the real call (2167 samples)                      | 448 (mean 474) |    |

The prefix sums are over the 512 radix counters, not over the cells (two passes of 9 bits for 18 key bits): the 156k-cell table is only written by the gap fill. Reference points inside the tick, the fill alone costs 215 us more than the same kernel without it, and a plain `memory.fill` of the table costs 62 us (kernel without fill 284, with `memory.fill` 346, so the table is not bandwidth bound: the gap loops cost the rest, three thousand gaps of about 47 cells each with a mispredicted loop exit per gap and a scalar remainder loop).

## Why 1.2 calls per tick

2167 rebuilds in 1800 ticks (60 s run, 4 founders x 800): 1800 in the shared phase plus 367 at the tick start. Of the tick starts 1451 had an unchanged member table (no birth or death since the shared-phase grid); 1433 of those refreshed and 18 (1%) failed on a creature that changed cell. The other 349 (19%) had a birth or a death, which renumbers members, so the order cannot be reused. A births-only tick could append, but `gridpatch.md` measured that patching all of them is worth 0.02 ms, so the condition is left as it is. `refresh` takes 123 us a call here.

## Variants measured (paired in the tick: reference and candidate on the same rows, both outputs compared array for array)

Cold first runs, medians, reference / candidate in us. The `v0` copy of the kernel (same algorithm, flags tested at run time) is 27 us slower than the reference by itself, so read the last column against it.

| Variant                                              | reference | candidate | candidate - reference |
|------------------------------------------------------|----------:|----------:|----------------------:|
| v0 copy, nothing changed                             | 487       | 514       | +27                   |
| gap fill as its own pass over the occupied list      | 488       | 487       | -1 (-28 vs v0)        |
| fill stores 4 cells at a time, may overshoot by 3    | 492       | 477       | -15 (-42 vs v0)       |
| both (built)                                         | 490, 471, 455, 469, 493 | 438, 411, 407, 413, 429 | -52, -60, -48, -55, -64 |
| both + keys of x and y in one f64x2 (built)          | 468       | 399       | -69                   |
| keys in f64x2 alone                                  | 463       | 473       | +11 (-14 vs v0)       |
| fill unrolled 2 and 4 stores per iteration          | 417, 448  | 363, 391  | -53, -57 (same as 1x) |
| both histograms counted in the key loop, no identity | 491       | 511       | +20 (-5 vs v0): no gain |

`refresh` with the same f64x2 keys: 108.7 to 93.5 us (112.4 to 94.5, 109.8 to 95.0 in other runs), -14%. A warm second call of the old refresh is 100 us, so refresh is compute bound (the loop is about 40 cycles a creature), not miss bound.

What the cuts are: the fill becomes a second pass over the occupied cells (the first slot of each is kept in the sort's free buffer), each gap is one loop of v128 stores that may run up to three cells past its end (the next gap or the tail rewrites them, the table got 12 bytes more room), so the scalar remainder loops and one mispredicted exit per gap are gone. The keys use `f64x2.pmin` and `pmax`, which are the JS compares `cx < 0 ? 0 : cx` and `cx > max ? max : cx` (NaN stays NaN and becomes 0 in the key, infinities clamp); x and y are adjacent in a row (a test pins `R_Y = R_X + 8`).

## Sweep (`collideAll`)

Per sweep: 176-185 us with the bumps and a cold start, 105 us when run again on the same state without bumps, 3.7 pairs and 4.6 kernel calls a sweep, so about 35 ns (50 cycles) per occupied cell, mispredict bound. Ablations of a copy, warm, us: no divide 114 / 131 (noise, copy overhead), no loads of the row below -24, skipping cells with no pair candidates (exact) -5. A rewrite on the compact occupied list (first slot per occupied cell, two monotone pointers for the row below, no `cellStart` reads) is exact (pair sequence hash equal) but slower: 240 us against 169 cold, 199 against 111 warm, because each pointer step is another data dependent loop exit. Nothing built for the sweep.

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, load 11-13)

| Case  | Build | cpuMsPerTick                  | crowd grid ms         | eat ms (holds the shared-phase grid) | collisions ms | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------|-----------------------|--------------------------------------|---------------|---------------|-------------|
| mixed | base  | 11.030, 11.173, 11.025 (11.030) | 0.163, 0.171, 0.170 | 0.989, 1.025, 1.000                  | 0.184, 0.181, 0.182 | 216, 219, 217 | 708687555 |
| mixed | yours | 10.970, 10.856, 10.945 (10.945) | 0.149, 0.140, 0.138 | 0.900, 0.873, 0.892                  | 0.181, 0.176, 0.176 | 216, 218, 218 | 708687555 |
| cap   | base  | 13.394, 13.198, 13.209 (13.209) | 0.380, 0.365, 0.380 | 1.358, 1.309, 1.330                  | 0.274, 0.275, 0.277 | 254, 260, 252 | 10334191  |
| cap   | yours | 13.450, 13.053, 12.987 (13.053) | 0.326, 0.293, 0.304 | 1.241, 1.161, 1.180                  | 0.282, 0.275, 0.271 | 254, 255, 254 | 10334191  |

Ratio of medians 0.992 (mixed) and 0.988 (cap). The two grid phases drop 0.14 ms (1.3%) at 3300 and 0.21 ms (1.5%) at the cap; the cpu medians move less than that because pair 1 of the cap case is noisy. Collisions unchanged, as expected.

## Tests

`vitest run wasm crowd sense ecosystem resident --maxWorkers=2 --testTimeout=180000`: 7 files, 150 passed, exit 0 (before the layout test); `wasmCrowd` alone with it: 30 passed, exit 0. The existing `wasmCrowd` cases already compare every array against `Crowd.rebuildFrom` with creatures at NaN, infinite and far out positions, and the in-bench mismatch counter of the paired runs above was 0 over about 1000 calls per run.

## Verdict

Merge: exact, 1.3-1.5% of the tick from the grid phases, no RSS change, kernel text 77 lines touched (42 added, 44 removed), one test line. The sweep and the sort are at their floor for this layout (mispredict and compute bound). Not built: patching the grid table for movers only (`gridmove.md` lost on the extra passes it needs).
