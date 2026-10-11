# Render at 20k-50k width: item layer and other draw options

Headless Chrome, software canvas 1400 x 900, dpr 1, 19924 items, 3923 creature dots, 20000 x 12500 world, whole-world view. The machine was at load 25-35 throughout, so only ratios and minimums mean anything. Harness: bundled `EcoRenderer` old vs new in one page, alternating frames, pixel compare after each pair (scratchpad `render50/`).

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Tiled item layer, repaint only tiles whose items changed (`src/ui/itemLayer.ts`) | whole frame median 246-262 ms (min 154-193); items about 100+ ms of it | median 190-210 ms (min 99-110); items about 35 ms (sig 8, repaint 17, blit 11) | frame 1.25x median, 1.5x min; items about 3x | Near: 1 level on ~1000 channels from the blit, up to 14/255 on ~45k channels (about 3% of pixels, antialiased square edges) where a tile was repainted | +5 MB per 1400x900 canvas (33 MB at 4K dpr 2), no sim change | 150 (new file) + 8 in ecoScene.ts | Merge if the small edge-antialias difference is acceptable |
| Items as one path per kind (already in place) | n/a | n/a | n/a | yes | 0 | 0 | Already done, nothing to batch |
| `fillRect` per item instead of one path | 95-125 ms | 49-73 ms | about 1.7x | No, 286k channels differ, max 55 | 0 | small | Rejected, visibly different |
| Device-space coordinates for item path | 95-125 ms | 63-137 ms | none | No (380 channels, max 29) | 0 | small | Rejected |
| Cached full-frame item layer, blit only | 125 ms | 2.5 ms blit | 50x | Same as above (1 level) | +5 MB | n/a | Only valid while no item changes; items churn about 7 per tick, so tiles are needed |
| Creature dots via pre-rendered sprites | 143 ms | 144 ms | none | No (max 214) | +576 small canvases | n/a | Rejected |
| Creature dots via `ellipse` / `roundRect` / device coords | 143 ms | 100-157 ms | within noise | ellipse yes, others no (max 29-47) | 0 | n/a | Rejected |
| Creature colour buckets | already one path and fill per colour | n/a | n/a | yes | 0 | 0 | Already done. The shared dark outline path (3923 overlapping circles) is about half of the dot cost and cannot be split by colour without changing overdraw |
| Frame pacing (draw once per snapshot) | n/a | n/a | none in the bound case | yes | 0 | about 15 | Not built. Whole-world frames take 150-300 ms, so rAF already runs below the snapshot rate and nothing is skipped. Only helps when the draw is already under 33 ms |
| Skip ray drawing off-screen | n/a | n/a | n/a | yes | 0 | 0 | Rays are only drawn for the one selected creature (8-20 lines), negligible |

## How the layer works

Active when items are tiny (under 1.5 device px radius) and at least 3000 exist. Each frame hashes the items of every 64 px tile (two 32-bit sums, order independent), compares with the last frame, repaints only the changed tiles (clip, clear, redraw the items touching the tile) and blits the layer with `drawImage` over the floor. A changed camera, canvas size or item size, or more than 30% changed tiles, repaints everything (same cost as today). Sim churn at 20k is about 7 items per tick (ecoBench --width 20000 --series: roughly 1100 eaten per 5 s), so a typical snapshot changes tens of tiles out of 330.

## Caveats

- The partial repaint differs slightly from a direct draw (antialiasing of the squares near tile edges, up to 14/255 on about 3% of pixels). A bit-exact cache would need the full path every frame.
- Timings under load 30 inflate CPU-bound JS (the hashing pass reads 8 ms here, probably under 1 ms on a quiet machine), so a quiet-machine re-measure is advisable.
- Creatures (about 100 ms here) are now the larger part of the whole-world frame and no exact speedup was found.
- Sim fingerprints untouched, render only. Tests: `ecoScene` passes, `tsc` clean. No new unit test for the layer (fake context has no pixels).
