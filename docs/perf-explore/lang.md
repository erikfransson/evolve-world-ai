# Language: would Rust, AssemblyScript, Zig, C, Numba beat TS plus hand-written WAT?

Branch `worktree-agent-abc7c4622b1c22369`. Prototype in `docs/perf-explore/lang/` on that branch only (Rust crate `rustbrain`, `build.sh`, `langBench.ts`); nothing in `src/`. rustc 1.98, `wasm32-unknown-unknown` added via `rustup target add` (into ~/.rustup only).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Brain forward in Rust, plain loops, no simd128 | WAT 1.13 us/creature | 1.63 | 0.69x | bit-identical, 0 of 13200 outputs differ | none | ~150 rs | Rejected |
| Same, simd128 on, compiler auto-vectorises plain loops | 1.13 | 0.92 | 1.22x kernel (3 runs of 80 reps, 1.19-1.22) | bit-identical | none | ~150 rs | Faster kernel, see verdict |
| Same, explicit `core::arch::wasm32` intrinsics mirroring the WAT | 1.13 | 1.03 | 1.09x kernel | bit-identical | none | ~150 rs | |
| Per tick effect of the best variant | brain forward is 17% of a 50k tick (profile50.md) | | about 1.03x tick (estimate, not run in ecoBench) | | | | Not worth a toolchain |

Setup: 746 real evolved layer shapes and inputs x3 (2238 creatures, from `scratchpad/opt2/brain/shapes20k.json`), interleaved WAT and Rust, user CPU, load 14, 80 reps. The Rust modules import the memory, which holds a byte copy of the WAT bank (same ABI: `forward(desc, slots, n, ...)`). Operation order is the same as the WAT (inputs added in index order, no FMA), so f32 sums match exactly. Rust min/max are written as compares (NaN would differ from `f32x4.min`, never occurs in the sim).

Why Rust is faster is unverified. The likely cause is the branch-free scalar input compaction replacing the table swizzle, or register allocation, not "Rust beats WAT". The gain would probably port back into the WAT by hand (try the scalar compaction loop first).

## Verdict on a larger port

- Rust to wasm32 (full tick or sense): same engine, so same instruction speed. This test is the best case for Rust (a pure f32 kernel the compiler can vectorise) and it gained 0 to 20% on one kernel, about 3% of a tick. The big costs are JS object traffic and state not living in WASM memory (wasm.md, serial.md, soa.md), which no language fixes. A full tick port only pays after a typed-state refactor, and then any source language works; Rust would only save writing WAT by hand (sense.wat is 313 lines of stack code).
- Determinism: Rust f32/f64 `+ - * / sqrt` are IEEE and match. `sin`, `cos`, `exp` do not: the `libm` crate differs from V8's fdlibm (Node) and glibc (Chrome), see trig.md. Those calls stay in JS or need a bit exact port that already differs between Node and Chrome. Rust adds nothing here.
- CI and maintenance: needs rustup, the wasm target, a pinned toolchain and a generate step for the base64 module in addition to wabt. Rust output is a few KB but opaque to review, and LLVM upgrades can change vectorisation. Today's build is `npm ci` only.
- AssemblyScript: TS-like syntax, npm-only toolchain, SIMD via `v128` builtins, same libm issue. Speed at most Rust's, usually less. A readability gain over WAT, not a speed gain.
- Zig and C (clang to wasm32): same LLVM backend as Rust, same speed class, same toolchain cost.
- Numba: Python JIT, cannot run in browsers at all. A native addon on the Node server could beat WASM by maybe 1.5 to 3x on SIMD kernels, but breaks browser/Node bit identity (native libm trig and exp, FMA contraction), adds platform builds to deploy and weakens the sandbox. The sim is also object-graph shaped, not a Numba array loop.

Recommendation: not worth it. Do not adopt Rust, Zig, C, AssemblyScript or Numba for the engine. At most try back-porting the branch-free compaction into `brain.wat` (kernel up to about 1.2x, tick about 3%).

Reproduce: `docs/perf-explore/lang/rustbrain/build.sh`, then from `src/typescript`: `node ../../docs/perf-explore/lang/langBench.ts <shapes.json> 3 80`.
