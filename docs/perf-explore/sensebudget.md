# Sense kernel budget at the perf-live head (idea 121, "sensebudget")

Branch `pl-sensebudget` from `perf-live` 6f81ad5 (ideas 85, 88, 93, 94, 97, 115, 118 merged). Study plus probes, no engine change committed.
One probe bundle (idea 1 below) is exact, passes the kernel tests and gives senser -5.4% mixed / -6.6% cap in `liveBench`. Its patch is kept outside the repo (`sensebudget-bundle.patch`, +25 -16 in `sense.wat`).

## How measured

- Kernel harness: the live world run to call 300 (also 1000 and 1800), then `sense.wat` variants timed alternately on the same state. 32 MB sweep and NaN poison of the brain inputs before each call, `process.cpuUsage` (user plus system) per call, 150-200 reps, p25, `taskset -c 2,3,6,7 nice -n 19`. Spread between runs is about 0.03 ms, so gaps under 0.05 ms are not claims. Brain inputs of every creature are hashed per variant, equal hash means exact (mixed 10b91cba, cap 4cc9bd68 at call 300).
- Counters: a kernel copy with exported globals, one call at tick 300.
- Stage times: kernel copies cut with `br $jn` after each stage (timing only, inexact), deltas of the cumulative times.
- Instructions and stalls: `node --print-wasm-code --prof --prof-sampling-interval=250 src/liveBench.ts --seconds 30 --copies 800` with module-prefixed names, ticks mapped onto the TurboFan dump (1784 ticks in `sense_sense`).
- `perf stat` is not available (`perf_event_paranoid` 4), so branch mispredictions are not measured, only probed (first rows below).

## Work per creature (counters, tick 300)

| Count                                                        | Mixed (3200) | Cap (4900) |
|--------------------------------------------------------------|-------------:|-----------:|
| Rays                                                         | 9.0          | 8.0        |
| Fan open (180 degrees or more, no wedge cull)                | 24.8%        | 0%         |
| Item rows visited / entries scanned / kept                   | 4.46 / 8.22 / 2.28 | 4.48 / 7.25 / 1.38 |
| Rock walkers / discs visited per walker                      | 10.9% / 22   | 10.8% / 23 |
| Early-out taken (one fill) / early-out walk found a creature | 13.3% / 2.2% | 23.6% / 4.0% |
| Busy path                                                    | 86.7%        | 76.4%      |
| Prefilter groups per creature (item, rock)                   | 11.0, 0.8    | 5.5, 0.35  |
| Groups passing the prefilter / with a hit                    | 1.63 / 0.85  | 1.0 / 0.72 |
| Crowd walk rows / entries / kept, per busy creature          | 4.63 / 1.50 / 0.16 | 4.62 / 1.73 / 0.15 |
| Busy creatures with no crowd candidate (plain emit)          | 85%          | 86%        |

## Budget (kernel p25, call 300)

Mixed 3.603 ms (1126 ns per creature), cap 4.683 ms (956 ns). Instructions are per unit from the TurboFan dump, so a stage is about count times instructions. The kernel runs at about 0.5 ns per instruction on the shared pinned cores, so instruction count is the model that fits.

| Stage                                           | Mixed ms | Share | Cap ms | Share | Instructions per unit |
|-------------------------------------------------|---------:|------:|-------:|------:|-----------------------|
| Record, walls, wedge directions                 | 0.062    | 1.7%  | 0.095  | 2.0%  |                       |
| Item cell walk                                  | 1.127    | 31.3% | 1.535  | 32.8% | row 29, entry 38, window set-up about 65 (four `trunc_sat` at five instructions plus two branches) |
| Rock lookup and walk                            | 0.248    | 6.9%  | 0.347  | 7.4%  | see `rockcost.md`     |
| f32 crowd window, early-out walk, zero fill     | 0.323    | 9.0%  | 0.608  | 13.0% | window about 50, row about 22, entry about 38 |
| Ray directions                                  | 0.097    | 2.7%  | 0.103  | 2.2%  | about 18 per ray pair |
| Wall pass (init when no wall)                   | 0.072    | 2.0%  | 0.115  | 2.5%  | about 9 per ray pair  |
| Candidate ray tests (items and rock)            | 0.784    | 21.8% | 0.762  | 16.3% | group 27, hit path 69, candidate head 12 |
| Crowd walk (busy path)                          | 0.331    | 9.2%  | 0.451  | 9.6%  | row about 22, entry about 45 |
| Emit, plain path                                | 0.307    | 8.5%  | 0.379  | 8.1%  | about 38 per ray      |
| Crowd path rest (closeness, crowd rays, merge)  | 0.252    | 7.0%  | 0.288  | 6.2%  | about 60 per ray merge |

