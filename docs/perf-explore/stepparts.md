# Idea 97: parts of the step kernel, and the one exact cut that pays

Branch `pl-stepparts` from `perf-live` 538804e (includes idea 90, the fdlibm port in `step.wat`).

## Parts (live memory at tick 400, 3331 creatures, 800 copies x 4 founders)

Copies of `step.wat` truncated after a part (T rows, cumulative) or with a part ablated, run over restored rows, 32 MB cache sweep before every call, variants interleaved, 200 reps, p25 of CPU ms, taskset 2,3,6,7 nice 19, compared only with the `nop` reference (harness trap in `stepk.md`). Reference 1.05 ms (316 ns per creature), `nop2` copy 1.05. Repeat noise about 0.01 ms. Parts overlap in the out-of-order core (misses hide behind trig), so rows do not add up to 1.05.

| Part                                                         | ms    | ns/creature | Share | How measured |
|--------------------------------------------------------------|------:|------------:|------:|--------------|
| sin and cos (fdlibm port, `$sincos`)                         | 0.28  | 84          | 27%   | trig replaced by constants (-0.275 to -0.287) |
| of it `$rem` (argument reduction)                            | 0.10  | 28          | 9%    | `$rem` stubbed |
| of it the polynomials, quadrant switch, calls                | 0.18  | 55          | 17%   | rest |
| keepOut (call, early-out, rare full path)                    | 0.17-0.19 | 52-57   | 17%   | call removed |
| of it call plus return at once                               | 0.025 | 8           | 2%    | return at entry |
| of it the raster byte (cache miss)                           | 0.036 | 11          | 3%    | byte index constant |
| of it the two divides, floors and range tests                | 0.03-0.06 | 10-18   | 4%    | shift variant, early-out moved into `step` |
| first touch of row (3 lines), brain outputs, memory units    | 0.15  | 45          | 14%   | loads only, no arithmetic |
| memory units loop (arithmetic)                               | 0.09  | 26          | 8%    | `count` = 0 |
| loop skeleton (row pointer, species block, dt)               | 0.065 | 20          | 6%    | truncated after the loads |
| velocity                                                     | 0.03  | 9           | 3%    | T4 to T5 |
| position and row stores                                      | 0.036 | 11          | 3%    | T5 to T6 |
| wall clamps (2 calls)                                        | 0.01-0.04 | 3-11    | 2%    | T6 to T7 (-0.008 when removed) |
| turn, thrust, heading                                        | 0.015 | 4           | 1%    | T2 to T3 |
| energy                                                       | 0.023 | 7           | 2%    | T8 to full |

Counts in the live rows (hist at tick 400 / 1500): heading magnitude <= pi/4 14% / 6%, < 3pi/4 27% / 11%, medium path (n < 32) 59% / 82%, n >= 32 0% / 2%; units 2 (one short) for 75%, 16 (8 short) for 25%.

## Tried, exact (rows and units bit-identical to the reference in the harness), no gain

| Variant                                                                          | ms vs reference |
|----------------------------------------------------------------------------------|----------------:|
| quadrant swap and signs by select and xor instead of `br_table`                  | +0.02 |
| `$kcos` as one formula, `qx` by select (qx = 0 gives the first formula exactly)    | +0.05 |
| both of the above                                                                | +0.01 |
| `$ksc`: sin and cos kernel in one body, shared square and high word              | +0.01 |
| keepOut: loads of velocity, radius, bounce moved after the early-out             | -0.01 |
| keepOut early-out kept, called only when the raster says near (divides kept)     | 0.00 |
| two passes (heading and trig for all rows, then the rest)                        | +0.55 (pass 1 alone 0.96: the trig no longer hides behind the misses) |
| software prefetch of the next rows, 2 to 16 ahead, rows and outputs and units    | +0.18 (row lines only: +0.02) |
| three trig calls per creature (cost scales 2.6x, so the port is not latency hidden across creatures) | +0.49 |

The port is not branch bound: trig on a constant medium angle (always the same path) costs 0.24 ms against 0.28 for the real headings. `--no-wasm-inlining` makes the kernel 20% slower, so V8 already inlines the small helpers. `--no-liftoff` changes nothing, so the harness measures TurboFan code.

## Cut built: early-out inline in `step`, clear squares by shift

`CLEAR_CELL` 128 (`CLEAR_SHIFT` 7, as `stepcuts.md` (b)), and the early-out moved from `$keepOut` into `step`, so `$keepOut` is only called when the raster says a rock is near. `x >= 0 && y >= 0`, then `trunc_sat(x) >> shift` against the raster size as unsigned. Negative, NaN and out-of-raster positions take the full path as before. The raster is a conservative flag per square, so any cell size is exact; the JS twin (`terrain.ts`) uses the same constant. `P_CLEAR_CELL` (f64) became `P_CLEAR_SHIFT` (i32). Harness: -0.058 ms (5.5%); the same shift inside `$keepOut` gave only -0.034, the call and its spills explain the rest.

## Results (liveBench `--profile`, 60 s, alternating base, yours; taskset 2,3,6,7 nice 19; ms per tick)

| Case          | Step phase base       | Step phase yours      | Tick base (cpuMsPerTick) | Tick yours             | Fingerprint     | Peak RSS (MB) base / yours |
|---------------|-----------------------|-----------------------|--------------------------|------------------------|-----------------|----------------------------|
| Mixed 3300    | 1.084 1.069 1.049     | 1.045 1.036 1.024     | 11.804 11.570 11.365     | 11.756 11.519 11.545   | 708687555 equal | 216 215 219 / 214 220 217  |
| Juggernaut 4900 | 1.331 1.314 1.230   | 1.240 1.244 1.267     | 14.158 14.046 12.946     | 13.942 13.934 14.063   | 10334191 equal  | 253 255 254 / 253 252 258  |

Step phase medians: mixed 1.069 to 1.036 (-0.033, -3%), cap 1.314 to 1.244 (-0.070, -5%). Tick medians: mixed 11.570 to 11.545 (ratio 0.998), cap 14.046 to 13.942 (ratio 0.993); both inside the load noise of the tick (base cap pairs range 12.9 to 14.2).

Tests (taskset, nice 19): `vitest run wasm step resident --maxWorkers=2` exit 1, 98 of 100 pass, the two failures are 20 s timeouts of the Inland Sea rock tests under load; `vitest run wasmStep residentBodies --maxWorkers=1 --testTimeout=180000` exit 0 (30 tests). `npm run wasm` exit 0, `tsc --noEmit` exit 0.

## Verdict

The step kernel has no part left that an exact rewrite shrinks: trig is 27% and already at the floor for the fdlibm operation order (five rewrites tried), the memory units loop is 8%, the misses (about 14%) do not respond to prefetch, everything else is under 4%. The one cut that pays is the inline shift early-out: step phase -3% (mixed) to -5% (cap), tick gain under 1%, inside the noise. Diff: 24 lines added, 20 removed over `step.wat`, `layout.ts`, `stepKernel.ts`, `terrain.ts` (plus the regenerated `kernels.generated.ts`). Mergeable only if every 0.03 to 0.07 ms counts; otherwise reject like `stepcuts.md`.
