# Perf explorations

One write-up per exploration, with the tables of tried ideas and their verdicts.

- `rays.md`: skipping wall math and block-stamp caching for item rays gave about 1.05x per tick, bit-identical; merged.
- `layout.md`: sense batch in heap order gave 1.10x, bit-identical; merged. Spatial and random order rejected.
- `parallel.md`: helpers also doing memory, motion and item lookup gave 1.2x at 20k, bit-identical; merged. Work stealing not worth it.
- `wasm.md`: one-call WASM sense gave about 1.36x, bit-identical; recommended and merged.
- `gpu.md`: WebGPU compute not worth it, at most about 1.2x and not bit-exact.
- `render.md`: pixel-layer items about 14x faster to draw but change pixels; prototype only.
- `offscreen.md`: render worker with OffscreenCanvas, page busy 111% to about 10% of wall time, pixel-identical; merged, on by default with a page fallback.
- `trig.md`: WASM sin and cos gain nothing; not worth porting.
- `profile2.md`: per-phase profile at 12k to 30k; PhaseTimer kept. Helper gains measured under load, so pessimistic.
- Shared-memory helper mode was removed on 2026-10-11 (see `docs/perf-notes.md`), so notes here that mention shared helpers or `--shared` describe a retired mode.
- `crowd.md`: crowd rebuild by radix sort over occupied cells plus dirty-list item sync, bit-identical, 1.7x at 50k and 1.3x at 30k with low population; merged.
- `serial.md`: item lookups and collisions in an f64 WASM kernel, bit-identical, 1.05-1.08x for about 430 lines; not merged, the per-tick object gather caps the gain (typed-array creature state would be the next step).
- `memory.md`: building JS-path-only scratch lazily cut RSS 508 to 322 MB at 50000 wide with 10000 creatures (41 to 23 KB per creature), bit-identical, speed unchanged; merged.
- `brain.md`: sparse input packing and in-place outputs in the brain kernel, 1.33x kernel and 8-13% per tick, bit-identical; merged.
- `helpers.md`: genomes sent only to the owning helper (start-up RSS 1.37 to 1.0 GB at 50k with 4 helpers) and the start timeout for the first tick; merged. Messaging is near its floor, spatial split and overlap rejected.
- `soa.md`: typed-array store for hot creature state, bit-identical but 1.00x; rejected.
- `sensecopy.md`: the per-batch copy of the item grid into WASM is under 1% of a tick even at 50k; rejected.
- `hunt.md`: The Great Hunt's hunt search is about 1.5% of a tick; nothing to gain.
- `v8.md`: no JS-engine hot spot worth a change; WASM sense is about 46% of samples.
- `render50.md`: tiled item cache, about 1.25x per whole-world frame but not pixel-identical; held until measured on a real GPU browser.
- `snapshot.md`: item deltas cut snapshot bytes 60-70% but only 1.5-2% of sim time; rejected for now.
- `startup.md`: start-up at 50k is mostly founder genome draws; nothing worth changing.
- `profile50.md`: reference profile at 20k to 50k after round 2; at 50k serial: sense 41%, brain 17%, memory and steer 11%, collisions 9%, eat 8%.
- `cells.md`: items packed per grid row in exact list order so the WASM sense streams memory, kernel 1.2x and tick 4-7%, bit-identical; merged. The WASM kernel never uses the ray cache; a kernel-side candidate cache would save at most about 7%.
