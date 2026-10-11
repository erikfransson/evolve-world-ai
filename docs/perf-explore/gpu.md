# WebGPU compute for very large worlds

| Idea                                   | Before                      | After     | Speedup           | Exact?                                              | Verdict                         |
|----------------------------------------|-----------------------------|-----------|-------------------|-----------------------------------------------------|---------------------------------|
| Brain forward for all creatures on GPU | brain 16-20% of a tick      | unmeasured | at most 1.2x tick | No vs JS (f64 sums). Close to WASM (f32), not bit-proven | Not worth it                |
| Item/crowd rays on GPU                 | 30-40% of a tick            | unmeasured | unknown           | Hits can flip at grazing angles; sort order matters | Not worth it                    |
| Whole tick on GPU                      | -                           | -         | -                 | No, and a rewrite of ecosystem, world, crowd         | Reject                          |

No measurement: headless Chrome 154 here has no usable WebGPU (Vulkan `vkCreateInstance` failed with -7, the SwiftShader path never returned an adapter in 90 s). A microbenchmark page is in the scratchpad (`gpu/index.html`), not committed. Everything below is reasoning from the code and perf-notes numbers.

## What the CPU paths compute today

- JS `Brain` (brain.ts): weights are `Float32Array`, but sums run in f64 (first layer copy is a `Float64Array`, `s += w * v` in double), then `fastTanh` in double (Pade 7,6, clamp at 4.97, max error 1e-4), stored to `Float32Array`.
- WASM `brain.wat`: f32x4 mul then add (no FMA), same Pade formula in f32, `f32x4.div`. Sums add in input order. brainKernel.ts says it differs from JS "only by f32 rounding of the sums". The 600 s table in perf-notes (births differ between JS and WASM runs) confirms that JS and WASM are not bit-identical. The fingerprint bar holds within one path across thread counts.
- Other transcendentals in the tick: `Math.sin/cos` of heading (physics.ts:48), `Math.exp` for energy encoding and drag (physics.ts:21, sensors.ts:124), `Math.sqrt` in ray and collision tests (world.ts:375, crowd.ts:161, physics.ts:102). Only sqrt is correctly rounded everywhere.

## Exactness on a GPU

- Bit-identical to the JS path: not possible in WGSL. There is no f64, so the f64 accumulation cannot be reproduced. Emulating it (double-float) is slow and still would not match a hardware f64 sum.
- Bit-identical to the WASM path: plausible for the brain alone. WGSL `+`, `*`, `/` on f32 are IEEE on all current backends, but the spec lets the compiler fuse `a*b+c` into FMA (use of `fma()` is explicit, fusion of plain expressions is allowed by WGSL's accuracy rules and Metal/Dawn often does it). Mitigation: no way to forbid fusion portably, so one would have to split the multiply from the add across statements, which compilers may still fuse. Division in WGSL has 2.5 ULP error allowance, so `f32x4.div` in the Pade tanh is not guaranteed to match. Unverified on hardware here. So "bit-identical to WASM on every GPU" cannot be promised and cannot be tested without several vendors.
- Deterministic across GPUs: only if the shader avoids fusion-prone and non-IEEE operations (no tanh, exp, sin, cos built-ins, division replaced by Newton steps from exact ops). Possible for brains, a research task for rays.
- Net: best case "deterministic but different from today's JS and WASM fingerprints", with a residual risk of vendor drift. That breaks the owner's bit-identical bar, and the sim is chaotic (a single flipped action diverges a run within generations), so a different fingerprint also means saved/shared seeds replay differently on GPU vs CPU machines.

## Latency versus the tick budget

Tick cost today (perf-notes, 12000 x 7500): 5000 creatures 40 ms serial WASM, 23 ms with 4 shared helpers. At 10000 creatures expect ~80 ms serial. Brain forward is 16-20% (notes: JS sparse layer 19%, forward about 500 ns of ~1100 ns per creature-tick), rays about 35%.

GPU brain for N = 10000: weights stay resident on the GPU and only change on births (delta upload), inputs are ~100 floats per creature (about 4 MB up per tick), outputs ~6 floats (240 KB down). Transfer volume is small, but the browser round trip is not: `queue.submit` plus `mapAsync` readback costs on the order of 1-3 ms minimum and often one frame (16 ms) of scheduling, since mapAsync resolves on the event loop. The compute itself would be 0.1-1 ms. So the brain stage would drop from ~10-15 ms (10k creatures, 4 helpers) to ~3-5 ms with the round trip, a saving of 7-10 ms in a 40-ish ms tick, at best 1.2-1.3x. The ray stage needs the item grid (changes each tick: eaten and respawned items, per-cell versions, RayCache) and the crowd grid on the GPU as well, with a separate upload of changed cells, then rays feed brains feed physics. Doing only the brain on the GPU forces inputs to be computed on CPU, uploaded, run, read back, then physics: a full sync point each tick that serializes with the helper-thread fork-join and makes helpers idle.

Whole tick on the GPU removes the round trip but needs births, deaths, sorting (counting-sort grid), collisions and RNG ported to WGSL with atomics, where order of atomic operations is nondeterministic. Not exact by construction, and effectively a second engine.

## Browser support (as of my knowledge, check before relying)

- Chrome/Edge: WebGPU shipped (Windows, macOS, ChromeOS, Android; Linux behind flags or recent releases). Works in dedicated workers. Firefox: shipped on Windows in 2025, other platforms later or behind flags. Safari: shipped with macOS/iOS 26. GitHub Pages is HTTPS, so it is a secure context and fine.
- A fallback CPU path must stay anyway (and it is the fingerprint reference), so the GPU path would be an extra, not a replacement. Users on integrated/old GPUs may be slower than the 4 helper threads.

## Code cost

Estimate 800-1500 lines: WGSL brain kernel and buffer management (slots, delta uploads on birth), async pipeline integration with the ecoPool/ecoShare tick loop (GPU result arrives next tick or the tick blocks), feature detection, a fallback, and tests that cannot run in CI without a GPU. Rays and whole tick: several thousand lines.

## Verdict

Not worth it under the owner's exactness definition. Brain-only GPU gives at most 1.2-1.3x of a tick, cannot match the JS fingerprint and cannot be proven to match the WASM one across vendors, and the per-tick readback sync works against the multi-core design. If exactness were relaxed to "deterministic per machine class", the better first step is larger gains on CPU: more helpers, rays in WASM for items (still JS), and cutting the per-tick ray work. Revisit only if a profile at 50k width shows the brain over 50% of the tick and the owner accepts a non-JS fingerprint. What would change this: measured WebGPU readback under 1 ms and a bit-exact test of fused versus unfused f32 across two vendors.
