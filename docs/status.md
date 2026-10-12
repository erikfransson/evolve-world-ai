# Status and decisions

Living notes: what we are doing now, what was decided and what is open.
Work here is iterative and nothing is fixed; update or delete lines as soon as they go stale.

## Now (2026-10-12)
- A1 Terrain and obstacle look: polish rock, ridges, mud and firm ground so they look refined when zoomed in, in the style of the map drafts in `docs/world-maps/`. Creatures sense the ground under them through the `terrain` input (-1 mud, 0 normal, 1 firm); keep what is drawn and what is sensed identical. Done 2026-10-12 on `polishA1`: `groundScene.ts` draws mud and firm from the exact patch outlines (test: `groundScene.test.ts`), patches got shore bumps (map-on maps with mud or firm differ from before), rock got a south cliff. Open: a fresh-eyes visual review.
- A2 Live World map: build The Inland Sea (`docs/world-maps/2026-10-12-draft3-*`) for the live server after A1. Needs the engine plan in the draft notes (biome raster, weighted spawning, local food caps, rock from the spec, per-region trait stats).
- B1 Speed: round 3 done (about 1.35x at 50000 wide, bit-identical); write-ups in `docs/perf-explore/`.

## Decisions
- 2026-10-12: `main` is the release, all work goes to `development`, releases are pull requests (CLAUDE.md, Git). Versions start at 0.1.0.
- 2026-10-12: The Inland Sea is the next Live World map.

## Open questions for Erik
- Live map size: 5.5x today's area (about 40000 x 25000, suggested) or 10x.
- Release review rules (empty section in CLAUDE.md).
- GitHub branch protection for `main`.
