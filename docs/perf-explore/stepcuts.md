# Idea 66: step kernel cuts measured together

Branch `pl-stepcuts`. Question: do (a) the memory-unit loop as two constant-rate f64x2 segments, (b) a power-of-two clear-raster cell (shift instead of two f64 divides and floors in keepOut's early-out) and (c) the crowd cell key written by the step tail clear 1% of the tick together?

## Pre-check and split harness
`stepk.md` split harness on the live memory at tick 400 (3331 creatures; 2504 have 2 units with 1 short, 826 have 16 with 8 short, 1 has 1), 32 MB cache sweep before every call, interleaved, 150 to 200 reps, p25 CPU ms per call, compared with the `nop` reference only (harness trap in stepk.md). Every variant gives bit-identical rows and units (hash over all 13 f64 slots and the units).

| Variant                                              | ms per call | ns/creature |
|------------------------------------------------------|------------:|------------:|
| nop reference (two copies)                           | 1.213 1.225 | 364 368     |
| (a) units as 2 segments, f64x2 pairs, helper `$blend` | 1.345       | 404         |
| (a) same, inlined segment loop                       | 1.301       | 391         |
| (b) shift early-out (cell 128)                       | 1.184       | 355         |
| no memory units at all                               | 1.139 (other run) | 342   |

(a) is slower in both forms: 75% of creatures have 2 units (one per segment), so pairs never run and the segment setup (splat, bounds, loop entry) costs more than the per-unit select and two rate loads it removes. The whole loop is only 22 to 33 ns per creature, so there is nothing left to win. Dropped. (c) was to be built only if (a) and (b) both cleared the noise, so not built.

## (b) as built
`CLEAR_SHIFT = 7`, `CLEAR_CELL = 1 << 7` (128 instead of 100) in `terrain.ts`; `P_CLEAR_CELL` (f64) became `P_CLEAR_SHIFT` (i32). The early-out is `x >= 0 && y >= 0`, then `trunc_sat(x) >> shift` against the raster size as unsigned. Negative, NaN and out-of-raster positions take the full path as before. The raster is a conservative flag per square, so any cell size is exact. Harness gain: 9 to 13 ns per creature, about 0.03 ms per tick.

## Results (liveBench `--profile`, 60 s, alternating base/yours, 3 pairs, taskset 2,3,6,7, nice 19)

| Case             | Phase base (ms)       | Phase yours (ms)      | Tick base (cpuMsPerTick)  | Tick yours                | Fingerprint      | Peak RSS (MB) base / yours |
|------------------|-----------------------|-----------------------|---------------------------|---------------------------|------------------|----------------------------|
| Inland Sea, 3300 | 1.371 1.387 1.389     | 1.381 1.361 1.380     | 13.986 14.057 14.058      | 14.105 14.074 14.141      | 708687555 equal  | 220 215 219 / 218 220 217  |
| Juggernaut, 4900 | 1.713 1.717 1.716     | 1.686 1.694 1.691     | 17.114 17.135 17.134      | 16.942 16.962 17.086      | 10334191 equal   | 254 255 256 / 255 254 256  |

Medians: mixed phase 1.387 to 1.380 (-0.007), tick 14.057 to 14.105 (+0.3%, noise); cap phase 1.716 to 1.691 (-0.025, 1.5%), tick 17.134 to 16.962 (-1.0%, but 4x the phase delta, so noise). The phase gain is 0.05% (mixed) to 0.15% (cap) of the tick.

Tests (nice 19, taskset 2,3,6,7, `--maxWorkers=1`): `npm run wasm` exit 0, `wasmKernels wasmStep residentBodies thinkEvery ecoPool` exit 0 (5 files, 91 tests, includes the thinkEvery pin 81047108 and the rock fuzz).

## Verdict
Reject the bundle: (a) loses, (b) is exact and free but 0.1% of the tick, far under the 1% bar. If a later merge wants every 0.03 ms, (b) alone is a 10 line diff (step.wat, layout.ts, stepKernel.ts, terrain.ts).
