# Bundle of three small exact wins (idea 112)

Branch `pl-bundle` from perf-live 8954f02: `pl-itemsync` (idea 100) + `pl-exp2` (idea 109) merged, plus `runOrder` (item 3). Exact: fingerprints 708687555 and 10334191 hold in all 12 runs. Whole tick not resolved (mixed about -1%, cap about +1%); the one clear part is `patchItems` (syncItems -0.16 ms).

## Merges
- Both branched from older heads. Conflicts were only `kernels.generated.ts` (regenerated with `npm run wasm`) and one import in `wasmCrowd.test.ts` (kept `LAYOUT`, exp2's test uses it). `tsc` flagged `setItem(..., 1 + (k % 2))` in the itemsync test (the argument type is now `HitKind`), cast added.
- After each merge: `vitest run wasmKernels` 31 passed after itemsync, `vitest run wasm crowd` 97 passed after exp2.

## Item 3: `runOrder` in `brain.wat`
`forwardRun` stamped the run's slots in `mark` and walked `order` in block-address order, two JS loops. Now `order` and `mark` live in linear memory (arena blocks, grown like the descriptor table) and the export `runOrder(slots, n, order, held, mark, stamp)` does both loops in place and returns the count placed; JS throws if it is not `n`, as before. Same brain order, so identical results. New test: `forwardRun` against `forwardSlots` through slot growth past 64 and 128, releases, resized blocks, three scrambled lists, and a duplicate slot.
Caveat: `forwardRun` trusts the slot list (callers pass slots of attached creatures), so a slot beyond the table would now trap or stamp the wrong word instead of being ignored by the typed array.

## Numbers
kernelTimers (`--copies 800 --ticks 400`, 3 alternating pairs, ms per tick, medians; timers add about 1 us per call):
| Part | Base | Bundle | Change |
|---|---|---|---|
| syncItems (patchCell x58 -> `patchItems`) | 0.222, 0.242, 0.271 (0.242) | 0.082, 0.084, 0.086 (0.084) | -0.158 |
| `crowd.pack` (two-lane exp) | 0.198, 0.233, 0.220 (0.220) | 0.207, 0.193, 0.207 (0.207) | -0.013 |
| `forwardRun` minus `brain.forward` (the stamp and walk) | 0.033, 0.034, 0.045 (0.034) | 0.033, 0.033, 0.047 (0.033, of it `runOrder` 0.023) | -0.001 |
| kernelTimers cpuMsPerTick | 10.045, 9.521, 10.318 | 9.842, 9.716, 10.175 | -0.18 (0.98) |

The JIT-compiled JS loops were as fast as the wasm ones (about 3.3 ns per slot, a cache-missing `mark[slot]` access in both), so item 3 gains nothing. Cap-like check (`--only juggernaut --copies 1200`, 2 pairs): syncItems 0.167, 0.142 -> 0.060, 0.044; pack 0.107, 0.074 -> 0.065, 0.087 (noise); `runOrder` 0.010-0.025.

liveBench `--profile`, 60 s, 6 alternating pairs per case (pairs 4-6 bundle first), cpuMsPerTick:
| Case | Base | Bundle | Median base, bundle | Pair ratios |
|---|---|---|---|---|
| mixed 800 x 4 | 9.449, 10.490, 10.518, 10.408, 10.248, 9.359 | 9.317, 10.554, 10.537, 8.156, 10.157, 9.237 | 10.328, 9.737 | 0.986, 1.006, 1.002, 0.784 (load dip), 0.991, 0.987 |
| cap 4900 juggernaut | 10.402, 11.105, 11.091, 11.000, 11.028, 11.496 | 11.221, 11.487, 11.121, 10.765, 11.228, 11.027 | 11.060, 11.171 | 1.079, 1.034, 1.003, 0.979, 1.018, 0.959 |

Ratio of medians 0.943 (mixed, pulled by the 8.156 outlier; median of pair ratios 0.989) and 1.010 (cap, median of pair ratios 1.010). Spread inside one build is 3-9%, so neither resolves. Peak RSS 214-222 base, 217-222 bundle (mixed); 252-258 and 253-257 (cap). Fingerprint 708687555 / 10334191 in every run. Phases (medians over 6): mixed senser 3.876 -> 3.591, cap senser 4.347 -> 4.364.

## Tests
`vitest run wasm crowd sense ecosystem resident thinkEvery brain --maxWorkers=2 --testTimeout=180000`: 11 files, 182 passed, exit 0. `tsc --noEmit` exit 0.

## Verdict
Merge `patchItems` (itemsync) on its own: -0.16 ms measured with timers, exact, +150 lines. Exp2 gives about -0.01 to -0.03 for 207 lines (park). Item 3 gives nothing (park, drop `runOrder`). Expected bundle total about -0.17 ms (1.6% of 10.5), below what 6 pairs can show on this machine.
