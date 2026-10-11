# Perf explorations

One write-up per exploration, with the tables of tried ideas and their verdicts.

- `rays.md`: skipping wall math and block-stamp caching for item rays gave about 1.05x per tick, bit-identical; merged.
- `layout.md`: sense batch in heap order gave 1.10x, bit-identical; merged. Spatial and random order rejected.
- `parallel.md`: helpers also doing memory, motion and item lookup gave 1.2x at 20k, bit-identical; merged. Work stealing not worth it.
- `wasm.md`: one-call WASM sense gave about 1.36x, bit-identical; recommended and merged.
- `gpu.md`: WebGPU compute not worth it, at most about 1.2x and not bit-exact.
- `render.md`: pixel-layer items about 14x faster to draw but change pixels; prototype only. OffscreenCanvas is untried.
- `trig.md`: WASM sin and cos gain nothing; not worth porting.
- `profile2.md`: per-phase profile at 12k to 30k; PhaseTimer kept. Helper gains measured under load, so pessimistic.
- Shared-memory helper mode was removed on 2026-10-11 (see `docs/perf-notes.md`), so notes here that mention shared helpers or `--shared` describe a retired mode.
- `serial.md`: item lookups and collisions in an f64 WASM kernel, bit-identical, 1.05-1.08x for about 430 lines; not merged, the per-tick object gather caps the gain (typed-array creature state would be the next step).
