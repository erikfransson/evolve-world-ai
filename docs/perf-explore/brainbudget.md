# Brain kernel budget and tidy bundle (idea 127, "brainbudget")

Branch `pl-brainbudget`. Exact (fingerprints 708687555 mixed, 10334191 cap), brain forward -5% mixed / -8% cap, tick 1.012x mixed / 1.032x cap. Verdict suggestion: merge.
Budget and variants were measured on perf-live before ideas 125, 126 and 128 (6935157 minus the merge); the bundle was rebuilt on the split-block kernel of idea 125 and measured there.

## How measured
- Kernel harness (`scratchpad/bb2/kab2.ts`): the live world run to tick 600, one tick's `forward` call dumped (memory, descriptors, run list; mixed 3318 brains, cap 4900), then variant `.wat` files timed alternately on copies of that memory, user CPU per call, p25 of 200-300 reps (spread between identical copies 0.3-1.5%). Output memory hashed, equal hash is exact.
- Cold: 48 MB eviction, then inputs and descriptors read back as the senser leaves them. In-core: 64 evenly spaced brains cycled over the whole run list (weights stay in L2), no eviction.
- Static instructions per loop from `node --print-wasm-code --no-liftoff` on the harness, dynamic counts are those times counters from the dump (nz inputs per brain: 7.7-7.9 small shapes, 22.4 for the 93-24-24-24-24-18 Oracle).
- Machine code facts that explain the numbers: the cores run near 1.4 GHz and share SMT siblings with other jobs, IPC about 2.2 in-core. `forward` calls `$layer` with 10 arguments (5 on the stack) and `$compact` per brain; each call reloads about 25 spilled values.

## Budget (perf-live before 125, ms per call, medians; ablations are timing only, outputs change)
Mixed: cold 4.30, in-core 2.83. Cap: cold 4.41, in-core 3.11.

| Stage                                              | Mixed cold | Cap cold | Mixed in-core | Cap in-core | Instructions per unit |
|----------------------------------------------------|-----------:|---------:|--------------:|------------:|-----------------------|
| Touch stream (two loads, pointer step, per input)  | 0.49 (11%) | 0.78 (18%) | 0.21 (7%, pure cost when the weights are in L2) | 0.36 (11%) | 8 of the 19/22/25/28 per input in the 1-4 vector loops |
| Compact (second call, hot)                         | 0.27 (6%)  | 0.32 (7%)  | 0.30 (11%)    | 0.28 (9%)   | 22 per all-zero group of 16, about 80 per non-zero group, 27 per 4-wide step, about 25 set-up |
| Layer-0 and later column loops, with touches       | 1.73 (40%) | 1.30 (29%) | 1.56 (55%)    | 1.56 (50%)  | 19 / 22 / 25 / 28 / 24 / 27 per input for 1 to 6 vectors |
| tanh (second pass cost / removing it)              | 0.55 (13%) | 0.62 (14%) | 0.60 (21%)    | 0.61 (20%)  | 27 per vector, 27 for the constants per layer |
| Layer calls with empty loops, no tanh, no compact  | 1.01 (23%) | 1.26 (29%) | 0.41 (14%)    | 0.53 (17%)  | about 110-130 per layer (forward 55-60, layer set-up 30, dispatch and epilogue 25) |
| Brain loop and descriptor reads only (no layers)   | 0.07 (2%)  | 0.09 (2%)  | 0.06          | 0.07        |                       |
| Output store, per-brain descriptor                 | inside the rows above, not separable (one line each, hits L2 after the senser) |

Reading:
- The kernel is not memory-bound in the cold run in the usual sense. Doubling the tanh or the compaction adds exactly its in-core cost (+0.55 ms, +0.27 ms), so time is core time plus stalls, and the core part is a latency chain per brain (compact, then per layer the add chain, the store, tanh with its division, the reload) with little overlap between brains.
- Instructions inside the column loops are almost free: removing 3 of 8 touch instructions per input (a `min` instead of the compare, copy and move) moved the cold run by -0.4% to -1.5% (slower), and stepping pointers instead of index loads and `imul` in the dense layers (-3 instructions per input) gave +1.5% to +3.4% in-core but -1% to -4.6% cold at the cap. The faster loop issues its touches in a denser burst, which loses what it saves (as `touchdist.md` found for bursts).
- Per-layer overhead outside the loops is what shows: call arguments, spills, constants, the tanh loop, store and reload.

## Tried (cold full run, ratio to base, higher is faster; mixed / cap, medians of 200-300 reps)

