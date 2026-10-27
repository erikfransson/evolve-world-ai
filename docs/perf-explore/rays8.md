# Sense kernel: per-ray passes two rays per step (idea 36, "rays8")

Exact, 2.7% of the tick at 3300 creatures and 1.4% at the cap. Branch `pl-rays8` from `perf-live`, change in `sense.wat` only (+85 -1, plus the regenerated `kernels.generated.ts`).

## What

First version was a straight-line path for exactly 8 rays (-5.5% kernel). Erik's rule is that fast paths cover every ray count the plan allows (1 to `MAX_RAYS` = 64), so it was replaced by helpers that work for any `nR`, two rays per step as f64x2 with the same per-lane ops in the same order. Each returns the rays it did (`nR` rounded down to even), the scalar loop after the call does the odd last ray.

- `$dirsPairs` (directions by angle addition), `$initPairs` (no wall near: best = L, kind 0, replaces the wall loop), `$closePairs` (closeness and the three f32 arrays the crowd rays read).
- `$unseen` / `$emit`: when there is no detail record and no ray saw a creature (padding lanes of the last group masked), every ray's features are the closeness, the food/poison/wall one-hot and zeros. `$emit` writes them for any stride (`i64` store for stride 6, `memory.fill` for other strides above 4), skipping the per-ray species-flag and energy code. Otherwise the old loop runs.
- No variant per vector count: the straight-line 8-ray version gained less (-5.5%) than the pair loops (-7%), which also cover the 12-ray creatures, so the loop counter is not what costs. Not built for 1, 2, 3 vectors.

## Kernel harness (cold, interleaved, p25, `senselive.md` method, snapshots at tick 400 and 1500, 200 reps, 2 runs each)

Brain inputs of all creatures (2504 with 8 rays, 826 with 12, NaN-poisoned before each call) hash equal to the base kernel: b101b365 (t400), 50357cc0 (t1500).

| Snapshot | Base p25 ms          | rays8 p25 ms         | Ratio          |
|----------|----------------------|----------------------|----------------|
| t400     | 5.133, 4.967         | 4.768, 4.628         | 0.929, 0.932   |
| t1500    | 4.455, 4.327         | 4.148, 4.039         | 0.931, 0.933   |

## Whole tick (liveBench `--profile`, 60 s, taskset 2,3,6,7 nice 19, 3 alternating pairs, base = perf-live 64953f2, rays8 merged with it)

| Case  | Build | cpuMsPerTick                        | senser ms                | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|--------------------------|---------------|-------------|
| mixed | base  | 14.476, 14.518, 14.497 (med 14.497) | 5.678, 5.734, 5.725      | 220, 220, 219 | 708687555   |
| mixed | rays8 | 14.064, 14.199, 14.106 (med 14.106) | 5.360, 5.392, 5.376      | 221, 219, 218 | 708687555   |
| cap   | base  | 17.177, 17.517, 17.362 (med 17.362) | 7.073, 7.147, 7.124      | 256, 252, 252 | 10334191    |
| cap   | rays8 | 17.134, 16.995, 17.114 (med 17.114) | 6.836, 6.772, 6.808      | 250, 254, 251 | 10334191    |

Mixed: ratio of medians 0.973, senser -0.35 ms (6.1%). Cap: 0.986, senser -0.32 ms (4.4%). Every pair better. Peak RSS unchanged.

## Tests (all exit 0)

Kernels regenerated (`node scripts/buildWasm.ts`); `npx vitest run wasmKernels thinkEvery residentBodies wasmStep --testTimeout=180000 --maxWorkers=1`: 4 files, 65 tests passed. `wasmKernels` compares kernel rays and brain inputs bit for bit with the JS sense for 0, 1, 3, 5, 6, 7, 9, 10 and 12 rays and several species counts (strides), detail and non-detail.

## Verdict

Merge. Exact, general over ray count and stride, about 2.7% (mixed) and 1.4% (cap, just under the 1.5% bar) of the tick for 85 lines of WAT.
