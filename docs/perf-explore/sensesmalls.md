# Idea 143: sensesmalls (idea 129 itempairs + idea 136 emitstage)

Branch `pl-emitstage`: `pl-itempairs` merged on top of b34cdbb. The two touch different parts of `sense.wat` (item walk; emit and crowd merge), no conflict; `kernels.generated.ts` regenerated with `npm run wasm`. Exact.

## Parts
- itempairs (`itempairs.md`): item walk two packed items per step with a masked over-read tail, `senser.ts` +8 bytes on the item xy region. Alone senser 0.993 mixed / 0.968 cap.
- emitstage (`emitstage.md`): stride-6 pair emit and lean crowd merge loop. Alone senser 0.972 / 0.972 (-0.11 / -0.14 ms).

## Kernel harness (p25 ms, 2 alternating runs, hash equal: mixed 10b91cba, cap 4cc9bd68)
| Case  | Run | base  | bundle | delta  |
|-------|-----|------:|-------:|-------:|
| mixed | 1   | 3.537 | 3.245  | -0.292 |
| mixed | 2   | 3.553 | 3.272  | -0.281 |
| cap   | 1   | 4.562 | 4.215  | -0.347 |
| cap   | 2   | 4.600 | 4.236  | -0.364 |

## Whole tick (`liveBench --profile --seconds 60`, 3 alternating pairs, base = frozen worktree at 9a861ba)
| Case  | Build  | cpuMsPerTick                    | senser ms                   | brain forward ms    | peak RSS MB   | fingerprint |
|-------|--------|---------------------------------|-----------------------------|---------------------|---------------|-------------|
| mixed | base   | 11.180, 11.435, 11.380 (11.380) | 4.003, 4.084, 4.070 (4.070) | 4.288, 4.379, 4.364 | 222, 217, 215 | 708687555   |
| mixed | bundle | 11.130, 11.345, 11.495 (11.345) | 3.885, 3.938, 3.949 (3.938) | 4.311, 4.400, 4.478 | 220, 215, 218 | 708687555   |
| cap   | base   | 13.396, 13.004, 13.363 (13.363) | 5.097, 4.987, 5.111 (5.097) | 4.215, 4.095, 4.224 | 256, 254, 254 | 10334191    |
| cap   | bundle | 12.928, 13.352, 12.944 (12.944) | 4.834, 4.983, 4.851 (4.851) | 4.127, 4.261, 4.117 | 253, 255, 254 | 10334191    |

Senser, new / base: 0.968 mixed (-0.13 ms, faster in 3 of 3 pairs), 0.952 cap (-0.25 ms; pairs -0.26, 0.00, -0.26, pair 2 had a loaded machine with brain forward +0.17 on the bundle side). Tick: 0.997 mixed, 0.969 cap. By the senser delta that is 1.2% (mixed) and 1.9% (cap) of the tick. The kernel harness gain (0.29 / 0.35 ms) is larger than the liveBench senser gain, as in earlier notes (cold lines).

## Tests
`npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000`: 5 files, 107 tests, exit 0. The full suite on the emitstage part alone had two load timeouts that pass alone (see `emitstage.md`); not rerun for the merge.

## Verdict
Merge. Exact, senser -3% mixed and -5% cap, 1.9% of the tick in the cap case with mixed not worse, which meets the 1.5% bar, though one of the three cap pairs showed no gain under load.
