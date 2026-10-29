# Idea 136: emit, early-out, directions and wall stages (emitstage)

Branch `pl-emitstage` from `perf-live` 9a861ba (idea 126 and the later merges in). Exact, fingerprints equal (708687555 mixed, 10334191 cap). Only the plain emit and the crowd merge had anything to cut.

## Budget (call 300, 3200 / 4900 creatures)

Counters (exported globals in a kernel copy, one call):

| Count per creature                                                    | Mixed  | Cap   |
|-----------------------------------------------------------------------|-------:|------:|
| Rays (odd ray count: 3 of 3200 / 1 of 4900 creatures)                 | 9.0    | 8.0   |
| Wall in range (wall pass runs per ray)                                | 1.8%   | 1.7%  |
| Early-out rejected by an item or rock candidate (the first test)      | 84.1%  | 71.8% |
| Early-out rejected by wall / detail record first (walls tested first would catch the same) | 0.4% / 0% | 0.6% / 0% |
| Reaches the crowd walk (early-out attempted)                          | 15.5%  | 27.6% |
| Early-out taken / walk found a creature                               | 13.3% / 2.2% | 23.6% / 4.0% |
| Emit calls (plain path plus unseen) / all rays kind 0 in the call     | 2555 / 37.5% | 3328 / 35.9% |

Kernel harness (sense.wat variants alternated on one state, p25 ms, hash checked, 80 reps) against base 3.49 / 4.49 ms:

| Variant                                                          | Mixed  | Cap    | Exact |
|------------------------------------------------------------------|-------:|-------:|-------|
| `$emit` removed from the plain path (bound)                      | -0.31  | -0.38  | no    |
| `$emit` body empty (call only)                                   | -0.42  | -0.43  | no    |
| `$emit` writes only the zero fill (stores to the input lines)    | -0.21  | -0.20  | no    |
| `$emit` computes, stores go to a hot scratch line                | -0.07  | +0.02  | no    |

So the plain emit is 0.42 ms (12% of the kernel), the stores into the input lines are about 0.2 of it (idea 107: first touch), the rest is compute that can move.

## Built (`sense.wat`, +48 -3)

- `$emit` at stride 6 does two rays per step: closeness for the pair as one `f64x2` division (`andnot` of the kind-0 mask, same bits as the scalar branch), `demote_f64x2_zero`, one-hot for both rays, and the 48 bytes as three `v128` stores through `i8x16.shuffle`. The odd last ray and every other stride take the old loop, whose zero tail is now `v128` stores plus `i32` remainder (any feature count).
- The merge loop (crowd path, seen creature or unseen with detail) has a copy for no detail record and stride 6: a branch on the seen creature instead of the selects and loads of slot 0, no detail branch, a fixed 24-byte step. The old loop stays for detail records and other strides.

## Strides
`rayFeatureCount(config)` (sensors.ts) is 4 without creature sight, otherwise 5 + S for S species (at least 6: closeness, food, poison, wall, S species flags, seen energy). The pair emit and the lean merge copy run at stride 6 only (one species, the live world). Every other stride (4, and 7 and up for several species) takes the old per-ray loops, which are the same code as before apart from the zero tail now written as `v128` stores plus `i32` remainder; the kernel tests check one species (stride 6) and three (stride 8) against the JS encoding; stride 4 (no creature sight) is not used by the ecosystem kernel and has no test. Extending the pair path to other strides would need a different shuffle per stride (the pair is 48 bytes only at 6), so it was not done.

## Kernel harness, 3 alternating runs (p25 ms, hash equal: mixed 10b91cba, cap 4cc9bd68)

| Case  | Run | base  | new   | delta  |
|-------|-----|------:|------:|-------:|
| mixed | 1   | 3.488 | 3.354 | -0.134 |
| mixed | 2   | 3.586 | 3.458 | -0.128 |
| mixed | 3   | 3.469 | 3.358 | -0.111 |
| cap   | 1   | 4.486 | 4.349 | -0.137 |
| cap   | 2   | 4.621 | 4.467 | -0.154 |
| cap   | 3   | 4.803 | 4.608 | -0.195 |

