# Trig: can memory and steer move into WASM?

Branch `worktree-agent-a00d735cb8de41b57`. Standalone `src/typescript/src/sim/wasm/trig.wat` (about 200 lines) and `src/typescript/scripts/trigCheck.ts`. Not wired into the engine.

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| fdlibm sin/cos in WAT vs Node 24 (V8 13.6) Math.sin/cos | JS Math | WASM port | n/a | Yes: 0 mismatches in 8.9e7 inputs (1e8 minus 1.08e7 inputs above 823549 in magnitude that fall back to JS), incl. +-0, tiny, multiples of pi/2, NaN, +-Infinity, random bit patterns | Exact in Node only |
| Same in Chrome (V8 with `v8_use_libm_trig_functions`) | | | | No: Chrome's sin/cos are a glibc copy, not fdlibm. System glibc differs from fdlibm in 3.3% of calls | Port would not match Chrome's JS |
| Per-call cost, WASM batch vs two Math calls | about 60 to 100 ns per sin+cos pair | about 55 to 80 ns | 0.95 to 1.25x (load 23, noisy) | same | No real gain |
| Whole memory and steer phase in WASM | 1.6 ms per 1000 creatures | est. 0.5 to 0.8 ms | est. 4 to 6% of a tick at best | yes if the above holds | Not worth it alone |

## Which functions the phase uses

Only `Math.sin(heading)` and `Math.cos(heading)` once per creature per tick (`stepBody`, physics.ts:54). `Math.exp` is not in the phase: the decay factors are computed once per config (physics.ts:22) and the crowd energy signal `Math.exp` (sensors.ts:124) belongs to sense. Headings stay far below 8e5 rad (needs millions of ticks at full turn rate), so fdlibm's large-argument path (`__kernel_rem_pio2`, about 280 lines) was not ported. `sincos` returns 1 for those and the caller uses `Math.sin/cos`.

## Which libm does each engine use

- Node 24 (V8 13.6.233): `src/base/ieee754.cc` fdlibm port. The `use_libm_trig_functions` flag does not exist in `node --v8-options`, so Node builds without `V8_USE_LIBM_TRIG_FUNCTIONS`. Checked: a native build of V8's own `ieee754::sin/cos` (extracted from nodejs/node v24.18.0 `deps/v8/src/base/ieee754.cc`) matched Node's Math.sin/cos in 8e6 inputs with 0 mismatches.
- Chrome and other clang gn builds: `gni/v8.gni` sets `v8_use_libm_trig_functions = is_clang`, which defines `V8_USE_LIBM_TRIG_FUNCTIONS` and routes Math.sin/cos to `third_party/glibc/.../dbl-64` (`libm_sin`, `libm_cos` in ieee754.cc). That is IBM Accurate Math Library code, a different algorithm from fdlibm. System glibc 2.35 as a stand-in differs from V8's fdlibm in 3.3% of sin and cos calls over headings in +-50 and over a random walk (unverified that V8's copy equals system glibc bit for bit). So the fdlibm WASM port equals the JS path in Node only. Chrome would differ in the last bit in about 3% of calls, which diverges a chaotic simulation.
- Firefox (SpiderMonkey bundles fdlibm) and Safari (JavaScriptCore calls the system libm): not checked.
- Consequence: the JS path is already not identical between Node and Chrome, so cross-engine identity does not exist today. The bar is "same as JS in the same engine". A WASM path would be identical across engines to itself, but equal to JS only where JS uses fdlibm.
- Possible guard if ever used: at start up compare `Math.sin/cos` with the WASM port on a few thousand probe angles and use WASM only if all match. A glibc port instead (about 300 lines plus the 440-entry `sincostab`) would be needed to match Chrome.

## Speed

`node scripts/trigCheck.ts 1e8`, load average 23 on 8 cores, so absolute numbers are inflated. 4096 random-walk headings, results stored to two Float64Arrays as the sim does, three rounds:

| Variant | ns per sin+cos pair |
|---------|--------------------|
| JS `Math.sin` + `Math.cos` | 62 to 100 |
| WASM batch, angles copied in, results left in WASM | 56 to 77 |
| WASM batch plus copy results out | 64 to 82 |

WASM is about as fast as V8's builtin and not faster. One call per angle from JS (crossing the boundary each time) was 98 to 129 ns, no gain either.

## Phase estimate

Memory and steer is 1.63 ms per 1000 creatures (profile2.md, 30k). Sin and cos are about 60 ns per creature, roughly 4% of the phase and 0.3% of a tick, so porting trig alone gains nothing. The cost of the phase is JS object and field traffic (`CreatureState`, `units`, `output`, `heading`). Moving the whole loop (remember, thrust command, `stepBody`, aging, upkeep) into WASM needs creature state resident in WASM memory (the SoA refactor from wasm.md). If that were done the loop would probably take 0.3 to 0.5 ms per 1000 creatures, saving about 5% of a serial tick, less with helpers. Collisions and eating still need the same state, so the real payoff is the shared SoA move, with trig as a small enabling piece.

## Recommendation

Do not port memory and steer for speed. If the state ever moves into WASM for other reasons, `trig.wat` is ready (exact in Node, with the Chrome mismatch above) and a start-up probe should choose between it and the JS path. Reproduce: `cd src/typescript && nice -n 15 node scripts/trigCheck.ts 1e8` (needs `node_modules`, `wabt`).
