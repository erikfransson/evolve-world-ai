# Kernel budget of step, crowd, fill, members and touch, and the exact tidy bundle (idea 128, "stepbudget")

Branch `pl-stepbudget` from `perf-live` 4742880. Exact (fingerprints 708687555 mixed and 10334191 cap equal in all 12 runs). Bundle: tick 0.987x mixed, 0.977x cap (6 alternating pairs each), +118 -90 lines over four `.wat` files, no memory change.

## How measured

- Kernel harness (as `sensebudget.md`, now for any export): the live world run to the 300th call of one kernel, then `.wat` variants timed alternately on the same restored 46 MB of kernel memory. Memory restored and a 32 MB sweep before every call, `process.cpuUsage` per call, 80 reps (200 for step), p25, `taskset -c 2,3,6,7 nice -n 19`. Two copies of base give the noise: 0.005 to 0.01 ms, up to 0.03 on a loaded cap run. After the first call the whole memory of each variant is compared with base (hash), so equal hash means every output byte equal.
- Stage times: kernel copies cut with a `br` or `return` after each stage (timing only, results then wrong), cumulative p25.
- Cold harness times are 10-30% above the live phase times, shares are what counts. Instruction counts are not given per stage: the kernels run at about 1 instruction per ns on the pinned cores (the item loop of touch is 15 TurboFan instructions per item), and a one-pass parse of `--print-wasm-code` could not tell the hot loops from V8's unrolled copies for most functions.
- Counts at call 300 (step): creatures that call `keepOut` 62 of 3200 (mixed) and 101 of 4900 (cap), 3.6 grid rows and 24 discs each, 4 and 8 of them pushed.

## Budget (kernel p25 ms, base; mixed 3200 / cap 4900)

| Kernel                   | Mixed | Cap   | Stages (cumulative cut, mixed then cap)                                                          |
|--------------------------|------:|------:|---------------------------------------------------------------------------------------------------|
| step                     | 0.99  | 1.29  | loop skeleton 0.06, row/output/units first touch and unit loop +0.33 / +0.29, thrust and turn +0.01 / +0.03, **sin and cos +0.29 / +0.47**, velocity +0.04, position +0.03, walls +0.03, **rock early-out and keepOut +0.17 / +0.21**, energy +0.04 / +0.10 |
| rock part of step        |       |       | early-out check 0.148 / 0.236 (raster byte only 0.036 / 0.046), `keepOut` calls 0.082 / 0.073 |
| crowd `rebuild`          | 0.41  | 0.60  | keys 0.10 / 0.14, identity 0.006, radix pass 1 +0.042 / +0.065, pass 2 +0.035 / +0.047, gather +0.078 / +0.146, **gap fill +0.144** / +0.18 |
| crowd `refresh`          | 0.23  | 0.35  | one loop of 47 instructions per creature                                                          |
| crowd `pack`             | 0.27  | 0.42  | `Math.exp` import 0.10 / 0.145, the rest 0.18 / 0.26                                              |
| touch                    | 0.46  | 0.62  | skeleton 0.06 / 0.09, f64 window +0.056 / +0.10, range test and truncs +0.043 / +0.07, row loop with the start loads +0.145 / +0.19, items +0.17 / +0.21 |
| fill `prepare`           | 0.33  | 0.49  | ground lookup 0.24 / 0.36, rest 0.10 / 0.15                                                       |
| fill `fill`              | 0.36  | 0.49  | place loops 0.044 / 0.059, record copy and input addresses +0.157 / +0.25, extras narrow +0.02 / +0.03, units narrow +0.14 / +0.15 |
| members `settle`, `birthCandidates` | 0.07, 0.02 | | one load chain per member, memory bound; nothing to cut                                   |

Reading: IPC is about 1, so instruction count converts to time directly where the data is in cache (touch window, early-out, record copy), and not where a cache line is first touched (units, rows, rebuild gather, gap fill 626 KB table, prepare raster). First-touch cost moves to whichever kernel reads the rows first.

## Built (one bundle, harness p25 ms, mixed / cap, hash equal)

| Change                                                                                                     | Base          | New           | Delta            |
|------------------------------------------------------------------------------------------------------------|---------------|---------------|------------------|
| touch: `firstItem` inlined into the loop, invariants in locals, window as two f64x2 chains over (x, y) (`pmax`/`pmin` = the JS compares, NaN stays empty), `trunc_sat_f64x2_zero`, row and item pointers stepped | 0.459 / 0.618 | 0.351 / 0.468 | -0.108 / -0.150 |
| fill: record copied as two f64x2 and one v128 of rays, offsets, input and slot (detail swapped into lane 3), bases in locals, `memory.fill` for the zero pass | 0.362 / 0.474 | 0.333 / 0.433 | -0.029 / -0.041 |
| step: clear-of-rock early-out on one f64x2 (`all_true(ge 0)`, `trunc_sat_f64x2_zero`, `shr_u`), call-block fields in locals | 1.027 / 1.318 | 0.998 / 1.259 | -0.029 / -0.059 |
| refresh: array bases in locals, x and y by `store64_lane`                                                  | 0.231 / 0.334 | 0.218 / 0.319 | -0.013 / -0.015 |
| pack: array bases in locals                                                                                | 0.263 / 0.406 | 0.255 / 0.393 | -0.008 / -0.013 |
| Sum                                                                                                        |               |               | -0.187 / -0.278 |

