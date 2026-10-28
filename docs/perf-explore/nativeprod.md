# Native brain kernel, merge-ready and opt-in (idea 79)

Branch `pl-nativeprod` (from perf-live 23ae6da). Question: turn the parked `pl-native` prototype (`native.md`) into an opt-in server feature, so adopting it is a yes or no.

## What
- `server/native/brain/brain.cc` (233 lines): N-API addon, `forward(buffer, desc, slots, n, scratchA, scratchB)`, re-derived from today's brain.wat (sparse first layer, `[in][pad4(out)]` rows then bias, inline Pade tanh with the 4.97 cut, intermediate layers in the wat's scratch A/B, last layer to the output). 8-wide AVX2, up to 64 columns in registers, mul then add per lane in the wat's order, no FMA. One brain ahead it compacts the inputs and prefetches the first and last line of each used first-layer row plus 4 lines after them (variant 21 of `native.md`). The index lists live on the native stack, so brain.wat's `nz` region is the only memory the two leave different.
- Checks before use: every number argument an integer in [0, 2^32), the buffer a live ArrayBuffer, 4-byte alignment, the run list and both 4 KB scratch areas inside the buffer; per brain its descriptor copied to the stack and checked (2 to 12 sizes, input 0 to 1024, layers 1 to 1024, weights, input and padded output inside the buffer) right before it is first touched. A failed check returns false and the call goes to brain.wat; the addon never throws. Kernel functions carry `target("avx2")`, the rest is baseline x86-64, and without AVX2 the module exports no `forward`.
- `brainKernel.ts` (+17): `setNativeForward(fn)`; `forwardSlots` and `forwardRun` call it with `memory.buffer` taken fresh on every call, and run brain.wat when it is unset or returns false. Nothing server-only enters the page bundle.
- `server/src/nativeBrain.ts` (70): with `LIVE_NATIVE_BRAIN=1` loads the addon in try/catch, checks it bit for bit against brain.wat on 5 shapes x 3 input rounds (zero, sparse, NaN and infinities), installs it, and returns one start-up log line with the reason when it stays on brain.wat; a refused run is logged once. `main.ts` and `liveBench.ts` call it (liveBench prints `brainKernel`).
- Build: `make` in `server/native/brain` (g++ -O3 -ffp-contract=off -shared against Node's own `include/node`, no node-gyp, no downloads). Needs g++ 9+, make, the N-API headers of the serving node. README section in `server/README.md`.
- -O3 instead of -O2: brain phase 2.65 against 2.92-2.94 ms (two 30 s profile pairs); `-march=x86-64-v3` adds about 2% more but would put AVX2 into the load path, so it is left out. Without the prefetch the native kernel is no faster than brain.wat (3.06-3.13 against 3.16-3.18 ms).

## Tests (`tests/typescript/nativeBrain.test.ts`, skipped when `brain.node` is not built)
- Object.is over the whole memory but the `nz` list after wat and native runs from the same state: 6 batches x 30 random brains of 2 to 12 sizes, widths 1-70 and up to 1024, inputs of 0 values, zero, dense, sparse with -0, NaN, infinities, 1e30, denormals and values at the tanh cut, random run lists with repeats, and `forwardRun`; every width 1-70; the largest shapes (12 x 1024, 1024-1, 1-1024).
- Hostile calls return false with the memory unchanged: 20 bad argument sets (types, detached and shared buffers, n of -1, 1.5, NaN, 2^31, 2^40, unaligned, past the end) and 17 corrupted descriptor or slot values, with the bad brain first and second.
- Growth: the old buffer detaches and is refused; the next call takes the new buffer and equals brain.wat.
- `useNativeBrain` installs it; a 0-neuron layer (accepted by brainKernel.ts, refused by the addon) runs on brain.wat, warned once.
- liveBench fingerprints with and without the addon equal for both cases (10 s runs); at 60 s every native run below gave 708687555 and 10334191.
- Red without the fix: an FMA build (`-mfma -ffp-contract=fast`) fails both parity tests and the start-up check; a build without the bounds checks crashes the test worker (SIGSEGV).

## Whole tick (liveBench 60 s, alternating base perf-live / native, 3 pairs each, quiet machine, load about 2)

| Case                      | Base cpuMsPerTick     | Native cpuMsPerTick   | Ratio of medians | Brain forward ms (--profile) base / native | Phase ratio | Fingerprint      | Peak RSS MB          |
|---------------------------|-----------------------|-----------------------|------------------|--------------------------------------------|-------------|------------------|----------------------|
| 4 founders x 800          | 8.532, 8.560, 8.513   | 8.063, 8.108, 8.186   | 1.052x           | 3.093, 3.081, 3.126 / 2.593, 2.569, 2.558  | 1.20x       | equal, 708687555 | 215-219 / 215-220    |
| Juggernaut x 4900 (cap)   | 10.447, 10.471, 10.294| 10.141, 10.089, 10.137| 1.031x           | 3.131, 3.063, 3.108 / 2.683, 2.667, 2.699  | 1.16x       | equal, 10334191  | 254-256 / 255-257    |

Flag off on this branch against base: 8.453, 8.276 against 8.318, 8.385, no cost.
The prototype's 1.8x kernel and 1.15x tick were against brain.wat before brainblock and brain3; the wat has since caught up (brain phase 5.3 to 3.1 ms), so what is left is 1.16-1.20x on the kernel and 3-5% of a tick.

## For a reviewer
- Bounds: `load()` and the top of `Forward()` in brain.cc; the descriptor copy is what makes a later check immune to what an earlier brain writes. Every prefetch address goes through `touch()`, which only prefetches inside the buffer.
- Detach: `WasmBrainBank.run` passes `memory.buffer` on each call; a detached buffer is refused (`napi_is_detached_arraybuffer`, null data).
- Fallback: `useNativeBrain` (flag, load, AVX2, start-up check) and the refused-run path to brain.wat in the installed wrapper.
- Twin drift: any brain.wat change needs the same change in brain.cc; the parity test fails otherwise, and the start-up check keeps a stale build off.
- Unverified: loading under the systemd sandbox (`systemd-run --user` was denied here); the unit has no `MemoryDenyWriteExecute` and binds the repo read-only, so dlopen should work.

## Verdict suggestion
Merge-ready opt-in, exact, no RSS cost, about 1.05x mixed and 1.03x at the cap, for 233 lines of C++ under the push gate and a g++ step at deploy. The gain is now small; Erik's call whether 3-5% is worth the native build and the second copy of the kernel. Off by default, it changes nothing.