Where the 1784 `--prof` ticks sit: the first item xy load after each row (+6b1) 8.1%, the `itemStart` loads 4.3%, the crowd `cStart` loads 3.5%, the first store to the brain input line in the emit 2.2%, the prefilter group loop and its branches about 16%. All are retirement waits behind a load or a mispredicted branch, and none moved when the loads were issued earlier (first table below).
The zero fill of the early-out costs nothing measurable (the variant that skips it is equal, 3.661 against 3.668).

## Ideas, ranked

### 1. Address and branch tidy bundle in `sense.wat` (exact, measured)

Five small edits, none worth 1.5% alone, together 5% of the kernel. V8 does no induction-variable reduction and this function is spill-bound, so recomputed indices cost real instructions.

- Odd last ray lane padded with NaN in the direction scratch (dx and dy at index nR when nR is odd). The prefilter then needs no `g*2+1 == nR` test, and the group loop steps two pointers against an end pointer instead of rebuilding them from `g`. The NaN lane never passes either prefilter (`NaN <= x` is false, also against the rock pass infinity).
- The item row loop steps two row pointers (`itemStart` at the first column and past the last) by the row stride instead of `imul` and shifts per row.
- `$dirsPairs` also stores best = L and kind = 0 when no wall is in range, so the separate `$initPairs` pass is gone from that path.
- `$emit` has a stride-6 loop without the per-ray stride test (the generic loop stays for other strides).
- Item candidates store fx, fy and the index. The exact path computes d2 - r2 itself (same operations, so the same bits). Rock discs keep their stored value.

Kernel p25 in ms, mixed / cap, stacked on the first row (call 300, same state):

| Variant                              | Mixed        | Cap          |
|--------------------------------------|-------------:|-------------:|
| base                                 | 3.632        | 4.682        |
| group loop (NaN lane, pointers)      | -0.071       | -0.083       |
| + item row pointers                  | -0.143       | -0.167       |
| + fused directions and init, stride-6 emit | -0.168 | -0.193       |
| + lazy d2 - r2                       | -0.205       | -0.244       |

Hash equal at calls 300, 1000 and 1800, both cases. Gains at the other calls were -0.06 to -0.11 mixed and -0.11 cap (load spikes at call 1000).

`liveBench --profile --seconds 60` on the 4-founder case, base = `perf-live` worktree, three alternating pairs, taskset 2,3,6,7 nice 19 (load 10-18):

| Case  | Build | cpuMsPerTick                      | senser ms                    | brain forward ms          | peak RSS MB   | fingerprint |
|-------|-------|-----------------------------------|------------------------------|---------------------------|---------------|-------------|
| mixed | base  | 11.228, 10.873, 11.250 (11.228)   | 4.089, 3.950, 4.079 (4.079)  | 4.250, 4.162, 4.298       | 218, 217, 217 | 708687555   |
| mixed | new   | 10.901, 10.489, 10.963 (10.901)   | 3.866, 3.712, 3.860 (3.860)  | 4.195, 4.055, 4.260       | 217, 219, 216 | 708687555   |
| cap   | base  | 13.264, 13.195, 13.449 (13.264)   | 5.044, 5.011, 5.114 (5.044)  | 4.290, 4.292, 4.367       | 253, 255, 253 | 10334191    |
| cap   | new   | 12.702, 12.534, 13.378 (12.702)   | 4.713, 4.693, 4.963 (4.713)  | 4.175, 4.118, 4.412       | 253, 255, 258 | 10334191    |

Ratio of medians (new / base): senser 0.946 mixed and 0.934 cap, faster in 6 of 6 pairs. Tick 0.971 and 0.958, but the brain forward phase also moves by 1-3% between sides, so the safe claim is the senser delta, 0.22 ms mixed and 0.33 ms cap, which is 2.1% and 2.7% of the quiet-machine tick (10.4 and 12.0 ms).
Tests with the patch applied: `npx vitest run wasm sense resident thinkEvery --maxWorkers=2 --testTimeout=180000`, 6 files, 113 tests, exit 0 (the kernel against the JS rays bit for bit, odd and even ray counts, several strides).
General: the NaN lane exists only for odd nR (at most index 63 of the 64-ray scratch), pointers cover any row and group count, the stride-6 loop is a branch in front of the old one.