Layout pins added to the layout test (row `cos`/`sin`, and `rays`..`slot`, adjacent). `fill.wat` relies on them like `crowd.wat` does on `R_Y = R_X + 8`.

## Tried, no gain (harness p25 change, mixed / cap)

| Variant                                                                                        | Result                  |
|------------------------------------------------------------------------------------------------|-------------------------|
| step unit loop split in a short-rate and a long-rate loop, pointers stepped                    | +0.00 / +0.01           |
| step position and velocity kept in locals through the wall clamps, stored once                 | -0.003 / -0.003         |
| step `max(0, thrust)` once                                                                     | +0.01 / +0.02           |
| step call-block hoists alone                                                                   | -0.01 / -0.02           |
| `keepOut` cell range as f64x2, row pointers stepped (only 2% of creatures call it)             | -0.00 / -0.01           |
| prepare: node position and fractions as f64x2, fields in locals                                | -0.002 / -0.005         |
| prepare: quiet-block bytes (8 x 8 nodes, 1 KB; idea 123 #1), exact                              | -0.012 / +0.007         |
| touch in batches of 16, 8 and 4: windows and first row loads of the batch first, walk second    | +0.07 / +0.08 (worse)   |
| rebuild: nothing built; the gap fill is the 626 KB table write (memory bound, see `rebuildparts.md`), keys and gather wait on first-touch rows | - |

The batched touch tests whether the start-table misses serialise behind data-dependent branches: they do not, the loop is instruction bound once the window is cheap (after the bundle: skeleton 0.046, window and test +0.010, row loop +0.16, items +0.145).

## Whole tick (liveBench `--profile --seconds 60`, taskset 2,3,6,7 nice 19, 6 alternating pairs per case, base = `perf-live` worktree, load 8-15)

| Case  | Build | cpuMsPerTick                                       | eat   | memory and steer | senser | crowd grid | peak RSS MB | fingerprint |
|-------|-------|----------------------------------------------------|-------|------------------|--------|------------|-------------|-------------|
| mixed | base  | 11.319 11.507 10.425 11.092 11.250 10.893 (11.171) | 0.941 | 1.023            | 4.092  | 0.160      | 215-220     | 708687555   |
| mixed | new   | 11.420 11.482 8.779 10.910 10.652 11.130 (11.020)  | 0.835 | 0.994            | 4.074  | 0.155      | 216-219     | 708687555   |
| cap   | base  | 13.694 13.370 12.753 13.400 13.088 12.820 (13.229) | 1.244 | 1.244            | 5.069  | 0.349      | 254-257     | 10334191    |
| cap   | new   | 13.446 11.683 12.199 13.148 12.764 13.080 (12.922) | 1.095 | 1.186            | 5.008  | 0.335      | 253-257     | 10334191    |

Ratio of medians (new / base) 0.9865 mixed, 0.977 cap. Pair 3 of the mixed case ran on a quiet machine on the new side (8.78) and pair 2 of the cap case on a quiet one too, so the tick ratio is rough. The phases the bundle touches agree with the harness: eat -0.106 / -0.149 (touch), memory and steer -0.029 / -0.058 (step), senser -0.018 / -0.061 (fill and pack), crowd grid -0.005 / -0.014 (refresh): together -0.16 ms (1.4% of the tick) mixed and -0.29 ms (2.2%) cap. The second set of three pairs (steadier machine, mixed 0.984) is the cleaner one for the mixed case.

## Tests

`npx vitest run wasm step crowd fill resident --maxWorkers=2 --testTimeout=180000`: 6 files, 106 tests, exit 0. The touch kernel is compared with `World.touchedBatch` on 16 random worlds with creatures at NaN, infinite, negative and off-world positions, and at exactly the reach; the fill records go through `wasmKernels` and `residentBodies`. Full suite (`npx vitest run --maxWorkers=2 --testTimeout=180000`, load 30+): 121 of 122 files pass, 1249 of 1257 tests, exit 1; the 8 failures are all the 20 s timeouts of the `cli.test.ts` process-spawn tests (rerun alone: same 8, `node src/bench.ts --pop 0` takes 3 s on its own), none touches the kernels.

## Verdict suggestion

Merge the bundle: exact, 1.4% (mixed, borderline) to 2.2% (cap) of the tick, no RSS change, no new data structure. Touch gives 70% of it. What is left in these kernels is first-touch misses (rows, units, raster, the 626 KB `cellStart` write) and the fdlibm sin/cos (0.29 / 0.47 ms, 29% / 36% of step) which earlier rewrites and a two-creature f64x2 port estimate (branch-free selects for the three `kcos` tails and the quadrant, scalar fallback for any unusual lane) would only trim by a third at best, and the step loop hides part of it behind those misses (`stepparts.md`: splitting it out costs more). Not tried: that two-lane sincos.
