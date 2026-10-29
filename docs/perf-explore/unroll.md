# Brain kernel: input loops unrolled by two (idea 38)

Branch `pl-unroll`, change in `src/typescript/src/sim/wasm/brain.wat` only (+128 -2, plus the regenerated `kernels.generated.ts`).
Question: does a manual two-input unroll of the column-block loops in `$layer` beat what TurboFan does (`brainblock.md` found the manual version slower, `brain.md` found unrolling gains little)?

## What changed
- Each of the six column-group loops (6 to 1 vectors) got a pair loop in front of the old single loop: two list entries, two splats, then `acc += w_i x_i` and `acc += w_{i+1} x_{i+1}` per accumulator, in the old order. The old loop stays as the odd tail.
- The 1- to 4-vector pair loops do the brain3 touches twice per iteration, so the prefetch stream is the same as before.
- Sums, order and tanh unchanged, so results are bit-identical.

## Measured
`liveBench --seconds 60 --profile`, alternating pairs (base = perf-live worktree), `taskset -c 2,3,6,7 nice -n 19`, load 10 to 17.

| Case                | Metric             | Base (3 runs)           | Unroll (3 runs)         | Ratio of medians |
|---------------------|--------------------|-------------------------|-------------------------|------------------|
| 4 founders x 800    | cpuMsPerTick       | 14.43, 14.18, 14.48     | 14.29, 14.50, 14.78     | 1.005x slower    |
|                     | brain forward      | 4.87, 4.78, 4.88        | 4.98, 5.07, 5.12        | 1.04x slower     |
| Juggernaut x 4900   | cpuMsPerTick       | 17.56, 17.55, 17.91     | 17.77, 18.00, 17.89     | 1.02x slower     |
|                     | brain forward      | 4.95, 4.95, 5.08        | 5.11, 5.19, 5.17        | 1.04x slower     |

Fingerprints equal in all runs (708687555 mixed, 10334191 Juggernaut). Peak RSS 213-219 MB vs 216-219 (mixed), 252-259 vs 253-259 (Juggernaut).
Brain forward is slower in every pair of both cases (5 of 6 by more than 2%); the whole tick is at best equal.

## Tests
`node scripts/buildWasm.ts` (exit 0), `npx vitest run wasmKernels thinkEvery ecoPool --testTimeout=180000 --maxWorkers=1`: 3 files, 63 tests, exit 0 (includes the thinkEvery pin 81047108).

## Verdict suggestion
Reject. Bar was 1.5% of the tick, result is 0.5% to 2% slower. TurboFan already unrolls the single loop, and the manual version only adds code size and a second tail loop. Matches `brainblock.md`. Do not merge.
