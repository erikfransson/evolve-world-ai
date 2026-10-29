# Native brain kernel: brain forward as a Node addon with AVX2 and FMA3

Branch `pl-native`, prototype in `server/native/` only (`brain.cc`, `build.sh`, `brainBench.ts`, `hook.ts`); nothing in `src/` or the live server changed.
Question: how much faster is brain forward (5.2 of 15.2 ms per live tick) as a native addon on the WebAssembly memory, with 8-wide lanes, FMA and prefetch?

## How

- `brain.cc`: N-API addon, `forward(memory.buffer, descPtr, runPtr, n, variant)`, reads the WasmBrainBank descriptors, weights and inputs in place and writes the outputs where brain.wat does. Built with the system g++ and Node's headers (`g++ -O3 -march=x86-64-v3 -ffp-contract=off -shared`), no node-gyp.
- Same semantics as brain.wat: sparse first layer, Pade tanh with the 4.97 cut, padded `[in][pad4(out)]` rows. Up to 64 outputs stay in registers (8-wide ymm plus a 4-wide tail), so every live layer is one pass over its inputs.
- The "exact" variants do mul then add in brain.wat's order, so outputs are bit-identical; the "fma" variants use FMA (and the tanh polynomial in FMA).
- `brainBench.ts`: steps the server's LiveWorld (4 founders x 800, 600 ticks), then times one tick's real brain run (slots, inputs, order) as WASM vs native on the same memory. User CPU per call, median of 25, interleaved; "cold" evicts all caches before each call.
- `hook.ts`: a `--import` preload for `src/liveBench.ts` that swaps `WasmBrainBank.forwardRun` for the addon, for the whole-tick numbers.
- Machine during the runs: i7-1165G7 (AVX2, FMA, AVX-512) at about 1.25 GHz under load 15-21 (from an imul chain), sequential read 10 GB/s, 1 KB reads in random 4 KB blocks 5.3 GB/s, dependent miss 150 ns.

## Kernel (3318 brains of the live mix, 24 MB of weights, 13.9 MB of cache lines read per run, 17.7% of inputs non-zero)

| Variant                                            | ms per run (cold) | vs WASM    | Outputs differing     |
|----------------------------------------------------|-------------------|------------|-----------------------|
| WASM brain.wat                                     | 5.24-5.39         | 1.00x      |                       |
| exact, scalar input compaction                     | 3.83-3.87         | 1.35-1.40x | 0                     |
| exact, AVX2 compaction (movemask + permute table)  | 3.37-3.49         | 1.54-1.57x | 0                     |
| fma                                                | 3.13-3.25         | 1.66-1.71x | 8065 of 24863         |
| fma, 2-4 interleaved partial sums (scalar compaction) | 3.66-3.73      | 1.43x      | 8321                  |
| prefetch the whole next block (scalar compaction)  | 4.38-4.52         | 1.16-1.20x |                       |
| grouped by shape, 4 brains interleaved             | 3.24-3.56         | 1.51-1.66x | 0 (exact)             |
| exact + prefetch next brain's used rows (21)       | 2.94-3.01         | 1.79-1.82x | 0                     |
| fma + prefetch next brain's used rows (19)         | 2.74-2.84         | 1.85-1.95x | 8065, max abs 9.6e-5  |
| either, blocks first copied into run order         | WASM 5.26, 19 2.84, 21 3.05 | no change |                |
| Juggernaut x 4900 (cap): WASM / 21 / 19            | 5.47 / 2.89 / 2.71 | 1.89x / 2.02x | 0 / differ        |

