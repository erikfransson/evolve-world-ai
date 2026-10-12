# Changes

What changed in each version, newest first, so release notes for any range (say 0.1.1 to 0.2.0) can be put together from here.
Each release is a pull request from `development` into `main`, tagged `vX.Y.Z` on `main`.
Add notes under "Unreleased" as work lands on `development`, and turn that heading into the version number at release time.

## Unreleased
- Hand-designed maps: `world.map` names a map (`src/sim/maps/`) that replaces the random stones, mud and firm ground. A map brings its own ground raster, rock, and food and poison weights: items spawn and regrow in proportion to the weights, with local caps per 1000 unit cell, and founders favour rich places. Saves store only the name. The first map is The Inland Sea (40000 x 25000), an Ecosystem preset with the launch food values. Worlds without a map are unchanged bit for bit. The ground outline no longer breaks where the field is exactly one half between two raster cells.
- Live World: an extinct world stays empty until visitors add creatures again (admin `reseed=1` brings back the restart), at least 20 added creatures may be alive however small the population (`add.aliveFloor`), and children change colour less (3 degrees, was 8) so families keep their colour. An empty world still shows its map, with a note and a button to add a creature.
- Live World: the page opens on a card to watch the world or add your own creature. "Add your creature" picks one of four founders (or a creature file from the RL Arena), tunes its vision, brain and birth traits with a live energy-per-second readout, can train it for 30 s in the browser, and adds 1 to 3 named copies; the page then follows one and lights its family. The server caps adds (20 creatures per 5 minutes for everyone, 3 per visitor once the tunnel's visitor address is checked, added creatures at most 10% of the population); added creatures start with 300 energy and have their first child no sooner than 60 s after they arrive (admin settings). Protocol 4: names, u32 founder ids. Below the world, an info section with the legend, ground shares and the world's rules, and a footer with the version and source link.
- Live World saves no longer keep a lineage row for every visitor-inserted founder: a runtime lineage is dropped when its last member dies, and older saves drop such rows on load.
- Terrain polish: mud and firm ground are a smooth field on a coarse raster instead of unions of circles, so patches have organic, ragged outlines at the same coverage and patch size settings. The edge is the exact 0.5 contour of that field, which is where creatures sense the ground (the field is also cheaper to build). Mud is a wet-earth texture with a smooth lighter shallow rim, firm ground is dry, packed earth with grit and a crisp edge. Ground is drawn from cached bitmaps from afar, so whole-world frames are cheap. Rock gets a shadowed south cliff face. Maps with mud or firm ground generate differently than before (rock and map-off runs are unchanged).

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
