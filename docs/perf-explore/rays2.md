# Sense kernel per-ray passes two rays at a time (idea 21)

Exact. Fingerprints 708687555 (4 founders x 800) and 10334191 (`--only juggernaut --copies 4900`) unchanged. Branch `pl-rays2`, base `perf-live` cb26386.

## What

`sense.wat`, two passes moved to f64x2, each lane the same expression in the same order as the scalar code (mul, sub, add, div, demote are lane-wise IEEE, no fused or relaxed ops):
- Directions by angle addition: two rays per step from the cos and sin tables, an odd last ray in scalar (so no read past the offset table).
- Closeness and crowd inputs: closeness `1 - best/L` with `v128.andnot` on a kind-0 mask (gives +0.0 as the scalar branch), the f32 direction and start distance demoted two at a time and stored with `v128.store64_lane`. An odd count computes one stale scratch ray at index nR (at most 63, scratch holds 64), which the padding loop overwrites and nothing reads.

Not done:
- Merge and feature writes two at a time (crowd-hit closeness in f64x2, per-lane stores, second lane guarded): built and measured, no gain over the two passes above (tick 400 +0.09 ms, tick 1500 0.00), dropped. The pass is bound by the input stores, not arithmetic.
- Item and rock ray tests: already two rays per candidate with the f64x2 prefilter; the exact test runs on about 3 rays per creature, nothing to pair.
- Wall loop: runs for 1.8% of creatures.

## Kernel (snapshot harness of `senselive.md`, snapshots retaken on cb26386, cold, interleaved, 150 reps, `--no-liftoff`, load 11)

Brain inputs of all 3331 / 3294 creatures hash equal to the base kernel (b101b365, 50357cc0) after poisoning the input with NaN. Ray counts 8, 12 and one creature with 7 (odd path covered).

| Variant                 | t400 p25 (run 1 / 2 / 3) | t1500 p25 (run 1 / 2) |
|-------------------------|--------------------------|-----------------------|
| base                    | 4.430 / 4.433 / 4.482    | 3.855 / 2.663         |
| both passes (branch)    | 4.345 / 4.376 / 4.393    | 3.794 / 2.587         |
| directions only         | 4.450                    | 3.853                 |
| closeness only          | 4.472                    | 3.850                 |
| both + merge pairs      | 4.483                    | 2.587                 |

Both passes: -0.06 to -0.09 ms, about 2% of the kernel; each alone is within noise.

## Whole tick (liveBench, nice 19, 60 s, 3 alternating pairs, base = `perf-live` worktree)

cpuMsPerTick:

| Case              | Base                                 | Yours                                | Ratio of medians |
|-------------------|--------------------------------------|--------------------------------------|-----------------:|
| 4 founders x 800  | 13.149, 13.189, 13.054 (med 13.149)  | 13.042, 12.993, 13.071 (med 13.042)  | 0.992            |
| juggernaut x 4900 | 15.850, 15.776, 14.063 (med 15.776)  | 15.774, 12.213, 15.728 (med 15.728)  | 0.997            |

The 4900 case has one low outlier on each side (load). Peak RSS 215-232 vs 215-219 MB (800), 254-256 vs 251-256 MB (4900): unchanged.

`--profile` pairs (4 founders x 800), senser ms: base 4.77, 4.85, 4.86; yours 4.74, 4.74, 4.82 (-0.06 ms, 1.3% of the phase, 0.5% of the tick). Whole profile run 13.14, 13.14, 13.16 vs 12.96, 13.08, 13.07.

## Tests

`wasmKernels` (includes the drift test), `sensors`, `rayRecast`, `residentBodies`, `wasmStep`, `wasmCrowd`: 93 of 93, exit 0. Full suite `--maxWorkers=2 --testTimeout=180000`: 121 files, 1219 tests, exit 0.

## Verdict suggestion

Reject: exact and small (+32 / -21 lines of wat), but 0.3-0.8% of the tick, under the 2% bar. The per-ray passes are not arithmetic bound; what they cost is memory and loop overhead, which pairing does not touch.
