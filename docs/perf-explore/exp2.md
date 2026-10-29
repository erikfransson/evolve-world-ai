# Two-lane `exp` for the crowd pack signal (idea 109)

Exact, probe-guarded, pack alone -25% hot (-55 us of 210), whole tick -1.0% in pairs but inside the spread. Branch `pl-exp2` from `perf-live`: +207 -9 lines (crowd.wat +111, crowdKernel.ts +45, tests +48).

## What
- `crowd.wat` `$exp2`: V8's fdlibm `ieee754::exp` on f64x2, same constants, same operation order (the division by `c - 2` is the negated division by `2 - c`, so the k = 0 case shares the formula with hi = x, lo = 0). Straight path when both lanes have |x| in [2^-28, 700) and x != 1: reduction by `f64x2.trunc` (no i32 conversions), 2^k from the exact double `k + 1023 + 2^52` shifted by 52. Any other pair takes `$exp2Edge`: masks and selects for tiny, exp(1), k = 1024, k below -1021, overflow, underflow, NaN, infinities.
- `pack` now fills the signal column first in `$signals` (pairs with `$exp2` when the global `port` is 1, scalar import for the odd tail and when off), then the old loop copies positions and, with `toRows`, the signal into the rows.
- `crowdKernel.ts` `expPortMatches`: start-up probe, about 4600 deterministic arguments (signal range, whole range, branch edges, k boundaries within ulps, specials), each in both lanes against `Math.exp`; one bit difference keeps the host path. Runs once per process, 20-30 ms cold.

## Checks
- Port vs `Math.exp`, `Object.is`: 20.07M arguments (random in six scales, every k boundary within 2 ulps, edges of each branch, random bit patterns, specials squared), 0 mismatches, both lanes. Same in `wasmCrowd.test.ts` (80k arguments, probe true, probe false for a one-ulp host difference, for a difference only below -700 and one only in (-3, 0), which is the straight path).
- Test of `pack` with port on and off at awkward energies (0, -0, denormal, 1e300, inf, NaN, negative) for odd and even counts equals `energySignal` bit for bit.
- `vitest run wasm crowd sense resident --maxWorkers=2 --testTimeout=180000`: 6 files, 104 passed, exit 0 (includes the kernel drift test).

## Speed
First version (every special case as selects on every pair, `i32x4.trunc_sat` conversions): micro 182 vs 148 us per 3300 for the scalar import, pack in the whole tick slower (0.26 to 0.29 ms). 100 vector ops with long conversion sequences cost more than two 45 ns C calls. The straight path above fixes it:

| Measure (3300, taskset 2,3,6,7, load 10-20) | host exp (port 0) | port (port 1) |
|---|---|---|
| wasm micro loop, us per 3300, 6 runs | 145-153 | 93-115 |
| `pack` in the live tick, hot repeat (median / min of 32 repeats, 3 runs), us | 207, 208, 219 / 112, 122, 125 | 153, 153, 163 / 96, 103, 103 |

Same binary and process for the last row (port flipped between repeats), so the pair is exact. Gain 0.02-0.055 ms per tick.

## Whole tick (liveBench `--profile`, 60 s, alternating pairs; first row set is the non-straight first version)
| Case | Build | cpuMsPerTick (median) | senser ms | peak RSS | fingerprint |
|---|---|---|---|---|---|
| mixed | base | 10.552, 11.095, 11.129 (11.095) | 3.903, 4.136, 4.162 | 217, 219, 214 | 708687555 |
| mixed | yours | 10.987, 10.892, 11.013 (10.987) | 4.106, 4.036, 4.012 | 220, 220, 221 | 708687555 |
| cap | base | 13.345, 12.923, 13.589 (13.345) | 5.161, 4.994, 5.181 | 253, 255, 253 | 10334191 |
| cap | yours | 13.231, 13.181, 12.988 (13.181) | 5.149, 5.119, 5.031 | 254, 252, 254 | 10334191 |

Ratio of medians 0.990 (mixed), 0.988 (cap). The first version gave 1.006 and 1.001 (mixed 10.91, 11.114, 10.877 vs 11.058, 10.326, 10.974; cap 13.247, 13.176, 13.897 vs 13.294, 12.759, 13.266). The expected gain, 0.02-0.055 ms, is 0.2-0.5% of the tick, so the pairs show the right sign but cannot resolve it (spread 3-5%). RSS +2 to +3 MB is run noise (base itself varies 214-219).

## Verdict
Exact on every checked argument and guarded by the probe, no fingerprint change; the gain is real but small (about 0.3% of the tick). Merge only if 110 lines of wat are acceptable for that; otherwise reject as "works, too small". Not worth more work: the remaining pack cost is the division by startEnergy and the stores.
