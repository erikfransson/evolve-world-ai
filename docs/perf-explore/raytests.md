# Sense kernel: cost per stage and three exact cuts in the ray tests and emit (idea 88, "raytests")

Branch `pl-scout-ray` from `perf-live` 531a215. Study (scout) plus three exact cuts in `sense.wat`, fingerprints equal. `$emit` and `$emitClo` also zero the species flags and energy of strides other than 6 with an `i32` store loop instead of a per-ray `memory.fill` (not hit live, where the stride is 6).

## Call structure

`WasmSenser.run` is one call per tick, and `sense.wat` loops over all creatures inside that call: there is no per-creature JS or wasm call overhead.
`kernelTimers.ts --copies 800 --ticks 400` (load 12): `WasmSenser.run` 5.49 ms = kernel `sense` 4.32 + `fill` 0.47 + `syncItems` 0.35 (of it `patchCell` about 0.16, 58 dirty cells a tick) + crowd `pack` 0.26 + JS in `run` about 0.09.

`perf` is installed but `perf_event_paranoid` is 4 (no unprivileged events), so no cycle or miss counters. Attribution is by truncated and probe kernels instead.

## Work per creature (counters in a kernel copy, snapshots of the live world at tick 400 / 1500, 3331 / 3294 creatures)

| Count                                           | t400  | t1500 |
|-------------------------------------------------|------:|------:|
| Early-out (nothing in sight, one fill)          | 14.9% | 31.5% |
| No crowd candidate, `$emit` after crowd gather  | 74.2% | 56.3% |
| Crowd candidate (full path), of it unseen       | 11.0%, 5.1% | 12.2%, 5.6% |
| Rays (8 for 75%, 12 for 25%)                    | 9.0   | 9.0   |
| Item rows / items scanned / kept                | 4.46 / 7.68 / 2.19 | 4.48 / 4.83 / 1.43 |
| Prefilter groups (candidate x ray pair)         | 11.7  | 7.9   |
| Exact ray tests / hits                          | 3.01 / 0.87 | 2.48 / 0.61 |
| Crowd rows (busy path)                          | 3.9   | 3.2   |

## Cost per stage (share of the whole kernel, cold p25, interleaved, 2 runs per tick, load 15-30)

Kernel truncated after each stage (cumulative), deltas listed. Probes: `hotxy` reads the item positions from a 2 KB block (same instructions, no misses), `rowshot` the same for the row starts, `noinp` writes the brain inputs to scratch instead of the brain bank.

| Stage                                              | t400  | t1500 |
|----------------------------------------------------|------:|------:|
| Creature loop, record, walls, wedge directions     | 2.0%  | 2.5%  |
| Item row loop (row starts, no items)               | 8.2%  | 9.6%  |
| Items in the rows (of it misses on positions)      | 21.2% (4.7%) | 18.0% (3.8%) |
| Rock lower bound and rock walk                     | 6.9%  | 7.3%  |
| Early-out: crowd count walk and `memory.fill`      | 6.1%  | 11.1% |
| Ray directions (`$dirsPairs`)                      | 2.2%  | 2.5%  |
| Wall pass (`$initPairs`)                           | 2.1%  | 2.1%  |
| Candidate loop shell (no ray groups)               | 3.4%  | 3.3%  |
| Prefilter, 2 rays per group                        | 8.8%  | 6.9%  |
| Exact tests (per-lane `ctz` loop, scalar test, `if`) | 10.5% | 9.7% |
| Closeness pass                                     | 2.5%  | 2.7%  |
| Crowd gather (f32 setup and walk)                  | 10.6% | 9.2%  |
| Feature emit, crowd rays, merge (of it input stores) | 15.5% (5.6%) | 15.2% (4.6%) |

Cold and hot (no 32 MB sweep) gave the same times at this load: other jobs churn the 12 MB L3 between calls, so both are cold. Misses that a probe can remove are small (positions 4-5%, row starts 1-2%, input stores 5-6%); the rest is instruction and branch cost.
Per ray, the four passes (directions, wall, closeness, emit) are about 15%; the cost that scales with rays times candidates is the prefilter plus exact tests, 17-19%, and the exact test costs about 45 ns each (11.7 groups and 3 tests a creature), mostly the data-dependent lane loop and the hit `if`.

## Ideas (all exact, hash-equal brain inputs of every creature at both snapshots: 35f12a2d, cb1ad30c)

Kernel ratio = variant p25 / base p25 in the same run, 3 runs per tick.

