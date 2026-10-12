# Release notes

Newest first. Each release is a pull request from `development` into `main`, tagged `vX.Y.Z` on `main`.
Add notes under "Unreleased" as work lands on `development`, and turn that heading into the version number at release time.

## Unreleased

- Terrain polish: mud and firm ground are a smooth field on a coarse raster instead of unions of circles, so patches have organic, ragged outlines at the same coverage and patch size settings. The edge is the exact 0.5 contour of that field, which is where creatures sense the ground (the field is also cheaper to build). Mud is a wet-earth texture with a lighter shallow rim, firm ground is desaturated sage with fine streaks and a crisp edge. Rock gets a shadowed south cliff face. Maps with mud or firm ground generate differently than before (rock and map-off runs are unchanged).

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