### 2. Vector window set-up (exact, small)

The item window (f64) and the crowd window (f32) are eight scalar floor, `trunc_sat`, clamp chains of about 16 instructions each. Two `f64x2` and one `f32x4` chain with `i32x4.trunc_sat_*`, `i32x4.max_s`/`min_s` against per-call clamp vectors and four `extract_lane` do the same in about a third of the instructions. The upper clamp must stay separate from the lower one (a negative last column has to stay negative so the window is empty).
Stacked on idea 1: mixed -0.067 / -0.007 and cap -0.051 / +0.007 in two runs, call 1800 -0.024 mixed and -0.063 cap, hash equal. Between 0 and 0.6% of the tick, not separated from the noise. Take it only with idea 1 and keep it if a paired run shows it (probe `sensebudget-w1.wat`).

### 3. Wedge bounding box for the item walk (exact, measured, not worth it as probed)

The window is the box of the full circle, but the rays only cover the fan. A box of the widened wedge (corners, axis extremes inside the fan, padded by the apex offset m / sin(half fan) and the f32 rounding of positions) cuts rows and entries without changing a kept candidate.

| Mean per creature                   | Mixed now | Mixed box | Cap now | Cap box |
|-------------------------------------|----------:|----------:|--------:|--------:|
| Item rows                           | 4.47      | 3.53-3.63 | 4.47    | 3.02-3.17 |
| Item entries scanned (kept equal)   | 6.90      | 4.71-4.91 | 5.60    | 2.89-3.13 |
| Crowd rows                          | 4.63      | 3.71-3.96 | 4.63    | 3.21-3.59 |

Fans: mixed 24% open, the rest 60-150 degrees. Cap all 60-120. Counts averaged over eight ticks (300-1000), so they differ a little from the tick-300 table above.

| Variant (kernel p25 change, mixed / cap)                                  | Mixed  | Cap    |
|---------------------------------------------------------------------------|-------:|-------:|
| Box read from a table filled in JS (free box), items only                 | -0.107 | -0.336 |
| Same, items and crowd                                                     | -0.080 | -0.300 |
| Box computed in the kernel, `f64x2` code, in the creature loop            | +0.030 | -0.040 |
| Box computed in a pre-pass over the records                               | +0.090 | +0.010 |

The upper bound is 1.0% (mixed) and 2.8% (cap) of the tick, but the 50-60 instructions and one division of the box, on the critical path before the item loop, cost as much as they save. Net is about zero. A cheaper box (quadrant cuts with a pad from the plan's smallest fan) might keep 0.5% mixed and 1.5% cap, not enough to build. The crowd window gains nothing from the box.

## Tried, no gain (kernel p25 change, mixed / cap)

| Variant                                                            | Mixed        | Cap          |
|--------------------------------------------------------------------|-------------:|-------------:|
| Item row bounds for all rows loaded first                          | +0.002       |              |
| Same plus a touch load of each row's first xy                      | +0.020       |              |
| Same plus the crowd row bounds and touches                         | +0.11, +0.14 |              |
| First item entry of each row without the emptiness branch          | -0.023       | -0.054       |
| First two entries branch-free                                      | -0.002       | +0.011       |
| Crowd row loops with stepped pointers                              | +0.012       | +0.033       |
| `$dirsPairs` with stepped pointers                                 | +0.005       | -0.018       |
| Candidate group loop as a function                                 | +0.163       | +0.203       |
| Group loop two groups per step with one `any_true`                 | +0.047       | +0.097       |

Reading: the stalls the profile shows are not recoverable by issuing the loads earlier or by removing the row-emptiness branch (the prefetch result of `sensepf.md` holds inside a creature too), and loops that V8 already keeps in registers gain nothing from pointer stepping.
Not proposed again: occupancy gates, rock lists and finer lower bounds, per-cell gathers, array-of-structs records, four-wide gathers, native ports (`occgate.md`, `rockfine.md`, `cellgather.md`, `aos.md`, `gather4.md`, `nsense.md`).

## Verdict suggestion

Build idea 1 (merge as one exact cleanup, +25 -16 lines of wat), take idea 2 only if its paired run is visible, drop idea 3. The earlier note that the kernel had no exact cut left was too pessimistic. Whole-tick pairs hid effects of 0.05-0.1 ms, the kernel harness resolves them, so small address-arithmetic cuts in the item and candidate loops are worth checking there before they are called flat.
