# Status and decisions

Living notes: what we are doing now, what was decided and what is open.
Work here is iterative and nothing is fixed; update or delete lines as soon as they go stale.

## Now (2026-10-12)
- A1 Terrain and obstacle look: polish rock, ridges, mud and firm ground so they look refined when zoomed in, in the style of the map drafts in `docs/world-maps/`. Creatures sense the ground under them through the `terrain` input (-1 mud, 0 normal, 1 firm); keep what is drawn and what is sensed identical.
- A2 Live World map: build The Inland Sea (`docs/world-maps/2026-10-12-draft3-*`) for the live server after A1. Needs the engine plan in the draft notes (biome raster, weighted spawning, local food caps, rock from the spec, per-region trait stats). Before it ships, give the Live session: steady-state food and poison item counts, tick cost at the planned population (nice 19, no helpers), and the biome raster and save sizes, so it can set server bounds.
- A5 Live World food (Erik, 2026-10-12): food worth about 50 energy, slower regrowth, a fairly high food cap so food can pile up in quiet places (not extreme), poison scarce except in the map's poison regions; launch, watch and retune live (all admin-tunable). Proposed launch values at 40000 x 25000: foodEnergy 50, foodRegrow 0.003, foodMaxDensity 1.5, poisonRegrow 0.0003, poisonMaxDensity 0.01, seasons with yearMinutes 60. From a quarter-area run scaled x4: population about 800-2300 over the year, food about 10-12k items, poison at its 1000 cap, 9.8 CPU ms per tick at 1100-2500 creatures (nice 19, no helpers), peak RSS 344 MB, save 13 MB at 1192 creatures. Not yet checked at full size or for pile-up in ungrazed places.
- A3 Live World page: info section below the world (legend, ground shares from the server, world rules, a region table that fills once a map has regions) and the footer are built (L4, on development); the viewer-zoom inset and the Inland Sea's regions follow A2.
- A4 Visitor-inserted creatures: built (on development): start energy 300 and a 60 s first-birth hold, admin settings `add.startEnergy` and `add.birthHoldS` (no engine change: the hold is a last birth placed in the future).
- A6 Inland Sea launch (Erik, 2026-10-12): seed it with 10 of each starter founder (C1), not empty. If everything dies out it stays empty for visitors to repopulate, no restart (built: `reseed` 0, `add.aliveFloor` 20). Still to build at launch: the 10-per-founder seeding.
- A7 Inland Sea, live-side checks before launch (from session 16's numbers): item slots must fit the protocol's 262144 (`MAX_ITEM_SLOTS`), but `ITEM_HEADROOM` 3/1 at 40000x25000 gives about 300k food plus 100k poison slots, so headroom has to scale with area (slots = max(start, cap) per kind, density 1 = one item per 100x100, so 100000 per density unit there; food 2 + poison 0.05 gives 205000, and the caps proposed for launch need 151000); size the full item set (up to 150k food at cap 1.5) against the frame budget; tick cost 9.8 ms means about 3.4x at most on one idle core, so set `speed` to 3 or accept less; save about 13 MB at 1200 creatures, so measure save, verify and RSS at 2500 under MemoryMax 1G.
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
