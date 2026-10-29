# Native sense kernel: a C++ AVX2 twin of sense.wat, bit-identical

Branch `pl-nsense`, prototype in `scripts/native-sense/` only (`sense.h`, `harness.cc`, `addon.cc`, `snap.ts`, `ref.ts`, `bench.ts`, `Makefile`); nothing in `src/` or the server changed, not wired in.
Question: how much does a hand-written native sense kernel gain over V8's code for sense.wat, with the brain inputs bit-identical?

## How

- `sense.h`: a port of sense.wat on the same linear memory (reads the param block, records, item rows, rock tables, crowd arrays, offset tables in place and writes the inputs where the wat does). Every float op is the wat's, per value in the same order; `-O2 -mavx2 -ffp-contract=off`, no FMA. wasm semantics kept where C differs: saturating truncation, `f64.max`/`f32x4.max` NaN and signed zero.
- Variants: v0 exact port with the wat's own 128-bit lanes (the control); v1 AVX2 lanes (directions and closeness 4 x f64, the item prefilter 4 rays per group instead of 2, crowd rays 8 per ymm, 12 as ymm plus xmm); v2 = v1 plus prefetch of the next creature's offset table and input row; v3 = v1 plus the item and crowd row walks 4 entries per branch-free block (masked lanes, records written by a 4x4 transpose); v4 = v3 plus v2's prefetch; v5 = v3 plus prefetch of the next creature's item and crowd rows.
- `snap.ts` dumps the whole memory at the sense call of tick 400 and 1500 of the live world (4 founders x 800, `liveConfig`, seed 1), as `senselive.md` did; `ref.ts` runs the production `SENSE_BYTES` on it (inputs poisoned with NaN, ray scratch 0xff) and writes the memory after the call.
- `harness` (standalone C++) compares every byte of the memory after each variant with the wat's; `bench.ts` loads the same snapshot, runs the wat and the variants (through the N-API `sense.node`) interleaved in rotating order in one process, user+system CPU per call, p25 of 80, cold = 32 MB sweep before each call, hot = none.
- Machine: i7-1165G7, pinned to CPUs 2,3,6,7 (two cores with their hyperthreads), load 14-16 from other agents. Hot and cold came out within 5% here (senselive.md saw 1.5x), so the shared caches were cold for both; only same-run ratios count.

## Bit-equality

All six variants: 0 input words differ from the wat, both snapshots (3331 and 3294 creatures, 75% with 8 rays, 25% with 12, walls 1.8%, rock 4.5%).
v0 to v2 leave the whole 45 MB memory byte-identical; v3 to v5 differ only inside the candidate scratch (66-107 bytes of records past the kept ones, never read).
Not covered by the snapshots: detail records (no viewer, `det` = 0) and strides other than 6 (one species flag). The 4-entry walks read up to 3 entries past a row, so a deployed v3 would need 32 bytes of padding after the item arrays.

## Kernel time (bench.ts, ms per call, p25; ratio = wat / variant, same run)

| Snapshot, run | Mode | wat (V8) | v0 wat lanes  | v1 AVX2       | v2 +prefetch  | v3 walk4      | v4 walk4+pf   | v5 walk4+rows |
|---------------|------|---------:|---------------|---------------|---------------|---------------|---------------|---------------|
| t400, 1       | cold | 5.00     | 4.64 (1.08x)  | 4.27 (1.17x)  | 4.34 (1.15x)  | 4.42 (1.13x)  | 4.50 (1.11x)  | 4.56 (1.10x)  |
| t400, 2       | cold | 4.90     | 4.44 (1.10x)  | 4.15 (1.18x)  | 4.24 (1.16x)  | 4.25 (1.15x)  | 4.42 (1.11x)  | 4.54 (1.08x)  |
| t1500, 1      | cold | 4.21     | 3.82 (1.10x)  | 3.55 (1.19x)  | 3.66 (1.15x)  | 3.88 (1.08x)  | 3.92 (1.07x)  | 4.07 (1.03x)  |
| t1500, 2      | cold | 4.29     | 3.87 (1.11x)  | 3.60 (1.19x)  | 3.72 (1.15x)  | 3.91 (1.10x)  | 4.00 (1.07x)  | 4.15 (1.03x)  |
| t400, 1       | hot  | 4.80     | 4.35 (1.10x)  | 4.10 (1.17x)  | 4.15 (1.16x)  | 4.21 (1.14x)  | 4.31 (1.11x)  | 4.38 (1.10x)  |
| t400, 2       | hot  | 5.04     | 4.63 (1.09x)  | 4.27 (1.18x)  | 4.35 (1.16x)  | 4.42 (1.14x)  | 4.54 (1.11x)  | 4.64 (1.09x)  |
| t1500, 1      | hot  | 4.28     | 3.83 (1.12x)  | 3.59 (1.19x)  | 3.68 (1.16x)  | 3.85 (1.11x)  | 3.93 (1.09x)  | 4.10 (1.04x)  |
| t1500, 2      | hot  | 4.37     | 3.90 (1.12x)  | 3.67 (1.19x)  | 3.74 (1.17x)  | 3.92 (1.12x)  | 4.03 (1.09x)  | 4.20 (1.04x)  |

The standalone harness agrees (t400, C++ only): v0 4.56, v1 4.26, v3 4.37 ms cold; `-O3 -march=x86-64-v3` instead of `-O2 -mavx2` changes nothing (v0 4.57, v1 4.19).

Reading:
- The control already gains 1.08-1.12x, unlike `aot.md` (wasm2c output, 0.92-1.01x unchecked): a hand port keeps values in registers across the creature and has no memcpy loads, but V8's code for the same 128-bit lanes is within about 10% of gcc's.
- Wider lanes add about 7% more (v1, 1.17-1.19x): the crowd ray pass is one ymm for 8 rays, and the item prefilter and the f64 per-ray passes take half the groups.
- Branch-free 4-entry walks lose 2-8% against v1, and every prefetch loses (light 1-3%, rows 5-10%): as in `senselive.md`, the walks are neither item nor miss bound enough for extra instructions to pay. More of the kernel is scalar control (row loops, the per-candidate exact test, the feature writes) than lane width can reach.

## Projected tick gain (not measured in liveBench, nothing is wired)

v1 saves 0.65-0.76 ms per call (cold p25). With the senser phase at about 36% of a 13 ms tick (4.7 ms, the kernel most of it), that is about 0.7 ms per tick, 1.05-1.06x.
For comparison `native.md`'s brain addon gave 1.15-1.17x per tick for the same build step and review cost.

## Verdict suggestion

Bit-identical is easy (zero input words differ on both snapshots, first try), the speed is not there: 1.18x on the kernel, about 5% of a tick, with a second sense kernel to keep in step with every sense.wat change (rock, species, crowd features) and a C++ reader of attacker-shaped tables (offsets, counts, row starts) on the server, which falls under the 3-review gate.
Not worth it alone. If the native brain addon of `native.md` is adopted, v1 could ride along in the same addon and build for the extra 5%, after a random-input equality test (detail records, other strides, edge positions) and bounds checks on every table read.

Reproduce (in `scripts/native-sense/`, with the machine wrapper): `node snap.ts 400 data/m400.bin`, `node snap.ts 1500 data/m1500.bin`, `node ref.ts data/m400.bin data/r400.bin` (same for 1500), `make`, `./harness data/m400.bin data/r400.bin 60`, `node bench.ts data/m400.bin 80` (`VARS=0,1` picks variants).
