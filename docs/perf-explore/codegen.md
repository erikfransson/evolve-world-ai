# Codegen audit of the kernels' hot loops under V8 13.6 (idea 94)

Exact (fingerprints equal), tick 1.008x mixed and 1.010x at the cap, inside the noise. Branch `pl-codegen`, base `perf-live` 2119b5b (ideas 88, 90, 92 merged).

## How

- Machine code: `node --print-wasm-code src/liveBench.ts --seconds 20` with normal tier-up, so the dump holds the TurboFan code the bench really runs, with V8's own inlining of the small helpers.
  For the audit only, the kernels were assembled with module-prefixed debug names (`brain_layer`, `sense_sense`, ...) so the functions can be told apart; the committed kernels are unchanged in that respect.
- Where the time goes: `node --prof --prof-sampling-interval=250` in the same run, tick pcs mapped onto the dumped instruction offsets (14.6k samples; the scripts stop at the `Safepoints` section, whose lines look like instructions).
- Per loop: innermost backward-branch ranges, instructions per iteration normalised by V8's unroll factor (2-4x), rbp-relative operands counted as spills.

## Findings per kernel

Share is of all bench samples (setup included) on ef5a416, before ideas 88, 90 and 92; per-iteration counts are on base 2119b5b, before and after this branch.

| Kernel, loop                              | Share | What the code shows                                                                                                  | Fix                                             | Instr per iteration   |
|-------------------------------------------|------:|----------------------------------------------------------------------------------------------------------------------|-------------------------------------------------|-----------------------|
| brain `$layer` column loops (1-6 vectors) | 13%   | no spills, no bounds checks; `f32x4.splat (f32.load)` is `vmovss` + `vbroadcastss xmm,xmm` (an extra shuffle uop)     | `v128.load32_splat` (one `vbroadcastss xmm,[m]`) | 20/23/26/29/24.8/27.8 to 19/22/25/28.3/23.8/27.0 per input |
| brain `$layer` tanh, `$compact`           | 5%+2% | the rebuilt `v128.const` of idea 92 (fixed there)                                                                     | none here                                       | -                     |
| sense item walk                           | 6%    | stall after the first `itemStart` and item XY loads of each row (memory latency); `-margin` rebuilt in one unrolled copy | `$nmargin` and `$open` (= not wedge) in locals  | 40.3 to 38.7          |
| sense crowd walk (feature pass)           | 1.5%  | 1.7 spill loads per candidate, `-marginc` rebuilt (`movq r10` + `vxorps`), `eqz wedge` per candidate               | same locals                                     | 45.7 to 44.0, spills 1.7 to 1.3 |
| sense early-out crowd walk                | <1%   | same pattern                                                                                                          | same locals (unroll 3x to 4x)                   | 39.7 to 38.2          |
| sense ray tests, emit, fills              | 4%    | ideas 88 and 93 (exact test pairs, inline zero fills, constants)                                                      | none here                                       | -                     |
| crowd `rebuild` key loop                  | 0.7%  | `f64.convert_i32_s cols` per creature; f64 `select`s compiled as branch diamonds (kept: min/max differ on NaN and -0) | `$colsF` hoisted                                | 47 to 46              |
| crowd `rebuild` sorted loop               | 1.2%  | five array bases reloaded from the param block per creature; stall on the row load                                    | bases in locals (V8 keeps some on the stack)    | 41 to 38, base loads 9 to 6 |
| crowd `refresh`                           | 0.4%  | the same convert                                                                                                      | `$colsF`                                        | 72 to 70              |
| crowd `firstItem` (touch)                 | 2.3%  | `C_ITEM_XY` reloaded per item; stalls on the start and XY loads                                                       | hoisted                                         | 22 to 20.7 per item   |
| step unit loop                            | 1.5%  | rate `select` is a branch, two rate loads per unit, stalls on the units and output loads                              | tried and reverted: same count (73), loads become moves | 73 to 73        |
| fill `fill` and `prepare`                 | 3.3%  | stalls on the first unit load and the raster bytes; the 5-trip extras loop is unrolled 4x, not fully                  | none (memory bound)                             | -                     |
| members, sweep, pack                      | <1.5% | not hot                                                                                                               | none                                            | -                     |

Not found anywhere: explicit bounds checks (32-bit memories use guard regions), i64 where i32 would do, f64/i32 conversions in hot loops beyond the data's own promote and demote.
Present everywhere and not removable from the source: one `cmpq rsp,[r13-0x60]` stack check per unrolled loop group, `i32.trunc_sat` as five instructions plus two branches (per creature, never per item), and a dead `movl` before `cmpl [m],r` for `i32.ne (i32.load ..) x` in the crowd walks.
The hot spots outside the brain are load stalls at the first touch of a creature's data (item rows, units block, raster), not instruction count, so codegen fixes there move little.

## Numbers (liveBench `--profile --seconds 60`, taskset 2,3,6,7, nice 19, 3 alternating pairs, load 18-23)

| Case  | Build | cpuMsPerTick                        | senser                | brain forward         | crowd grid            | eat                   | peak RSS MB   | fingerprint |
|-------|-------|-------------------------------------|-----------------------|-----------------------|-----------------------|-----------------------|---------------|-------------|
| mixed | base  | 11.796, 12.034, 11.906 (med 11.906) | 4.358, 4.446, 4.408   | 4.319, 4.375, 4.330   | 0.188, 0.198, 0.192   | 1.066, 1.083, 1.080   | 218, 221, 216 | 708687555   |
| mixed | yours | 11.971, 11.817, 11.661 (med 11.817) | 4.451, 4.376, 4.347   | 4.332, 4.304, 4.210   | 0.189, 0.180, 0.182   | 1.078, 1.070, 1.057   | 215, 219, 216 | 708687555   |
| cap   | base  | 14.412, 14.349, 14.392 (med 14.392) | 5.530, 5.551, 5.513   | 4.478, 4.405, 4.462   | 0.425, 0.416, 0.441   | 1.443, 1.427, 1.439   | 258, 255, 256 | 10334191    |
| cap   | yours | 14.399, 14.251, 14.217 (med 14.251) | 5.501, 5.492, 5.453   | 4.482, 4.391, 4.430   | 0.428, 0.421, 0.407   | 1.445, 1.430, 1.413   | 255, 256, 252 | 10334191    |

Ratio of medians: tick 1.008 / 1.010, senser 1.007 / 1.007, brain 1.006 / 1.007, crowd grid 1.055 / 1.010, eat 1.009 / 1.006 (mixed / cap).
Each phase is faster in 4 to 5 of the 6 pairs, by 0.5-1%, which matches the 1-4% fewer instructions in loops that are part of each phase. The first set of pairs was void: perf-live moved from ef5a416 to 2119b5b during it, so the base already had ideas 88, 90 and 92.

## Tests

`npx vitest run wasm sense crowd step resident thinkEvery --maxWorkers=2`: 108 of 110 passed, exit 1, the two failures were 20 s timeouts at load 23 (`residentBodies` Inland Sea, `wasmStep` Inland Sea; neither kernel changed). Rerun with `--testTimeout=180000`: 30 of 30 passed, exit 0. `npm run wasm` exit 0, generated file in sync.

## Verdict suggestion

Merge as a small exact cleanup (brain.wat 6 lines, sense.wat 13, crowd.wat 15, all general to every ray count and layer width), expected about 0.1 ms per tick, below what a 3-pair run can prove.
The audit closes the "cheap codegen" lever: after idea 92 the remaining instruction-bound loop is the brain column loop, at 19-27 instructions per input with no waste left that wat can remove (index load, two address computations, the loads, mul and add, the touch).
