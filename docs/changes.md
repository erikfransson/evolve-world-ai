# Changes

What changed in each version, newest first, so release notes for any range (say 0.1.1 to 0.2.0) can be put together from here.
Each release is a pull request from `development` into `main`, tagged `vX.Y.Z` on `main`.
Add notes under "Unreleased" as work lands on `development`, and turn that heading into the version number at release time.

## Unreleased

- Ecosystem fixes on The Inland Sea: the legend now lists Rock, Mud, Firm ground and the poison and rich food tints (it read the random-terrain densities, which are 0 on a map), and Start no longer makes every helper thread build the map (several seconds each, which could trip the start timeout and drop to one thread): the coordinator sends the built arrays and the results are unchanged. Time to first frame in headless Chrome on a busy machine went from 50 s (helpers failed) to 26 s.
## 0.2.0 (2026-10-14)

### Live World
- Landing page polish: a hero with buttons to watch the Live World or create your own, a Live World card that shows the real Inland Sea from above with six lineages grazing, giving birth and dying, its live numbers (creatures alive, people watching) from the server, a busier Ecosystem card, a short "How it works" (sense, think, evolve), a fuller footer, and share previews (description, Open Graph and Twitter tags, a 1200 x 630 image). The Trials card's rays no longer reach past the arena wall.
- Live server: `GET /stats` answers `{"creatures", "viewers"}` for the landing page (public, cacheable for 10 s, rebuilt at most once a second, 5 requests a second for all callers with a burst of 20, past that a 503; every other plain request still gets a 426).
- Live World moves to The Inland Sea (40000 x 25000) with the launch food values (food worth 50, slower regrowth, cap 1.5, scarce poison), a one hour year and 3x speed. A fresh world starts with 10 of each starter founder; saves of the old world are not restored and are deleted by the usual rotation after 4 days. The page draws the map (built on a worker from its name), and the info section lists its regions with their food and poison.
- `eco.birthReserve`: births stop this many creatures below `maxPopulation` while inserted creatures may still fill up to it (default 0; admin-tunable on Live up to 1000), so Live visitors can add creatures after a boom.
- Live World: an extinct world stays empty until visitors add creatures again (admin `reseed=1` brings back the restart), at least 20 added creatures may be alive however small the population (`add.aliveFloor`), and children change colour less (3 degrees, was 8) so families keep their colour. An empty world still shows its map, with a note and a button to add a creature.
- Live World: the page opens on a card to watch the world or add your own creature. "Add your creature" picks one of four founders (or a creature file from the RL Arena), tunes its vision, brain and birth traits with a live energy-per-second readout, can train it for 30 s in the browser, and adds 1 to 3 named copies; the page then follows one and lights its family. The server caps adds (20 creatures per 5 minutes for everyone, 3 per visitor once the tunnel's visitor address is checked, added creatures at most 10% of the population); added creatures start with 300 energy and have their first child no sooner than 60 s after they arrive (admin settings). Protocol 4: names, u32 founder ids. Below the world, an info section with the legend, ground shares and the world's rules, and a footer with the version and source link.
- Live page states: a server still on the older protocol (the page released before the server) shows "Updating" and keeps retrying instead of asking for a reload, which is left for a server newer than the page. The info section stays hidden until the world has sent its data, and on phones the status pill reads in full.
- Live World saves no longer keep a lineage row for every visitor-inserted founder: a runtime lineage is dropped when its last member dies, and older saves drop such rows on load.

### Maps and terrain
- Rock outlines are about 15 times faster: on the Inland Sea they took 15.3 s on the main thread (3855 discs, mostly nearest-disc snapping), now about 1 s for every body and less when only some are in view, because each body is traced when first drawn. The result is the same to 1e-11 units, and the Voronoi facets and cracks match to 1e-6. `rockGeometry(terrain)` in `ui/rockOutline.ts` returns the outlines as transferable typed arrays (no DOM) for a Web Worker, and `useRockGeometry(terrain, geometry)` hands them to a Terrain; the Ecosystem page traces lazily in its render worker.
- The Inland Sea look: cliff and massif edges read as broken rock (no round bumps), stones and Drowned Town outcrops are angular, and the Ashfall poison shore has a subtle tint.
- Hand-designed maps: `world.map` names a map (`src/sim/maps/`) that replaces the random stones, mud and firm ground. A map brings its own ground raster, rock, and food and poison weights: items spawn and regrow in proportion to the weights, with local caps per 1000 unit cell, and founders favour rich places. Saves store only the name. The first map is The Inland Sea (40000 x 25000), an Ecosystem preset with the launch food values. Worlds without a map are unchanged bit for bit. The ground outline no longer breaks where the field is exactly one half between two raster cells.
- Terrain polish: mud and firm ground are a smooth field on a coarse raster instead of unions of circles, so patches have organic, ragged outlines at the same coverage and patch size settings. The edge is the exact 0.5 contour of that field, which is where creatures sense the ground (the field is also cheaper to build). Mud is a wet-earth texture with a smooth lighter shallow rim, firm ground is dry, packed earth with grit and a crisp edge. Ground is drawn from cached bitmaps from afar, so whole-world frames are cheap. Rock gets a shadowed south cliff face. Maps with mud or firm ground generate differently than before (rock and map-off runs are unchanged).

### Speed
- Speed: The Inland Sea at 10k creatures on one thread went from about 70 to about 46 ms CPU per tick (about 35 ms on a quiet machine), with results bit-identical:
  - Helper threads use the resident creature rows too: with 3 helpers the CPU per tick drops about 1.3x and the coordinator's share from about 37 to 24 ms at 10k creatures on The Inland Sea, results unchanged.
  - Eating walks only the creatures that touch an item and the crowd rebuild skips a species copy: about 1.04x per tick on The Inland Sea, results unchanged.
  - Creature body state lives in rows in WASM memory (physics stays in JS): about 1.15x per tick on big worlds, results unchanged, about 7% less memory. With the round 1 and memory-growth changes, The Inland Sea at 10k creatures went from 70 to about 48 ms CPU per tick.
  - WASM memory now grows by at least an eighth at a time instead of page by page (each grow copied the whole memory): about 1.14x per tick on The Inland Sea at 10k creatures, results unchanged, about 10% more memory.
  - Faster simulation on big maps (about 1.08x on The Inland Sea at 10k creatures, results unchanged): one array-based collision pass for every mode, item lookups in grid order, keepOut skips rock where none is near, and a faster birth scan.

### RL Arena
- RL Arena: "Start from" has a Founders choice with the four Live World starter founders (#39), so a founder can be trained further and saved or added to Live from its file.
- RL Arena: a new "Bigger" env group after Advanced with five Live-like worlds (1000 to 2200 wide, 90 s, regrowing food, lethal poison, 8 to 25 seed pool foragers, bumps hurt, start energy 300): Live patch, Feast and famine, Busy meadow, Poison country and Crowded commons.
- RL Arena fix: rams now count. A rival killed by bumping into the learner never raised the learner's energy (it gets the rival's energy from before the hit, at most the damage it took), so the ram reward in Aggressor and Brawl never paid out. A ram is now a rival that dies touching the learner, and no other rival, with energy left the tick before (a rival eating poison while touching the learner also counts).

## 0.1.1 (2026-10-12)
- Removed The Great Hunt page. The site focuses on Live World and Ecosystem, with Trials and RL Arena as places to train creatures. The two-species engine stays for the RL Arena, and old `predators/` links redirect to the landing page.

## 0.1.0 (2026-10-12)

First numbered release, covering everything built so far.
- Modes: Trials, Ecosystem, The Great Hunt (predators and prey), RL Arena, and Live World (one shared world on a server, watched by everyone).
- World: food and poison with regrowth, seasons, obstacles (rock boulders and ridges) and terrain (mud and firm ground) with a terrain brain input.
- Creatures: ray vision, evolved brains with short and long memory, heritable birth traits, lineages and records.
- Engine: WebAssembly sense and brain kernels, helper threads, render worker, Gentle on CPU; bit-identical results across threads.
- Live World: versioned saves (format 2), protocol 3, sandboxed server with abuse-tested limits.
- Live World shows the release it runs ("Evolve World vX.Y.Z" under the side panel), and the server's own version when it differs during a deploy.
- Live World map proposals for #36 in `docs/world-maps/` (design only, not built).
- Obstacles redrawn: stones are angular faceted boulders and ridges as ranges of rock slabs with loose pebbles, lit from the upper left, with the drawn edge exactly where creatures bounce. Mud and firm ground lose their ripple and chevron marks (the legend names them), and Trials, Ecosystem and The Great Hunt get a size setting for each (Mud patch size, Firm patch size). A browser save made with the map on restores with the new rock shapes.
- RL Arena: a page left open across a redeploy says to reload instead of "the training worker crashed".