| # | Idea | Lines | t400 | t1500 | Expected at 3300 |
|---|------|------:|-----:|------:|------------------|
| 1 | Exact test two rays at a time: keep the f64x2 prefilter, and when a lane passes run the same quadratic and the tie rule in f64x2 on both lanes, masked by the prefilter (and by the last ray for odd nR), with one `bitselect` store of best and kind. Replaces the `ctz` lane loop and the scalar test. Item kind read only when a lane hits. | +25 -25 | 0.975, 0.976, 0.975 | 0.968, 0.977, 0.971 | -2.5% kernel, about -0.08 ms |
| 2 | Early-out zero fill as an inline `v128.store` loop with an `i32` tail instead of `memory.fill` (V8 calls out for it; cold lines make it worse). Equal in a hot microbench (192 B: 20 vs 23 ns), but faster in the kernel in all 16 runs. The per-ray `memory.fill` of `$emit` for strides other than 6 is an `i32` store loop too. | +9 -1, +10 -4 | 0.967-0.983 | 0.970-0.989 | -2% kernel, about -0.06 ms, more in sparse worlds |
| 3 | Closeness fused into the emit of the no-crowd path (`$emitClo` computes `1 - best / L` per ray); the closeness pass moves after the crowd gather and runs only on the full path. | +20 -2 | 0.989, 0.989, 0.989 | 0.996, 0.982, 0.989 | -1.1% kernel, about -0.035 ms |
| all | 1 + 2 + 3 (diff: sense.wat +73 -47) | +73 -47 | 0.949, 0.950, 0.946 | 0.946, 0.937, 0.941 | -5.5% kernel, about -0.17 ms (1.5% of a 10.6 ms tick) |

Ms figures assume a 3.1 ms kernel (79% of the 4.0 ms senser phase of a quiet run).

Rejected here: the exact test on both lanes for every group without the prefilter gate (branch-free, exact by the prefilter margin): 1.07-1.12x slower, the sqrt and stores on the 74% of groups no ray passes cost more than the branch saves.

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, base = `perf-live` 8443cb6, branch merged with it)

Load 21-24, so absolute ms are inflated.

| Case  | Build | cpuMsPerTick (med)               | senser ms (med)             | peak RSS MB   | fingerprint |
|-------|-------|----------------------------------|-----------------------------|---------------|-------------|
| mixed | base  | 12.841, 12.858, 13.003 (12.858)  | 4.671, 4.649, 4.726 (4.671) | 221, 219, 215 | 708687555   |
| mixed | 88    | 12.881, 12.611, 12.314 (12.611)  | 4.551, 4.447, 4.350 (4.447) | 219, 216, 219 | 708687555   |
| cap   | base  | 14.922, 15.393, 15.722 (15.393)  | 5.717, 5.863, 5.993 (5.863) | 253, 253, 252 | 10334191    |
| cap   | 88    | 14.612, 15.631, 15.001 (15.001)  | 5.387, 5.745, 5.493 (5.493) | 251, 251, 251 | 10334191    |

Ratio of medians: mixed 0.981 (senser -0.22 ms, -4.8%), cap 0.975 (senser -0.37 ms, -6.3%). The senser is lower in every pair in both cases, and the tick in 5 of 6 pairs. Peak RSS unchanged.
An earlier mixed series against 531a215 (before the merge) gave senser 4.895 to 4.729 (-0.17 ms) and tick 0.999. An earlier cap series is void: `perf-live` took idea 85 (cell order, senser -4.5%) during it, so its base ran newer code.

Diff against the branch point 531a215: `sense.wat` +88 -40, `kernels.generated.ts` 1 line.

## Tests

`npm run wasm`; `npx vitest run wasmKernels thinkEvery residentBodies wasmStep --testTimeout=180000 --maxWorkers=1`: 4 files, 66 tests, exit 0 (JS against kernel bit for bit for 0-12 rays, odd and even, and several strides). Merged build: `npx vitest run wasm sense resident thinkEvery ecoPool --maxWorkers=2` exit 1, 132 of 134: `residentBodies` and `wasmStep` "Inland Sea" timed out at 20 s (load 31); `npx vitest run residentBodies wasmStep --maxWorkers=1 --testTimeout=180000` 28 of 28, exit 0.

## Verdict suggestion

Merge. Exact (fingerprints equal in both cases), general over ray count and stride, senser -4.8% mixed and -6.3% at the cap, tick 1.9% and 2.5% in the pairs, for about 90 lines of WAT. The kernel has no dominant per-ray cost left: per-ray passes are about 15% of it, ray-candidate tests 17-19%, the rest walks, rock and the early-out, instruction and branch bound with under 10% removable misses. Further exact scouting of this kernel is not worth it.
