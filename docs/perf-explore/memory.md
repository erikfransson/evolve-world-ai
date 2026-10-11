# Memory

| Idea                                                                 | Before                         | After                          | Speedup | Exact? | Peak RSS change                          | Lines added | Verdict |
|----------------------------------------------------------------------|--------------------------------|--------------------------------|---------|--------|------------------------------------------|-------------|---------|
| Build JS-path-only scratch lazily (Brain, RayCache, rays, trig, dirs, input) | 508 MB at 50k wide, 10k creatures | 322 MB (predators 511 to 299 MB) | 1.00x (5.42 vs 5.40 ms/tick CPU, 3 pairs under load 30) | yes, all fingerprints | -37% serial, -24% with 3 helpers (5k creatures, 707 to 538 MB) | about +55 net | merge |

Measured with `--expose-gc` scripts in the scratchpad (`mem/m.ts`), 10000 creatures, default plans (about 66 inputs, 18 hidden, 1200 genes), WASM on.

## Where the bytes were (per creature, 20000 wide, 10000 creatures)

| Item                                                        | Before   | After   |
|-------------------------------------------------------------|----------|---------|
| Brain genome copy (Float32)                                 | 4.8 KB   | 4.8 KB  |
| WASM brain slot (padded weights, input, output, offsets)    | 6.9 KB   | 6.9 KB  |
| Brain `firstLayerByInput` (Float64, transposed first layer) | 8.2 KB   | 0       |
| Brain `activeIndex`, `activeValue`, `hidden`, activations   | 1.0 KB   | 0       |
| RayCache (8 typed arrays)                                   | 1.7 KB   | 0       |
| rayOffCos/Sin, rayDirX/Y, input                             | 0.5 KB   | 0       |
| JS object headers: 23 ArrayBuffers plus views, RayHit x9    | about 5 KB | about 3 KB |
| Total RSS over empty process, per creature                  | about 41 KB | about 23 KB |

Heap 94 MB to 46 MB, external 228 MB to 123 MB at 10000 creatures.
Fixed cost is small: a 50000-wide world with 100 creatures is 101 MB RSS (node itself is 88 MB), the item world is about 6 MB and its WASM copy about 9 MB per owner.

## Change

On the WASM path none of the JS brain scratch is ever used, because sense and think run in the kernels, so it is built on first use.
- `Brain`: views, scratch and the f64 transposed first layer are built by `ensure()` on first `forward`, `layerActivations`, `showInput` or `weights`/`biases` access. `load` only retransposes when built.
- `RayCache` arrays start empty and `grow` makes the first 32. `Creature.cache` is made on the first JS sense; `touched` uses an idle cache until then (it never read the list without a built one).
- `Creature.rays` is a lazy getter. Ray count comes from the plan in `senser.ts`.
- Ray cos/sin tables are built for the JS sense path only. The WASM `setOffsets` computes them straight into WASM memory from the same f32 offsets (same values).
- Ray directions use one shared scratch, since a sense is one synchronous call.
- `Creature.input` is made when `encode` or `adoptInput` needs it.

The selected (detail) creature still builds all of it, so the UI is unchanged. The JS path (no SIMD) builds it on its first tick, so it uses the same memory as before.
Helper mode gains too: the coordinator holds every creature but only runs its own share, so non-owned creatures are now genome only there.

## Checked and left alone

- Spare pools (dead creatures kept for reuse): with 10000 founders crashing to 700 the pool holds 1800 creatures, about 11.7 KB each after this change. Peak is unchanged since pool plus living equals the highest population reached. Trimming would also need WASM slot release. Not worth it for peak.
- WASM arena fragmentation: after 3000 ticks of plan drift 327 free blocks, 2 MB. Fine.
- Lineages (Int32 per founder), leaderboard and stats in the worker, snapshot frames (32 B per creature per frame): all under 1 MB at 10000.
- Helpers: each holds its own World (about 6 MB at 50000 wide) and WASM bank, creatures only for its share. Duplicating the world is cheap next to the creatures.
- Remaining per creature: genome 4.8 KB plus WASM slot 6.9 KB (hidden 18 padded to 24 lanes). Dropping the JS genome or padding differently needs kernel changes.
- Merging the four small per-creature buffers (genome, offsets, units, output) into one would save about 0.6 KB per creature for a lot of refit logic. Not done.
