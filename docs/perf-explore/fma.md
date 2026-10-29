# Fused multiply-add in the WASM kernels (relaxed SIMD)

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines changed | Verdict |
|------|--------|-------|---------|--------|-----------------|---------------|---------|
| `f32x4.relaxed_madd` in the brain layers and tanh, `f64x2.relaxed_nmadd` in the sense prefilter, plain build kept as fallback | 3200 mixed: 15.41 cpuMs/tick; juggernaut x4900: 18.71 | 15.05; 18.24 | 1.024x; 1.026x | no: fused rounding, fingerprint 708687555 to 468318256 (juggernaut 10334191 to 960903436) | +1 MB (217 vs 216) | about 90 (kernels.generated.ts +7 KB) | Small but cheap; merge only if the fingerprint change and a runtime-dependent result are acceptable |

## What
- `.wat` files write `(f32x4.fma a b c)` (a*b+c), `(f32x4.nfma a b c)` (c-a*b), likewise `f64x2`. `scripts/wasmAssemble.ts` expands them to `mul` plus `add`/`sub` (plain build, byte-identical to before) or to `relaxed_madd`/`relaxed_nmadd` (wabt `relaxed_simd`). BRAIN and SENSE get both builds in `kernels.generated.ts`.
- `loader.ts` picks the relaxed build when `WebAssembly.validate` accepts it, else the plain one (`brainBytes()`, `senseBytes()`); `setRelaxedDisabled` forces plain for tests and `node src/wasmBench.ts --plain`.
- Fused: the 10 accumulate lines of `$layer`, the tanh polynomials (6 fused steps), the sense item prefilter (`fx*a - fy*b`, margin 1e-9 far above rounding, so the exact test still decides), and the f32 creature ray `b = cx*dx + cy*dy`.
- Not fusable: `step.wat`, `fill.wat`, `crowd.wat`, `members.wat` and the item trace in `sense.wat` are scalar f64 and WASM has no scalar fma (only `f32x4`/`f64x2` relaxed ops). The `disc = b*b - c` of the creature ray needs a negation first; left alone.

## Measured
`nice -n 19`, load 8-17, other sessions benching. Live bench 60 s, user CPU per steady tick, base = perf-live, alternating.

| Case | base runs | fma runs | median base | median fma | ratio |
|------|-----------|----------|-------------|------------|-------|
| 3200 mixed (6 pairs) | 15.73 15.18 13.50 15.68 15.26 15.55 | 15.18 13.73 13.73 15.06 15.03 15.07 | 15.41 | 15.05 | 0.977 |
| juggernaut x4900 (3 pairs) | 18.66 19.13 18.71 | 18.24 18.50 18.23 | 18.71 | 18.24 | 0.975 |

Phases, 3 profiled pairs (3200 mixed): brain forward 5.37 5.23 5.30 to 4.89 4.89 4.91 ms (-7%); senser 5.87 5.72 5.84 to 5.80 5.79 5.81 (no change). Peak RSS 214-218 MB both.

Kernel (`node src/wasmBench.ts --sizes 3000 --reps 40`, plain vs relaxed in one tree, 3 alternating runs): default plan 5.77 2.70 2.94 ms plain, 2.74 2.78 2.49 relaxed (first plain run was loaded); large plan (4x32 hidden, 16 rays) 21.4 17.7 17.1 plain, 16.9 15.6 15.7 relaxed, about 8% faster (median 17.7 to 15.7).

## Accuracy
- `wasmBench` max abs difference to the JS brain: default 1.8e-7 plain and fused; large 3.7e-7 plain, 3.4e-7 fused. Fusing does not widen the error. The brain test tolerance (2e-6) is unchanged; a new test runs both builds against `Brain.forward` and against each other (< 1e-6).
- Behaviour: 60 s live bench steady population 3306 to 3313, births 428 to 436, deaths 344 to 347 (different trajectory, same level).
- Pinned WASM-path fingerprints re-pinned in `ecoPool.test.ts`, `simHygiene.test.ts` (81047108 to 972216583) and `ppo.test.ts`. JS-path pins are unchanged.

## Caveat
`relaxed_madd` may fuse or not, depending on the CPU (x86 FMA3, ARM yes, others no), so results depend on the machine: server, browsers and helper threads on one machine agree, but a Live world saved on one host and replayed on another can diverge, and Safari/older browsers run the plain build. Both builds are valid; only cross-machine bit-equality is lost (it was already lost between JS and WASM).

## Tests
`npx vitest run --maxWorkers=2` in `src/typescript`: WASM/brain/resident/RL files 9 files 114 tests pass; full run 1207 passed and 3 failed on the old pins above, which pass after re-pinning (re-run twice).
