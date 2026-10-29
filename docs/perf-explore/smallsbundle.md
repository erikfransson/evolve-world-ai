# Idea 148: smallsbundle (ideas 141 + 142 + 147 piece B together)

Branch `pl-smallsbundle` from `perf-live` cedbd64 (engine as 377fddf). All runs `taskset -c 2,3,6,7 nice -n 19 ionice -c3 chrt --idle 0`, load 10-12.

## What
- 141 `pl-groundorder` (groundorder.md): quiet-block mask plus f64x2 blend in `fill.wat` prepare. Merged without conflicts.
- 147 piece B `pl-kernelsmalls` (kernelsmalls.md): u16 crowd `cellStart` with the 65535 guard. Merged without conflicts.
- 142 `pl-jsbundle` (jsbundle.md): `runOrder` export of `brain.wat` (mark and walk of `forwardRun`). `brain.wat` had been restructured by idea 127, so the function was inserted by hand (before `forward`, no dependency on the tab constants); `brainKernel.ts` and both tests applied cleanly. Tests kept (byte-mark stamp wrap, scrambled run lists, rejection of bad lists).
- Diff against `perf-live`: +294 -91 over 16 files (without `kernels.generated.ts` and docs).

## Measure
liveBench `--seconds 60 --profile`, 10 interleaved pairs per case, odd pairs base first and even pairs bundle first, base = the `perf-live` worktree. Fingerprints equal in all 40 runs (708687555 mixed, 10334191 cap).

| Case  | cpuMsPerTick base | bundle | Ratio of medians | Paired delta median / mean |
|-------|------------------:|-------:|-----------------:|---------------------------:|
| mixed | 9.718             | 9.237  | 0.9506           | -0.436 / -0.433 (sd 0.22)  |
| cap   | 10.963            | 10.759 | 0.9814           | -0.537 / -0.318 (sd 0.40)  |

Raw cpuMsPerTick, pairs 1..10, base then bundle.
- mixed base: 9.951 9.864 9.324 9.730 9.424 9.705 9.807 9.651 10.008 9.180
- mixed bundle: 9.500 9.342 8.942 9.666 9.002 8.998 9.269 9.235 9.239 9.117
- cap base: 11.535 10.529 10.628 10.874 11.339 10.918 11.521 11.009 11.202 10.490
- cap bundle: 10.953 10.232 11.223 11.080 10.635 10.365 10.923 10.884 10.606 9.968

Phase medians, base to bundle (ms; mixed / cap):

| Phase            | mixed                 | cap                   |
|------------------|-----------------------|-----------------------|
| slots            | 0.314 -> 0.207 (-0.107) | 0.419 -> 0.301 (-0.118) |
| brain forward    | 3.712 -> 3.591 (-0.121) | 3.366 -> 3.338 (-0.028) |
| crowd grid       | 0.144 -> 0.132 (-0.012) | 0.307 -> 0.294 (-0.014) |
| eat              | 0.776 -> 0.717 (-0.059) | 0.998 -> 0.966 (-0.031) |
| collisions       | 0.178 -> 0.143 (-0.036) | 0.260 -> 0.236 (-0.024) |
| senser           | 3.430 -> 3.319 (-0.111) | 4.227 -> 4.221 (-0.006) |
| memory and steer | 0.963 -> 0.937 (-0.026) | 1.095 -> 1.101 (+0.006) |

Peak RSS base / bundle: mixed 194-205 / 198-205 MB, cap 233-238 / 234-238 MB.

Brain forward did not move against the bundle (the +0.25-0.31 ms seen with piece B alone in kernelsmalls.md did not recur in 20 runs), so no piece isolation was needed. That shift was most likely load or placement noise in 6 pairs.
The gain is not purely additive on the phases (mixed cpu -0.44 ms, phases about -0.47 ms; brain forward -0.12 includes the mark pass that now runs in the kernel).

## Tests
`npx vitest run wasm fill crowd sense brain resident layout ecoSlotOrder thinkEvery --maxWorkers=2 --testTimeout=180000`: 11 files, 143 tests, exit 0. Full suite: 124 files, 1285 tests, exit 0.

## Verdict
Merge. Mixed -4.9%, cap -1.9% of the tick, exact, no memory growth. The cap case is noisy (paired sd 0.40 ms), the median ratio and 8 of 10 pairs agree on the sign.
