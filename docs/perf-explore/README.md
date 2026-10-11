# Perf explorations

One write-up per exploration, with the tables of tried ideas and their verdicts.

- `rays.md`: skipping wall math and block-stamp caching for item rays gave about 1.05x per tick, bit-identical; kept.
- `layout.md`: sense batch in heap order gave 1.10x, bit-identical; kept on branch. Spatial and random order rejected.
- `parallel.md`: helpers also doing memory, motion and item lookup gave 1.2x at 20k; recommended. Work stealing not worth it.
- `wasm.md`: one-call WASM sense gave about 1.36x, bit-identical; recommended and merged.
- `gpu.md`: WebGPU compute not worth it, at most about 1.2x and not bit-exact.
- `render.md`: pixel-layer items about 14x faster to draw but change pixels; prototype only. OffscreenCanvas is untried.
- `trig.md`: WASM sin and cos gain nothing; not worth porting.
- `profile2.md`: per-phase profile at 12k to 30k; PhaseTimer kept. Helper gains measured under load, so pessimistic.
