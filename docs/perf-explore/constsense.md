# In-loop SIMD constants in locals for the other kernels (idea 93)

Branch `pl-constsense` (perf-live 2a55d98, then perf-live merged; the engine is the same as perf-live 07ca726). Change in `sense.wat` (+19 -9) and `members.wat` (+9 -5), plus the regenerated kernels.
Question: idea 92 (`scout-brain.md`) found that V8 rebuilds a non-zero `v128.const` at every use inside a loop. Do the other kernels have the pattern, and does hoisting it pay?

## What V8 does (`--print-wasm-code`, Node 24, TurboFan)
- A non-zero, non-all-ones `v128.const` in a loop is rebuilt per use: `vpcmpeqd; vpsrlq; movq r10, imm; vpinsrq` (4 instructions for `i32x4 -1 1 2 3`), `movq r10, imm; vmovq; vpunpcklqdq` (3) for uniform ones.
- `f32x4.splat (f32.const 1)` is folded to a constant and rebuilt the same way inside loops with calls or register pressure (4 instructions), though a tiny test loop hoisted it.
- A `v128.const` kept in a local set before the loop is built once, also in the large `sense` function.
- All-zero and all-ones vectors are single zero idioms (`vpxor`, `vpcmpeqd`). Nothing to gain.
- Scalar `f64.const` and `f32.const` are hoisted in small loops. In the large `sense` function `f64.const 1` is still rematerialized (`vpcmpeqd; vpsllq 54; vpsrlq 2`) in some places. Left alone: it costs 3 instructions per use in the hit path only, and whether a local helps for scalars is untested.
- `crowd.wat`, `fill.wat` and `step.wat` have no `v128.const` in loops, and their scalar constants were hoisted. No change.

## What changed
- `sense.wat`: the one-hot lane pattern `i32x4 -1 1 2 3` and the `f32x4` 1.0 mask go into locals in `$emit`, `$emitClo` and the main hit path (before `$wl`). The species-flag loop takes its 1.0 from the same local. In the ray-pair candidate loop, `i64x2 -1 0` (odd last pair) and `i64x2 3 3` (rock kind) go into locals set before the pass loop. In `$emit` the 9 constant instructions per ray are gone (checked in the code dump).
- `members.wat`: the mulberry step vector of `mutateScan` goes in a local, and `$draw4` takes its `1` and `61` vectors as parameters from locals (V8 inlines it).
- Bits: every value is the same constant, so results are bit-identical.

## Whole tick (cpuMsPerTick, `--profile`, perf-live worktree as base, alternating pairs)

Two rounds of 3 pairs per case. Round 1 at load 20-30, round 2 after the perf-live merge (same engine), load 7-21.

| Case              | Round | cpuMsPerTick base       | constsense              | Tick ratio | senser base          | senser constsense    | Fingerprint    |
|-------------------|-------|-------------------------|-------------------------|------------|----------------------|----------------------|----------------|
| 4 founders x 800  | 1     | 12.09, 12.73, 12.02     | 12.15, 11.84, 11.79     | 1.021x     | 4.46, 4.59, 4.45     | 4.44, 4.33, 4.32     | 708687555 both |
|                   | 2     | 11.82, 11.76, 11.75     | 11.58, 11.83, 11.83     | 0.994x     | 4.39, 4.35, 4.36     | 4.26, 4.29, 4.36     |                |
| Juggernaut x 4900 | 1     | 14.35, 14.36, 14.45     | 14.28, 14.50, 14.51     | 0.990x     | 5.57, 5.51, 5.50     | 5.46, 5.50, 5.48     | 10334191 both  |
|                   | 2     | 14.00, 14.23, 14.32     | 14.11, 14.17, 14.28     | 1.004x     | 5.43, 5.49, 5.51     | 5.39, 5.40, 5.44     |                |

The senser is faster in all 12 pairs, by 0.01 to 0.26 ms. The median gain is 0.07-0.13 ms mixed (1.6-2.8%) and 0.03-0.09 ms at the cap (0.5-1.6%). The tick is equal within noise (0.990-1.021x). Brain forward is unchanged code and moved by about 0.1 ms either way, which is the run-to-run spread. Peak RSS 214-221 against 217-221 MB (mixed), 252-259 against 252-257 MB (cap).

## Tests
`npm run wasm` (exit 0). `npx vitest run wasm sense crowd step resident --maxWorkers=2`: at the default 20 s timeout 6 tests timed out (load 21, durations 27-63 s), and no assertion failed. With `--testTimeout=180000`: 6 files, 102 tests, exit 0.

## Verdict suggestion
Exact and small (28 lines), so it is harmless to merge. The senser gains about 1-2%, the tick gains below the 1.5% bar, and the cap case is flat. Merge as hygiene with the idea 92 pattern, or reject as below the bar; it is not worth a release note on its own. The remaining rebuilt constants are scalar `f64.const 1` uses in the sense hit path, about 3 instructions per hit. They are not worth chasing.
