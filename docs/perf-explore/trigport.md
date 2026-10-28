# Idea 90: fdlibm sin and cos inside `step.wat`, probe-gated

Branch `pl-trigport` from `perf-live` 4f46e69. Scope: sin/cos only. The exp port for `crowd.pack` was dropped (another scout: 3300 host calls a tick are invisible).

## What
`step.wat` gets a port of V8's fdlibm `sin`/`cos` (`$sincos`, from `trig.md`'s `trig.wat`, pi/2 table replaced by `hi(n * pi/2)`, equal for n = 1..32). Beyond |x| 823549, NaN and infinities it calls the imported `Math.sin/cos`, so large headings stay exact. `$trig` picks the port when the exported global `port` is 1. `stepKernel.ts` runs `trigPortMatches` once per process (about 3300 probe angles: headings, wide ranges, multiples of pi/2 within ulps, edge cases) and sets `port` to 1 only when every bit equals the host's `Math.sin/cos`; other libms (Chrome's glibc copy differs in 3.3% of calls) keep the imports. Cost of the probe: 11-14 ms warm, about 80 ms cold, once.

## Measured
`liveBench --seconds 60 --profile`, taskset 2,3,6,7 nice 19 idle, alternating base, port x3. Step = phase `memory and steer`, ms/tick.

| Case | Base step | Port step | Base tick (cpuMsPerTick) | Port tick | Fingerprint | Peak RSS MB |
|------|-----------|-----------|--------------------------|-----------|-------------|-------------|
| Mixed 3300 | 1.274 1.346 1.300 | 1.107 1.110 1.109 | 12.658 13.268 12.846 | 12.851 13.010 12.896 | 708687555 equal | 215-218 / 216-221 |
| Juggernaut 4900 | 1.629 1.691 1.587 | 1.337 1.317 1.287 | 15.666 15.558 14.866 | 15.425 15.191 14.778 | 10334191 equal | 252-255 / 254-255 |

Step phase medians: mixed 1.300 to 1.109 (-0.19 ms, -15%), cap 1.629 to 1.317 (-0.31 ms, -19%). Tick medians: mixed 12.846 to 12.896 (ratio 1.004, noise), cap 15.558 to 15.191 (ratio 0.976). Crowd grid phase unchanged (0.19 / 0.41). Larger than the -0.11 ms of `scout-js.md` because the phase floor here is lower.

## Tests
`wasmStep` 21 pass (new: headings 823549 to 1e300, negative, NaN, infinities through `step` with the port on and off; port equals Math on 20000 random, large and k*pi/2 angles; probe returns false for a sin or cos that differs in the last bit). `vitest run wasm step crowd resident`: 6 files, 102 tests, exit 0. `tsc --noEmit` exit 0.

## Verdict
Exact on V8 (fingerprint equal on both cases), step phase -15 to -19%, whole tick gain inside the noise on the mixed case and about 2% on the cap case. Cost: +167 lines wat, +40 TS, +35 test, 1.4 KB more step kernel bytes (1702 to 3062). Mergeable if every 1% counts.
