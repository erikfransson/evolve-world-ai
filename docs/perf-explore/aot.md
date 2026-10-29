# AOT kernels: brain.wasm and sense.wasm through wasm2c as a Node addon

Branch `pl-aot`, prototype in `server/aot/` only (`aot.c`, `build.sh`, `kbench.ts`); nothing in `src/` or the live server changed.
Question: does ahead-of-time compiling the engine's own `.wasm` bytes to native code (no hand-written twin, unlike `native.md`) beat V8's TurboFan code for the two biggest kernels?

## How

- `build.sh` writes `BRAIN_BYTES` and `SENSE_BYTES` from `loader.ts` to `.wasm`, runs them through `wasm2c` from the npm `wabt` 1.0.39 package (`node_modules/.bin/wasm2c`, an Emscripten build that ships no runtime), and compiles with the wasm2c runtime and simde 0.8.2 headers fetched from GitHub (wabt and simde release tarballs). Flags `-O3 -march=native -ffp-contract=off`.
- `aot.c`: N-API addon whose single `wasm_rt_memory_t` points at the engine's `WebAssembly.Memory` buffer on every call (so growth is handled for free), `forward(buffer, 8 args)` and `sense(buffer, P)`, traps caught with `wasm_rt_try` and returned as a code.
- Memory checks: `bounds` (explicit check per access, the only safe mode inside Node, since wasm2c's guard-page mode needs its own signal handler, which would fight V8's), `guard` (no checks and no handler, an upper bound only, not deployable), and clang with segue (`WASM_RT_ALLOW_SEGUE`, memory base in the gs register).
- `kbench.ts`: steps the server's LiveWorld (4 founders x 800, or juggernaut x 4900) and at tick 600 intercepts the real sense and brain calls. From the same pre-state it runs V8 once and each addon once and compares the whole 45 MB memory byte for byte, then times them interleaved (user CPU, median of 15, cold = 48 MB sweep before each call).
- Machine: i7-1165G7 under load 11-16 from other sessions, so ratios within a run count, absolute ms drift between runs.

## Results (ns per creature, cold, median; ratio = V8 time / AOT time)

| Case, run                  | Kernel | V8   | AOT bounds (gcc) | AOT guard (gcc) | clang guard+segue | Bytes differing |
|----------------------------|--------|------|------------------|-----------------|-------------------|-----------------|
| mix 3318, run 1            | sense  | 1005 | 1328 (0.76x)     | 1002 (1.00x)    | 1002 (1.00x)      | 0               |
| mix 3318, run 2            | sense  | 992  | 1435 (0.69x)     | 987 (1.01x)     | 1068 (0.93x)      | 0               |
| mix 3318, run 3            | sense  | 1359 | 2067 (0.66x)     | 1389 (0.98x)    |                   | 0               |
| mix 3318, run 1            | brain  | 1372 | 1273 (1.08x)     | 1484 (0.92x)    | 1430 (0.96x)      | 0               |
| mix 3318, run 2            | brain  | 1087 | 1259 (0.86x)     | 1124 (0.97x)    | 1123 (0.97x)      | 0               |
| mix 3318, run 3            | brain  | 1540 | 1961 (0.79x)     | 1649 (0.93x)    |                   | 0               |
| juggernaut 4900            | sense  | 1180 | 1749 (0.68x)     | 1196 (0.99x)    | 1166 (1.01x)      | 0               |
| juggernaut 4900            | brain  | 1078 | 1301 (0.83x)     | 1102 (0.98x)    | 1109 (0.97x)      | 0               |

Hot (no sweep) gives the same picture: guard 0.91-1.09x, bounds 0.67-0.88x.
A first matrix at tick 100 (3223 creatures) also tried clang without segue and clang bounds with segue: sense 0.71-0.82x, brain 0.78-0.91x, all slower than V8.
Every variant was bit-identical: zero bytes of the whole memory differ from V8 after a run, no traps.
Base on perf-live (a4ce364), one `--profile` run: cpuMsPerTick 14.39, senser 5.06, brain forward 5.06, fingerprint 708687555, peak RSS 219 MB.

## Why it does not pay

- brain.wat already has the shape the native study found (sparse input lists, up to six f32x4 accumulators kept in registers per input pass, `brain.md` and `brainblock.md`), and gcc turns its inner loop into the same 6 x (load, mulps, addps) that TurboFan emits. With 128-bit lanes fixed by the `.wat`, there is nothing left for a C compiler to win; the 1.8x in `native.md` came from 8-wide AVX2, prefetch and a different loop, which a translation of the same bytes cannot produce.
- sense.wat is scalar f64 grid walking; TurboFan's code for it is as good as gcc's from wasm2c output.
- wasm2c costs a little on top: every load goes through `memcpy`, which aliases the memory struct, so the base pointer is reloaded after stores; float loads carry `FORCE_READ_FLOAT` moves; explicit bounds checks cost 15-35%. V8 uses guard pages, so it pays no bounds checks at all, and an addon inside Node cannot get those safely.

## Verdict suggestion

Dead: the deployable (bounds-checked) AOT kernels are 0.66-0.86x of V8 (one noisy 1.08x), and even the unsafe unchecked build is 0.92-1.01x, far under the 1.15x bar.
Bit-identity is not the problem (zero differing bytes everywhere); speed is. A native win needs a different kernel (wider lanes, prefetch), which is the hand-written twin `native.md` parked.

Reproduce (in `server/aot/`): `./build.sh bounds gcc -DWASM_RT_USE_MMAP=0 -DWASM_RT_MEMCHECK_BOUNDS_CHECK=1`, `./build.sh guard gcc -DWASM_RT_MEMCHECK_GUARD_PAGES=1 -DWASM_RT_SKIP_SIGNAL_RECOVERY=1`, then `node kbench.ts ./aot_bounds.node,./aot_guard.node [--only juggernaut --copies 4900] | node show.cjs`.
