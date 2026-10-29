# Idea 39: which Node/V8 flags make the live tick cheaper (flags2)
Redo of idea 12 (flagslive.md) with more flags and 4+ pairs for anything near a win. Node 24.18 (V8 13.6), perf-live engine, `liveBench --seconds 60 --copies 800`, every run as `--max-old-space-size=768 <flag>` (the server's command), pinned `taskset -c 2,3,6,7 nice 19 idle`, load 12-24 from other sessions.
Protocol: base, flag, base, flag, ..., base. Ratio = flag run / mean of its two adjacent base runs. 59 base runs: cpuMsPerTick median 14.02 (13.6-14.8, one 10.6 outlier at load 2), sysMsPerTick median 0.028, peakRssMB 207-216. Fingerprint 708687555 in every one of ~120 runs.

| flag                                  | pairs | ratio per pair                    | median | cpu ms/tick | sysMs | peakRssMB | verdict |
|---------------------------------------|-------|-----------------------------------|--------|-------------|-------|-----------|---------|
| --no-liftoff                          | 4     | 1.007 0.998 0.996 0.995           | 0.997  | 14.19       | 0.044 | 208-210   | no (noise) |
| --max-semi-space-size=32              | 4     | 0.992 1.002 1.001 0.998           | 0.999  | 14.20       | 0.033 | 209-210   | no |
| --max-semi-space-size=64              | 1     | 1.012                             | 1.012  | 14.71       | 0.068 | 212       | no |
| --no-wasm-lazy-compilation            | 1     | 1.005                             | 1.005  | 14.65       | 0.064 | 220       | no, +10 MB |
| --no-wasm-dynamic-tiering             | 4     | 1.003 1.018 1.037 1.028           | 1.023  | 14.50       | 0.035 | 211-217   | worse |
| --max-old-space-size=256              | 1     | 1.003                             | 1.003  | 14.62       | 0.022 | 210       | no |
| --max-old-space-size=128              | 3     | 0.994 1.012 1.006                 | 1.006  | 13.98       | 0.026 | 212-215   | no gain, no RSS gain |
| --single-threaded-gc                  | 1     | 1.009                             | 1.009  | 14.64       | 0.032 | 221       | no, +10 MB |
| --no-concurrent-marking               | 1     | 1.015                             | 1.015  | 14.21       | 0.047 | 222       | no, +10 MB |
| --minor-ms                            | 8     | 1.010 0.982 1.001 0.977 1.003 0.995 1.002 0.994 | 0.998 | 13.92 | 0.029 | 209-214 | neutral on mixed |
| --wasm-deopt                          | 1     | 1.008                             | 1.008  | 14.24       | 0.031 | 213       | no |
| --wasm-inlining-call-indirect         | 4     | 1.008 0.992 0.997 1.002           | 0.999  | 13.92       | 0.021 | 209-215   | no |
| --turboshaft-wasm-in-js-inlining      | 1     | 1.017                             | 1.017  | 14.28       | 0.051 | 209       | no |
| --wasm-tiering-budget=1000000         | 1     | 1.008                             | 1.008  | 14.38       | 0.069 | 214       | no |
| --no-wasm-code-gc                     | 4     | 0.971 0.999 1.002 0.992           | 0.996  | 13.98       | 0.025 | 209-213   | no (first pair was noise) |
| --no-wasm-inlining                    | 4     | 1.011 1.024 1.039 1.029           | 1.027  | 14.43       | 0.025 | 210-214   | worse, default is right |
| --no-wasm-loop-unrolling              | 4     | 1.053 1.053 1.059 1.054           | 1.054  | 14.77       | 0.038 | 207-211   | worse, default is right |
| --no-wasm-loop-peeling                | 4     | 1.011 1.058 0.954 1.001           | 1.006  | 13.41       | 0.029 | 210-217   | no (spread 10%, noise) |
| --no-turboshaft-wasm-load-elimination | 3     | 0.957 1.001 1.005                 | 1.001  | 13.89       | 0.038 | 212-214   | no |

Juggernaut cap (`--only juggernaut --copies 4900`, fingerprint 10334191 in all 6 runs), base vs `--minor-ms`, 3 pairs:
base 17.07 16.85 16.67 ms/tick, peakRSS 252 250 249; minor-ms 16.92 16.31 16.76 ms/tick, peakRSS 222 217 221. Ratios 0.997 0.973 1.005 (median 0.997, within noise), RSS about -30 MB (-12%).

## Considered and not run
`--jitless` and `--wasm-jitless` (WASM kernels cannot run, idea 12), `--max-opt`/`--no-maglev`/`--no-sparkplug` (JS tiers; the tick is WASM-bound, JS glue is small), `--predictable`, `--gc-interval`, `--stress-*`, `--single-threaded` (also kills wasm tier-up threads, would only slow), `--wasm-num-compilation-tasks`, `--wasm-generic-wrapper`, `--wasm-math-intrinsics` (default on), `--wasm-opt` (default on), `--wasm-enforce-bounds-checks` (only slows), `--wasm-simd-ssse3-codegen`, `--wasm-fast-api` (experimental), `--experimental-wasm-branch-hinting` (idea 12: 1.003), `--max-lazy` (idea 12: 0.991 noise), `--initial-heap-size`/`--initial-old-space-size`/`--heap-growing-percent` (heap is 22-38 MB, idea 12 trace-gc shows GC is about 2% of CPU).
Why no flag can help much: GC is about 2% of CPU, and the WASM kernels tier up to TurboFan within the 15 s warm-up that the bench leaves out; flags that change tiering (`--no-liftoff`) only move warm-up.

## Verdict
No flag makes the tick cheaper: every ratio is within the 1-2% pair noise, the only real differences are losses (`--no-wasm-loop-unrolling` +5%, `--no-wasm-inlining` +3%, `--no-wasm-dynamic-tiering` +2%), which confirms the defaults.
Add nothing to `server/evolve-live.service.template` for speed; keep `--max-old-space-size=768`.
Optional memory flag: `--minor-ms` gives about -30 MB peak RSS at the 5000 cap with equal speed, but it is experimental in this V8 and only a 60 s run was checked, so it would need a long soak before use (suggest not).

# Idea 124: the flag sweep again on today's kernels (flags2, second round)
Branch `pl-flags2` from perf-live 6f81ad5, no code change. `node --max-old-space-size=768 <flag> src/liveBench.ts --seconds 30`, mixed `--copies 800` and cap `--only juggernaut --copies 4900`, pinned 2,3,6,7 nice 19 idle, load 8-20.
Per flag: base, flag, base, flag, base, flag, base (3 pairs); ratio = flag run / mean of its two adjacent bases. 40 base runs per case. Fingerprints: 654925885 (mixed) and 906134928 (cap) in all 140 runs, so no flag changes the result.
Base spread is large (mixed 9.4-13.1 ms/tick, cap 12.9-14.5), so pair ratios swing by up to 10-20% (a first all-base run of 30 mixed runs, same script, spanned 9.4-12.6).

| flag                                  | mixed ratios per pair | med   | cap ratios per pair   | med   | peakRSS mixed / cap | verdict |
|---------------------------------------|-----------------------|-------|-----------------------|-------|---------------------|---------|
| --no-wasm-loop-unrolling              | 0.919 1.192 1.020     | 1.020 | 1.020 1.054 1.054     | 1.054 | 210-213 / 234-249   | no, cap +5% (default right) |
| --no-wasm-loop-peeling                | 0.951 1.045 1.047     | 1.045 | 0.997 0.899 0.982     | 0.982 | 212-215 / 235-239   | no (mixed worse, cap noise) |
| --no-wasm-inlining                    | 1.062 1.144 1.012     | 1.062 | 1.142 1.099 1.033     | 1.099 | 211-214 / 234-241   | worse, +6 to +10% |
| --no-turboshaft-wasm-load-elimination | 0.990 0.988 0.983     | 0.988 | 1.008 0.998 1.034     | 1.008 | 210-213 / 233-238   | no (-1.2% mixed only, cap flat) |
| --wasm-tiering-budget=1000            | 1.031 1.018 0.995     | 1.018 | 1.012 1.064 0.988     | 1.012 | 211-216 / 236-241   | no |
| --no-wasm-lazy-compilation            | 0.986 1.039 1.011     | 1.011 | 1.001 1.026 1.016     | 1.016 | 220-223 / 245-252   | no, +10 MB |
| --no-liftoff                          | 0.968 0.992 0.827     | 0.968 | 0.999 1.001 0.981     | 0.999 | 211-214 / 234-240   | no (0.827 is a load dip, cap flat) |
| --max-semi-space-size=32              | 1.015 1.014 1.004     | 1.014 | 0.998 0.989 1.019     | 0.998 | 208-213 / 238-240   | no |
| --max-semi-space-size=64              | 1.002 0.992 0.975     | 0.992 | 0.997 0.983 0.978     | 0.983 | 209-214 / 234-239   | no (-1% to -2%, under the bar, within noise) |
| --single-threaded-gc                  | 0.914 1.011 0.980     | 0.980 | 0.981 1.010 1.011     | 1.010 | 217-220 / 240-246   | no, +5 MB, signs disagree |

Verdict: no flag reaches the 1.5% bar on both cases with consistent sign, so nothing goes into server/evolve-live.service.template.
Only weak leads: `--max-semi-space-size=64` (5 of 6 pairs below 1.0, medians 0.992 and 0.983, no RSS cost) and `--no-turboshaft-wasm-load-elimination` (mixed 3 of 3 below 1.0, cap flat); both are inside the base noise and the first round (above) had them at 1.012 and 1.001.
Raw: /tmp/claude-1000/-home-erik-progs-evolve-world-ai/955cd588-515f-4098-9019-fd8b6ae2ff1c/scratchpad/f2/results.txt (also results_bad_allbase.txt, 30 all-base runs from a script bug).
