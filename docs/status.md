# Status and decisions

Living notes: what we are doing now, what was decided and what is open.
Work here is iterative and nothing is fixed; update or delete lines as soon as they go stale.

## Now (2026-10-12)
- A1 Terrain and obstacle look: polish rock, ridges, mud and firm ground so they look refined when zoomed in, in the style of the map drafts in `docs/world-maps/`. Creatures sense the ground under them through the `terrain` input (-1 mud, 0 normal, 1 firm); keep what is drawn and what is sensed identical. Done 2026-10-12 on `polishA1b`: mud and firm are a smooth raster field (`groundField.ts`, domain-warped noise blobs, no disc unions), `valueAt` reads the field and `groundScene.ts` draws its exact 0.5 contour (test: `groundScene.test.ts`), so the look is organic and drawn equals sensed; map-on maps with mud or firm differ from before. Rock got a south cliff. The field can later carry food and poison weights (A2, biome raster). Open: a fresh-eyes visual review.
- A2 Live World map: build The Inland Sea (`docs/world-maps/2026-10-12-draft3-*`) for the live server after A1. Needs the engine plan in the draft notes (biome raster, weighted spawning, local food caps, rock from the spec, per-region trait stats). Before it ships, give the Live session: steady-state food and poison item counts, tick cost at the planned population (nice 19, no helpers), and the biome raster and save sizes, so it can set server bounds.
- A5 Live World food (Erik, 2026-10-12): food worth about 50 energy, slower regrowth, a fairly high food cap so food can pile up in quiet places (not extreme), poison scarce except in the map's poison regions. Launch with initial founders, watch, and retune live (all these are admin-tunable). Candidate values are being measured at 40000 x 25000.
- A3 Live World page: info section below the world (legend, ground shares from the server, world rules, a region table that fills once a map has regions) and the footer are built (L4, on development); the viewer-zoom inset and the Inland Sea's regions follow A2.
- A4 Visitor-inserted creatures: built (on development): start energy 300 and a 60 s first-birth hold, admin settings `add.startEnergy` and `add.birthHoldS` (no engine change: the hold is a last birth placed in the future).
- A6 Inland Sea launch starts empty (initialPopulation 0, Erik adds founders via the page). Live side needs: no auto-reseed of an empty world until the first add (`liveWorld.ts` reseeds on extinct), and a floor on the 10% added-alive cap (it is 0 at population 0). Erik to decide what happens if his founders die out later.
- C1 Starter founders (RL session, worktree `.claude/worktrees/founders`, branch `founders`): 3-5 pickable founders for visitors to drop into Live: a sitter that holds still and scans, an explorer, a big-brain thinker with lots of memory, and an aggressor. Trials stage, then RL generalisation, then a test in a world with `liveConfig`. They replace `src/typescript/public/live-founders.json` (now four pool picks).
- B1 Speed: round 3 done (about 1.35x at 50000 wide, bit-identical); write-ups in `docs/perf-explore/`.

## Decisions
- 2026-10-12: `main` is the release, all work goes to `development`, releases are pull requests (CLAUDE.md, Git). Versions start at 0.1.0.
- 2026-10-12: The Great Hunt removed; focus on Live and Ecosystem, with Trials and RL Arena for training.
- 2026-10-12: The Inland Sea is the next Live World map, built first at 5.5x today's area (about 40000 x 25000), growing to 10x later if creatures still meet often (#36).
- 2026-10-12: Version history lives in `docs/changes.md` (renamed from releases.md); 0.1.1 removes The Great Hunt.
- 2026-10-12: Inland Sea launch settings: new food values apply at launch (not to today's world); the world starts empty and Erik drops founders in via the page; max population 2500 (admin-adjustable); seasons with a one hour year.

## Open questions for Erik
- Release review rules (empty section in CLAUDE.md).
- GitHub branch protection for `main`.
