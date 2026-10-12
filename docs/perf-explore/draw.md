# Draw cost at 30k-50k width (headless Chrome, software raster)

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| One culling pass over items (visible indices per kind, snapshot order kept) instead of two full passes | zoomed 2850 wide, eco 50k: med 22.7 ms (min 13.6) | med 13.4 (min 11.6) | 1.2-1.7x zoomed in, 1.2x at max zoom; whole world and dots view unchanged | Yes, 0 differing bytes (FNV hash of all 1400x900 RGBA) in 12 scenes, both pages, with selection and highlight | +4 B per item (about 0.5 MB at 125k items) | +17 | Merge, small |
| Sort items by row or tile before the path fill | 526 ms | 477-524 ms | none | No (hash differs, fill order changes pixels) | 0 | n/a | Rejected |
| Everything else asked (culling creatures and items, colour batching, no save/restore, no shadow or font, Path2D reuse) | n/a | n/a | n/a | n/a | 0 | 0 | Already in place or no effect, see below |

Setup: Chrome headless, SwiftShader, canvas 1400 x 900 dpr 1, radius 12, item radius 4, synthetic snapshot (9500 creatures and 125k items at 50000 x 31250, 6000 creatures at 30000 for the Hunt with every 4th a hunter). Load average 10-25 from other sessions, so only ratios mean something. Harness in scratchpad `opt3/draw/` (bundles the real `EcoRenderer`, base and new in one page, alternating, 3 pairs of 8 draws each, flush forced by `getImageData`).

Frame times (median ms, base / new):
- eco 50k whole world 731 / 744 (min 683 / 689), hunt 30k whole 544 / 546
- eco 50k dots view (zoom x3.7, ~770 creatures) 60 / 58, hunt 28.5 / 27
- eco 50k zoom x18 (about 30 detailed creatures, 450 items) 22.7 / 13.4, hunt 7.9 / 7.4
- eco 50k zoom x70 9.2 / 7.5, hunt 4.6 / 4.1

Where the whole-world frame goes (eco 50k, medians): empty 2 ms, items only 544, creatures only 207, both 754. Hunt 30k: items 157, creatures 389. Building the item path (125k `rect` calls) is 30 ms, the other 500 ms is Skia rasterising 500k edges. Ordering the rects does not help and changes pixels.

Findings on the asked list:
- Culling of creatures and items already exists (one pass for creatures, bounds with padding). The item cull ran twice (once per kind); that is the fix above. Remaining zoomed-in cost is that one scan of 125k items (about 1-3 ms on a quiet machine). Skipping it needs items sorted by cell in the snapshot, which changes path order and so pixels.
- Fills are already batched by colour (one path per item kind, one per creature colour bucket plus the outline pass). `save`/`restore` appears only for hunters at detail zoom (at most 800 creatures). No shadow, no font. Path2D reuse does not apply, every path is new each frame.
- The whole-world frame is raster bound (item rects 70%, creature dots 30% at 50k). No exact speedup found. The only large lever is the near-exact tiled item layer in `render50.md` (items about 3x faster). On a GPU canvas the picture differs and was not measured.
- Caveat: software raster only. A GPU-backed worker canvas may make the rect path much cheaper; test on real hardware before spending more here.
