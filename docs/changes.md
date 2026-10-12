# Changes

What changed in each version, newest first, so release notes for any range (say 0.1.1 to 0.2.0) can be put together from here.
Each release is a pull request from `development` into `main`, tagged `vX.Y.Z` on `main`.
Add notes under "Unreleased" as work lands on `development`, and turn that heading into the version number at release time.

## Unreleased
- Live World: the page opens on a card to watch the world or add your own creature. "Add your creature" picks one of four founders (or a creature file from the RL Arena), tunes its vision, brain and birth traits with a live energy-per-second readout, can train it for 30 s in the browser, and adds 1 to 3 named copies; the page then follows one and lights its family. The server caps adds (20 creatures per 5 minutes for everyone, 3 per visitor, added creatures at most 10% of the population); added creatures start with 300 energy and have their first child no sooner than 60 s after they arrive (admin settings). Protocol 4: names, u32 founder ids. Below the world, an info section with the legend, ground shares and the world's rules, and a footer with the version and source link.
- Live World saves no longer keep a lineage row for every visitor-inserted founder: a runtime lineage is dropped when its last member dies, and older saves drop such rows on load.

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