The prefetch that pays: compact the next brain's inputs one brain early, prefetch the first and last line of each used first-layer row and the first 4 lines of the later layers (the hardware streamer takes the rest). Prefetching every line, or the whole block, costs more instructions than it saves.
Hot (no eviction) equals cold within 3%, and run-order block layout changes nothing, so the run is latency and instruction bound, not bandwidth bound.
In-core cost with the weights in L1 (one slot repeated), ns per brain, WASM / fma / exact+prefetch: 55-12-12-4 515 / 247 / 324, 55-16-16-4 577 / 260 / 328, 93-24-24-24-24-18 2206 / 653 / 818.
The big brain loses most in WASM: brain.wat runs a 24-wide layer as a 16-wide block plus an 8-wide block, two passes over the inputs. A 6-vector case in brain.wat might recover part of that in the browser too (unverified).

## Whole tick (liveBench 60 s, alternating base, exact, fma, three rounds)

| Case                | Base cpuMsPerTick     | Native exact (21)     | Native fma (19)       | Ratio of medians (exact / fma) | Fingerprint                  | Peak RSS MB          |
|---------------------|-----------------------|-----------------------|-----------------------|--------------------------------|------------------------------|----------------------|
| 4 founders x 800    | 15.50, 15.35, 14.87   | 13.43, 13.16, 12.87   | 12.90, 12.99, 11.91   | 1.17x / 1.19x                  | exact equal (708687555), fma differs | 213-217 / 217-250 / 216-217 |
| Juggernaut x 4900   | 18.81, 18.66, 18.52   | 16.17, 16.47, 16.17   | 15.98, 15.91, 16.29   | 1.15x / 1.17x                  | exact equal (10334191), fma differs  | 251-255 / 252-256 / 253-255 |

The brain forward phase (`--profile`, 20 s) went from 5.32 to 3.02 ms. FMA adds only about 2% of a tick over the exact kernel, too little to pay for a behaviour check.

## How it would plug in (server only)

1. Engine: an optional `WasmBrainBank.native` hook, `(buffer, desc, slots, n) => void`, that `forwardRun` and `forwardSlots` call when set. The browser never sets it.
2. `server/native/brain.cc` with the exact variant only (about 200 lines), built by `npm run native` on the laptop at deploy; the `.node` is git-ignored.
3. `server/src/nativeBrain.ts` loads it in try/catch, the addon checks `__builtin_cpu_supports("avx2")` and `"fma"`, and a start-up self-test compares it bit for bit with brain.wat on a few brains. Any failure logs once and keeps WASM.
4. Safety: the addon must validate every descriptor (slot below the descriptor count, 2-12 sizes, each at most 1024, every block inside the buffer) before touching memory, since a bad value crashes the process where WASM would trap. Sizes come from uploaded plans, so this is attack surface and falls under the 3-review push gate.
5. A vitest compares native and WASM outputs bit for bit over random shapes, zero-heavy inputs and NaN, skipped when the addon is missing. dlopen under the systemd sandbox (read-only repo bind, no `MemoryDenyWriteExecute`) should work; unverified.

## Native sense kernel

sense.wat (414 lines) is mostly scalar f64 grid walking with candidate lists (13 SIMD ops), so wider lanes and FMA would not help; any gain would come from gcc's code generation, as the plain exact brain variant got 1.55x without prefetch or FMA.
Bit-identity is possible (only + - * / sqrt and compares, `-ffp-contract=off`). The cost is a hand port (wasm2c is not installed), an equality test against sense.wat, and every later sense change (rock, terrain, species) made twice.
Guess, unmeasured: 1.2-1.5x on the 5.7 ms senser, 1-2 ms per tick.

## Verdict suggestion

Native brain forward reaches the 1.8x bar bit-identical (1.8x, 1.9x with FMA) and gives 1.15-1.17x per tick with an equal fingerprint and no RSS growth.
Worth adopting only if a native build step and a C++ twin of brain.wat on the public server are acceptable. Cheaper first: try the 24-wide block in brain.wat, which helps the browser too.

Reproduce (in `server/`): `native/build.sh`, then `node native/brainBench.ts --variants 19,21 [--only juggernaut --copies 4900] [--relocate]`, and `BRAIN_NATIVE_VARIANT=21 node --import ./native/hook.ts src/liveBench.ts --seconds 60 --copies 800`.