Pieces (single runs, noisy): pair emit -0.04 to -0.10 mixed and -0.05 to -0.11 cap, merge copy on top -0.07 and -0.05.

## Whole tick (`liveBench --profile --seconds 60`, taskset 2,3,6,7 nice 19, 3 alternating pairs, base = frozen worktree at 9a861ba)

| Case  | Build | cpuMsPerTick                    | senser ms                | brain forward ms    | peak RSS MB | fingerprint |
|-------|-------|---------------------------------|--------------------------|---------------------|-------------|-------------|
| mixed | base  | 11.126, 11.271, 11.398 (11.271) | 3.970, 4.029, 4.069 (4.029) | 4.286, 4.328, 4.360 | 215, 217, 217 | 708687555 |
| mixed | new   | 11.122, 11.387, 10.931 (11.122) | 3.917, 4.005, 3.845 (3.917) | 4.301, 4.397, 4.243 | 220, 222, 222 | 708687555 |
| cap   | base  | 13.059, 13.275, 13.121 (13.121) | 5.007, 5.082, 5.018 (5.018) | 4.136, 4.174, 4.208 | 255, 254, 251 | 10334191  |
| cap   | new   | 12.904, 13.010, 12.966 (12.966) | 4.861, 4.919, 4.880 (4.880) | 4.119, 4.182, 4.157 | 256, 256, 254 | 10334191  |

Ratio of medians (new / base): senser 0.972 mixed and 0.972 cap (faster in 6 of 6 pairs, -0.11 and -0.14 ms); tick 0.987 and 0.988, which is 1.0% and 1.1% of the tick by the senser delta. Brain forward is unchanged (0.994, 0.996). Peak RSS reads +2 to +5 MB on the new side; an identical-kernel control in the second worktree also read +1 to +4 MB, so it is worktree noise, not verified further.

Method note: comparing against the live `perf-live` worktree gave a false brain forward +7% on the new side, because `perf-live` had moved on (idea 125 and 128 merges) while the study ran. Base is the frozen worktree `emitstage-base` at 9a861ba, and the branch is rebased onto that head.

## Tried, dead (kernel harness, p25 change mixed / cap)

| Variant                                                                  | Mixed  | Cap    | Why |
|--------------------------------------------------------------------------|-------:|-------:|-----|
| All-kinds-zero test, then one zero fill (exact)                           | +0.10  | +0.17  | only 36% of emit calls are all zero, the branch is a coin flip and the test costs more than the fill saves |
| `$emit` inlined at the plain-path call site                              | +0.04  | -0.03  | a call is not the cost |
| Pair emit with a skip when both kinds are zero                           | 0      | 0      | the compute is not the bound, same as the branch-free pair loop |
| `$dirsPairs` init in its own loop (hoisted out of the pair loop)          | +0.07  | +0.05  | |
| Early-out reorder (wall or detail tests first)                           | -      | -      | the item and rock test already rejects 84% / 72%, wall and detail reject under 1%, and the f32 window is needed by both outcomes |
| Wall pass skip per ray                                                   | -      | -      | already skipped when no wall is within L (98% of creatures), wall creatures need the pass |
| Odd direction ray fused into the pair loop                               | -      | -      | 3 of 3200 and 1 of 4900 creatures have an odd ray count |

## Tests
- `npm run wasm` exit 0, generated file in sync.
- `npx vitest run wasm sense resident --maxWorkers=2 --testTimeout=180000`: 5 files, 107 tests, exit 0.
- Full suite (`--maxWorkers=2 --testTimeout=180000`): 122 files, 1258 of 1260 passed, exit 1. The two failures are load timeouts, `cli.test.ts` (bench fingerprint across thread counts, 20 s) and `liveReset.test.ts` ("packing the save took too long"). `vitest run cli liveReset --maxWorkers=1`: 26 of 26, exit 0.

## Verdict
Merge as a small exact win: senser -2.8% (0.11 to 0.14 ms), tick about -1.1%, under the 1.5% bar in either case but never worse and the brain unchanged. Remaining emit cost is the stores into the input lines; the other three stages have no exact cut left (counts above).
