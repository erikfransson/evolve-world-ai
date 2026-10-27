# Step kernel at the live setting: cost per part and exact cuts

Branch `pl-stepk`. Question: where do the 1.26 ms of `memory and steer` go at 3300 creatures on The Inland Sea (about 0.35 us per creature), and what can be cut exactly (fingerprints 708687555 and 10334191 unchanged)?

Method: scratch copies of `step.wat` with one part cut, run over the live memory at tick 400 (4 founders x 800 copies, 3331 creatures). Row state restored before every call, 32 MB cache sweep before every call (the brain forward evicts like that), variants interleaved, 100 to 150 reps, p25 of CPU ms, nice 19, load 14 to 16. Scripts in the session scratchpad (`sk/split.ts`, `sk/cnt.ts`).

Harness trap: the unmodified module (same bytes as the one running in the world) measured 1.65 ms while any copy with one added `nop` or unused local measured 1.26 ms, yet in liveBench the `nop` build is identical to the base (1.36 vs 1.36). So only variants compared with the `nop` reference (1.26 to 1.33) are valid, never with the unmodified module.

## Cost per part (ms per call, delta to the `nop` reference, 3331 creatures)

| Part cut                                          | ms per call | Delta  | Share | ns/creature |
|---------------------------------------------------|------------:|-------:|------:|------------:|
| Reference (`nop`)                                 | 1.33        |        |       | 400         |
| sin and cos host calls (constants instead)        | 0.85        | -0.48  | 36%   | 144         |
| of that, Math.sin/cos work (host call kept)       | 1.16        | -0.17  | 13%   | 51          |
| of that, the two wasm to JS transitions           |             | -0.31  | 23%   | 93          |
| keepOut (call, early-out, rare full path)         | 1.03        | -0.30  | 23%   | 90          |
| of that, only the raster byte (index constant)    | 1.15        | -0.18  | 13%   | 54          |
| of that, rock full path (1.2% of creatures)       | 1.27        | -0.06  | 4%    | 18          |
| memory units loop                                 | -           | -0.14  | 11%   | 42          |
| motion (velocity, drag, position)                 | -           | -0.14  | 11%   | 42          |
| energy                                            | -           | -0.05  | 4%    | 15          |
| wall clamps (2 calls)                             | -           | -0.02  | 2%    | 6           |

Counters in the kernel copy: turn rate is exactly 0 for 0 of 3331 creatures, so skipping sin and cos for an unchanged heading never fires. The rock full path runs for 39 creatures (783 disc tests, no push out). Folding both trig results into one host call that writes to memory was slower (1.51 vs 1.33), rejected. A software prefetch of the next row gave nothing once the harness trap was accounted for.

## Cuts

1. The clear-of-rock raster as one bit per square instead of one byte (`stepKernel.ts` packs it, `step.wat` tests the bit). Exact: same boolean, 8 times fewer cache lines for the random lookup (624 KB to 78 KB at 4 species on the Inland Sea).
2. sin and cos in WASM (fdlibm port, `trig.md`): would remove up to 36% of the phase (0.5 ms, 3% of a tick) minus the port's own 55 to 80 ns per pair, so about 0.2 ms net (1.3% of the tick). Not done: bit equal to Node's Math only, not to Chrome, which breaks the "equal on every engine" rule of this kernel; needs an engine probe and a fallback. Left as an option for Erik.

## Results (liveBench `--profile`, 60 s, alternating base/yours in the same worktree, 3 to 4 pairs)

The `stepk` worktree ran 0.8 ms slower in `senser` than the `perf-live` worktree for identical code (6.1 vs 5.3, reproducible, cause unknown), so base and yours were both run from `stepk` (yours = the patch applied).

| Case                  | Phase base (ms)                  | Phase yours (ms)                 | Phase delta | Tick base (median) | Tick yours (median) | Fingerprint | Peak RSS |
|-----------------------|----------------------------------|----------------------------------|------------:|-------------------:|--------------------:|------------:|---------:|
| Inland Sea, 3300      | 1.360 1.363 1.375 1.255          | 1.290 1.285 1.168 1.215          | -0.11 (8%)  | 15.61              | 15.08               | 708687555 equal | 218 vs 215 |
| Juggernaut, 4900      | 1.708 1.713 1.727                | 1.573 1.561 1.585                | -0.14 (8%)  | 19.27              | 19.37               | 10334191 equal  | 253 vs 254 |

The phase gain is consistent in every pair, 0.6 to 0.7% of the tick. The whole tick pairs are inside the noise (senser jitters by 0.8 ms between runs).

## Verdict

Under the 1% bar. The phase is flat: no single part above 0.5 ms and the only large one (trig host calls) cannot be removed exactly on every engine. Suggest rejecting, or taking the bit raster only as a free 12 line cleanup if a later merge wants every 0.1 ms.