| Variant                                                                   | Mixed / cap          | Verdict |
|---------------------------------------------------------------------------|----------------------|---------|
| Touch address by `min` instead of the compare, copy and move              | 0.995 / 0.988        | no |
| Dense layers with stepped pointers, no index list                          | 0.998 / 0.954 (in-core 1.03 / 1.015) | no, burst of touches |
| Same on top of the bundle below                                            | 0.996 / 0.982 (in-core 1.035 / 1.04) | no |
| Touches also in the tanh loop (1 or 2 lines per vector)                    | 0.970 / 0.973, 0.938 / 0.939 | no |
| Next brain's compaction during the current brain (lookahead, exact)        | 0.84-0.89 cold, 0.935 in-core | no, the layer-0 loop exit was predicted from the compaction branches just before it |
| Compaction by two 256-entry byte tables per 16 inputs (instead of 4 nibble steps) | 1.010 / 1.012 alone, +0.4% / +0.1% on top of the bundle | not built |
| Tanh as a helper function called per vector                                | 0.995 / 1.019 (in-core 1.00) | no, V8 does not inline it and reloads the constants |
| Single-group fast path in the column loop                                  | neutral              | no |
| Constants from a table in memory instead of nine `v128.const` per layer    | 1.013 / 1.014        | in the bundle |
| `v128.andnot` for the absolute value in tanh                               | 1.006 / 1.000        | in the bundle |
| Tanh on the accumulators before the store (no store, loop and reload)      | +2.5% / +4.2% with the two above | in the bundle |
| Layer loop inside one function (no `$layer` call, 10 arguments)            | +5.8% / +5.7%        | in the bundle |
| Compaction inline in that function                                         | +6.7% / +8.1%        | in the bundle |
| Brain loop in the same function                                            | +7.4% to +9.1% / +10.1% | in the bundle |

## The bundle
`brain.wat` is one function: per brain the compaction (inline), then the layer loop with the column groups, the two passes of the first layer from idea 125, tanh on the accumulators and the store. The nine tanh constants are splat vectors at `tab + 272`, written by `WasmBrainBank`'s constructor. Same adds in the same order, same tanh operations (`andnot` with the sign mask is the absolute value), so outputs are bit-identical. The wat grows from 291 to 460 lines, 130 of them the repeated tanh on 1 to 6 accumulators.
General: any layer size, ray count and layer count; the constants table is 144 bytes in the 512 reserved after the shuffle tables.

Kernel harness on the split-block kernel (after merging idea 125, 200 reps, hash equal), p25 and ratio to the merged base: mixed cold 4.092 to 3.820 ms (1.071x), in-core 2.989 to 2.685 (1.113x); cap cold 3.976 to 3.629 (1.096x), in-core 3.170 to 2.898 (1.094x).

## liveBench (`--seconds 60 --profile`, taskset 2,3,6,7, nice 19, 3 alternating pairs, base = perf-live at 6935157, load 20-25)

| Case  | Build | cpuMsPerTick                         | brain forward ms             | senser ms | peak RSS MB   | fingerprint |
|-------|-------|--------------------------------------|------------------------------|-----------|---------------|-------------|
| mixed | base  | 11.535, 11.487, 11.385 (med 11.487)  | 4.409, 4.405, 4.385          | 4.119     | 221, 219, 218 | 708687555   |
| mixed | yours | 11.349, 11.342, 11.551 (med 11.349)  | 4.185, 4.191, 4.351          | 4.118     | 216, 220, 218 | 708687555   |
| cap   | base  | 13.089, 13.195, 12.944 (med 13.089)  | 4.155, 4.169, 4.107          | 5.025     | 253, 257, 254 | 10334191    |
| cap   | yours | 12.713, 12.547, 12.684 (med 12.684)  | 3.831, 3.761, 3.814          | 4.983     | 256, 257, 257 | 10334191    |

Ratio of medians: tick 1.012 mixed / 1.032 cap; brain forward 1.051 / 1.089 (-0.21 / -0.34 ms). Brain forward is faster in 3 of 3 pairs in both cases. Peak RSS within the run spread (+1 to +3 MB at the cap, the code is bigger).

Earlier, on the kernel before idea 125, the same bundle (and even its smaller steps) came out with the senser +0.3 to +0.4 ms, eat +0.1 to +0.15 and steer +0.03 slower in six runs of two orders while the brain phase gained 0.35 ms mixed and 0.05 ms cap, so the tick was flat to 4% worse; a 120 s run with 10 s windows showed it persisting. After merging idea 125 the effect is gone (senser 4.98-5.07 against 5.03-5.08). Cause not found (thread CPU of the V8 workers was equal); no build of the old kernel is left to check, so treat the pre-125 tick numbers as a warning that this kind of code-size change should always be paired in the tick, not only in the harness.

## Tests
`npx vitest run wasm brain resident thinkEvery --maxWorkers=2 --testTimeout=180000`: 9 files, 135 tests, exit 0. Full suite (`npx vitest run --maxWorkers=2 --testTimeout=180000`): 1255 of 1260 passed, exit 1; the 5 failures are `cli.test.ts` cases that hold their own 20 s timeout and `liveReset` "packing the save took too long", all load timeouts. Rerun of `cli liveReset` alone: liveReset passes, the 4 cli cases still time out at 20 s, and the perf-live worktree without this change fails 3 of the same cli cases the same way. `npm run wasm` exit 0, generated file in sync.

## Verdict
Merge. Exact, general, +1.2% tick mixed and +3.2% cap in three alternating pairs, no other phase worse. It clears the 1.5% bar at the cap. The remaining budget is the add chain of the column loops (core latency), the touch stream (worth 11-18% of the cold time) and the 20% of per-layer overhead that is left inside one function (dispatch, descriptor reads, bias loads); the quad idea (`quad.md`) is the way to overlap brains and would need to be rebuilt on this function.
