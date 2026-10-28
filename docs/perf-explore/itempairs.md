# Idea 129: item walk two items at a time (itempairs)

Branch `pl-itempairs` from `perf-live` 4e9f308 (idea 126 merged). Exact, fingerprints equal. `perf-live` has since moved to d1f3e3b (splitblocks); it does not touch `sense.wat` or `senser.ts`, and the base of every pair below is a clean checkout of 4e9f308.

## What
- The item cell walk in `sense.wat` tests two consecutive packed items per step in `f64x2`: one `v128.load` of both f32 xy pairs, two shuffles and `promote_low_f32x4` to get fx and fy lanes, then the same subtraction, squares, distance test and wedge tests as the scalar loop, per lane (no fused multiply-add in wasm, so the bits are the same).
- The open-fan case is an `or` with a per-creature lane mask. The kept bits come out by `i64x2.bitmask`.
- Candidate order is unchanged: lane 0 is written at `cp` and `cp` advances by its bit, then lane 1 is written at the new `cp` and advances by its bit. Each lane writes fx, fy (one `v128.store` of the shuffled pair) and the item index, as before. The exact pass and the tie rules see the same candidates in the same order.
- An odd last item of a run reads one item past the run (8 bytes) and masks its lane with `it + 1 < ie`. `senser.ts` allocates the item xy region with 8 spare bytes so that read is always inside the block. The extra candidate write stays inside the candidate buffer (its 64 byte slack).
- Diff: `sense.wat` +29 -15, `senser.ts` +1 -1 (generated file 1 line).

## Kernel harness (p25 ms, same state, hash equal at calls 300, 1000, 1800)
| Case  | Call | base  | pairs | delta  |
|-------|-----:|------:|------:|-------:|
| mixed | 300  | 3.644 | 3.520 | -0.124 |
| mixed | 300  | 3.479 | 3.353 | -0.126 |
| mixed | 300  | 3.489 | 3.391 | -0.098 |
| mixed | 1000 | 3.425 | 3.256 | -0.169 |
| mixed | 1800 | 3.139 | 3.122 | -0.017 |
| cap   | 300  | 4.471 | 4.290 | -0.181 |
| cap   | 300  | 4.562 | 4.326 | -0.236 |
| cap   | 300  | 4.549 | 4.389 | -0.160 |
| cap   | 1000 | 4.159 | 3.970 | -0.189 |
| cap   | 1800 | 3.787 | 3.657 | -0.130 |

Variants tried (first pass, p25 delta against base, mixed / cap): over-read masked tail (the build) -0.08 / -0.17; load of an odd tail through `if` (`load64_zero`) +0.07 / +0.04; pairs plus a scalar tail loop -0.01 / -0.01; the over-read build with the wedge vectors zeroed when open instead of the `or` -0.08 / -0.12; with the loop test moved to the bottom -0.07 / -0.14 (all within noise of the build, not taken).
The branch for an odd tail costs what the pairing saves; rows hold 1.8 items on average (8.2 entries over 4.5 rows), so most steps are the odd tail and the branch-free masked one is the only form that pays.

## Rock disc walk and crowd walk
- Rock discs in pairs (indirect index, xyr gathers, same lane operations, branch-free write): hash equal, kernel +0.08 mixed and +0.10 cap against the item-pairs build, no better than base. Not taken. Most discs fail the distance test, which the scalar loop skips cheaply behind a predicted branch.
- Crowd walk (f32): not built. It holds 1.5 entries per busy creature over 4.6 rows (0.3 per row, `sensebudget.md`), so a two or four wide step almost never fills and the row loop dominates. Estimated gain under 0.03 ms.

## liveBench `--profile`, `--seconds 60`, taskset 2,3,6,7 nice 19 (load 12-25), alternating pairs
| Case  | Build | cpuMsPerTick                      | senser ms                    | brain forward ms          | peak RSS MB   | fingerprint |
|-------|-------|-----------------------------------|------------------------------|---------------------------|---------------|-------------|
| mixed | base  | 11.494, 11.652, 11.622 (11.622)   | 4.057, 4.078, 4.067 (4.067)  | 4.368, 4.456, 4.473       | 213, 215, 217 | 708687555   |
| mixed | new   | 11.501, 11.608, 11.743 (11.608)   | 3.996, 4.040, 4.106 (4.040)  | 4.421, 4.467, 4.494       | 219, 217, 221 | 708687555   |
| cap   | base  | 13.436, 13.978, 13.921 (13.921)   | 4.973, 5.164, 5.160 (5.160)  | 4.372, 4.564, 4.504       | 252, 252, 254 | 10334191    |
| cap   | new   | 13.535, 13.507, 13.539 (13.535)   | 4.972, 4.996, 5.010 (4.996)  | 4.414, 4.395, 4.396       | 256, 253, 257 | 10334191    |
| 600 s | base  | 10.638                            | 3.277                        | 4.374                     | 222           | 164690887   |
| 600 s | new   | 10.479                            | 3.258                        | 4.271                     | 222           | 164690887   |

Ratio of medians (new / base): senser 0.993 mixed (faster in 2 of 3 pairs), 0.968 cap (3 of 3), 0.994 at 600 s. Tick 0.999, 0.972, 0.985, but the brain forward phase moves by 1-3% between sides, so the safe claim is the senser delta: -0.03 ms mixed (0.3% of the tick), -0.16 ms cap (1.2%), -0.02 ms at 600 s.

## Tests
`npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000`: 5 files, 104 tests, exit 0.
Full suite: exit 1 with 7 timeouts at load 22-25 (6 in `cli.test.ts` at its fixed 20 s, 1 in `ecoPool.test.ts` at 60 s). Rerun of `cli` and `ecoPool`: `ecoPool` passes, 2 `cli` cases time out again; the same `cli` file on the unchanged base checkout times out in 3 cases at the same load. All timeouts, no assertion failure.

## Verdict suggestion
Exact and small (+30 lines of wat), but below the bar: the kernel gain is real (-3% mixed, -4% cap in the harness) and the whole-tick gain is 0.3% mixed and about 1.2% cap. The cause is short rows (1.8 items), so pairing fills a step only half the time and the row and branch costs stay. Merge only if Erik wants the cap-case 1.2%; otherwise drop. The rock and crowd walks do not take the treatment.
