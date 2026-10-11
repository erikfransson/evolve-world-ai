# Render: main thread and snapshot at 20k width

Machine: 8 logical cores, about 12 agents running, so timings swing 2-5x. Headless Chrome with software canvas (no GPU), so absolute draw times are pessimistic; ratios are the useful part. Canvas 1400 x 900, dpr 1, 3923 creatures, 19924 live items (17500 food, 2424 poison) in a 20000 x 12500 world from a 300-tick run.

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| Items as a per-pixel layer (ImageData, 2x2 px, alpha 0.75), whole world | items path 147 ms (median of 25, range 77-734) | 10 ms (range 5-23) | about 14x | No, pixels differ from path-drawn squares; sim untouched | Promising, prototype only, not integrated |
| Same at zoom x8 | 26 ms | 21 ms | 1.3x | Items no longer tiny here, so the layer is not valid there | Not useful, keep the path |
| Transferable buffers instead of structured clone | already in place (ArrayBuffer transfer + recycle) | n/a | n/a | Yes | Nothing to gain |
| Viewport culling | already in place for items and creatures | n/a | n/a | Yes | Keep |
| Delta snapshots (changed cells only) | 337 KB per frame | not built | n/a | Yes | Worker side only, no main-thread gain |
| Whole frame, whole world | 539 ms median (260-1280) | not re-measured | n/a | n/a | see below |
| Whole frame, zoom x8 | 20 ms | not re-measured | n/a | n/a | see below |
| Whole frame, zoom x40 | 10 ms | not re-measured | n/a | n/a | see below |
| Snapshot build in worker (Node) | 2.2 ms median, 0.9 min | n/a | n/a | n/a | Not a bottleneck |

The whole-frame numbers come from one run under heavy load. Their spread (min 260, max 1280 at whole world) is too wide to trust for a before and after, so re-measure on a quiet machine before deciding.

## Snapshot

Per frame at 20000 x 12500 with 3923 creatures: 337 KB total, 157 KB creature arrays (capacity 4904 x 32 bytes), 180 KB item slots (capacity 20000 x 9 bytes).
The buffer is transferred, not cloned, and recycled, so posting costs no copy.
Building it in the worker takes 2.2 ms median (0.9 ms min) in Node. That runs off the page's main thread.
At 30 snapshots per second the worker builds take about 7% of one core, which is not the bottleneck.
Item slots equal `world.count`, which is the food plus poison capacity, so they are almost all live at 20k width.

## What dominates at 20k+

Main thread time is canvas drawing, not the message.
Items: 20k path entries in two fills, each a `rect` (zoomed out) or `arc`. Canvas path rasterisation of thousands of tiny shapes is the cost.
Creatures: about 3900 dots, each an arc plus a dark outline, split into up to 576 colour buckets (72 hues x 8 ages), so up to 576 fill calls. Creatures-only at whole world measured 167 ms and 311 ms in two runs.
Zoomed in, culling keeps the draw at 6-20 ms.

## What I tried

1. Items as a pixel layer. Each live item is written as a 2x2 block into an ImageData the size of the canvas, alpha 0.75, then the layer is composited with `drawImage`. The floor is drawn first. Result: 10 ms against 147 ms at whole world. This hides nothing, since every item still gets at least a pixel, but the look changes: 2x2 solid blocks in place of 1.6 px antialiased squares. Items drawn in the layer sit under the creatures only if the layer is drawn before the creature pass, which the prototype does not test (it times the layer and the creatures separately).
2. Not built: delta snapshots, OffscreenCanvas, WebGL instanced sprites, a cached static item layer.

## Promising, untried

- OffscreenCanvas in the worker. Moves all drawing off the page's main thread without changing a pixel. Needs `transferControlToOffscreen`, and the camera input and selection must reach the worker. Likely the largest structural win, unmeasured.
- Creature dots as a pixel layer too, for the zoomed-out case. Same trade as items, and it changes creature size on screen (dots are 2.4 CSS px today). Needs a look before adopting.
- Fewer colour buckets for dots when zoomed out (for example 12 hues), which cuts fill calls. Changes colours, unmeasured.
- Item deltas in the worker to skip rebuilding the 180 KB item block each frame. Worker side only, small gain.

## Code cost

Prototype is in the scratchpad (`perf-explore/render/bench2.ts`, about 40 lines for the layer). Not in the repo. Integrating the item layer into `src/ui/ecoScene.ts` would be about 40 lines, plus a visual check.

## Exactness

Everything here is render-only. The simulation, fingerprints and snapshot contents are unchanged. The item layer changes pixels, not data.
