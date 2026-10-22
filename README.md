# Evolve World AI

<p align="center">
  <a href="https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml"><img src="https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml/badge.svg" alt="Test and deploy"></a>
  <a href="https://erikfransson.github.io/evolve-world-ai/coverage/"><img src="https://erikfransson.github.io/evolve-world-ai/coverage/badge.svg" alt="Coverage"></a>
  <a href="https://github.com/erikfransson/evolve-world-ai/actions/workflows/deploy.yml"><img src="https://erikfransson.github.io/evolve-world-ai/coverage/tests-badge.svg" alt="Tests"></a>
</p>
<p align="center">
  <a href="https://erikfransson.github.io/evolve-world-ai/"><img src="docs/badges/play.svg" alt="Play in your browser"></a>
  <img src="docs/badges/evolutionary-simulation.svg" alt="Evolutionary simulation">
  <img src="docs/badges/neuroevolution.svg" alt="Neuroevolution">
  <img src="docs/badges/reinforcement-learning.svg" alt="Reinforcement learning">
  <img src="docs/badges/artificial-life.svg" alt="Artificial life">
</p>
<p align="center">
  <img src="docs/badges/typescript.svg" alt="TypeScript">
  <img src="docs/badges/webassembly.svg" alt="WebAssembly SIMD">
  <img src="docs/badges/vite.svg" alt="Vite">
</p>

<h3 align="center"><a href="https://erikfransson.github.io/evolve-world-ai/">Open Evolve World →</a></h3>
<p align="center">Creatures with small neural-network brains evolve in your browser: press Start and watch them learn to find food, dodge and share a world.</p>

<table align="center">
  <tr>
    <td align="center" colspan="2"><a href="https://erikfransson.github.io/evolve-world-ai/live/"><img src="docs/media/live.gif" width="320" alt="Live World"></a><br><a href="https://erikfransson.github.io/evolve-world-ai/live/"><b>Live World</b></a></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><a href="https://erikfransson.github.io/evolve-world-ai/ecosystem/"><img src="docs/media/ecosystem.gif" width="320" alt="Ecosystem"></a><br><a href="https://erikfransson.github.io/evolve-world-ai/ecosystem/"><b>Ecosystem</b></a></td>
  </tr>
  <tr>
    <td align="center"><a href="https://erikfransson.github.io/evolve-world-ai/trials/"><img src="docs/media/trials.gif" width="300" alt="Trials"></a><br><a href="https://erikfransson.github.io/evolve-world-ai/trials/"><b>Trials</b></a> (train creatures)</td>
    <td align="center"><a href="https://erikfransson.github.io/evolve-world-ai/arena/"><img src="docs/media/arena.gif" width="300" alt="RL Arena"></a><br><a href="https://erikfransson.github.io/evolve-world-ai/arena/"><b>RL Arena</b></a> (train creatures)</td>
  </tr>
</table>

## Repo structure
* `src/typescript/` web app and simulation (Vite + TypeScript), one HTML page per mode
  * `index.html` landing page, `trials/`, `ecosystem/`, `arena/` (RL Arena: design, train and watch creatures), `live/` (Live World viewer)
  * `src/sim/` simulation; `creature.ts` (body, brain, senses) and `world.ts` (items, rays) are shared by modes
  * `src/sim/terrain.ts` the map (#34): stones and ridges creatures bounce off and rays see as walls, and mud and firm ground that change their speed (50% and 175%); generated from the seed (or replaced by a named map, see `src/sim/maps/`), shared by all modes (`world.stoneDensity` and the other three, each a share of the world area, 0 for none). Brains get a terrain input; `upgradeGenome` (in `brain.ts`) adds it, as zero weights, to genomes made before it
  * `src/sim/groundField.ts` the mud and firm ground as a smooth raster field (50 to 100 unit cells, one byte per kind per node, bilinear, 0.5 threshold); `Terrain.valueAt` reads it and `src/ui/groundOutline.ts` draws its exact 0.5 contour, so drawn and sensed ground agree. Maps carry their food and poison weights in the same raster (`src/sim/maps/mapBuild.ts`)
  * `src/sim/maps/` hand-designed world maps (`world.map` names one), The Inland Sea (50000 x 31250) is the Live World map; specs are scaled from `docs/world-maps/` drafts by `docs/world-maps/tools/to-engine.mjs`
  * `src/sim/ecosystem.ts` the Ecosystem and its tick; its parts are `memberTable.ts` (the living creatures and the columns the hot loops read), `contacts.ts` (eating, hunting, collisions), `itemEconomy.ts` (food and poison counts, caps, regrowth) and `ecoInsert.ts` (checks of a runtime insert)
  * `src/sim/species.ts` species of a multi-species world (own body ranges, costs, births and diet), used by the RL Arena; the Ecosystem is the one-species case
  * `src/sim/rl/` RL environments, evolution strategies learner and creature library. `src/rlTrain.ts` and `src/rlBench.ts` are its command-line entry points
  * `src/worker/` simulation workers and helpers; `renderWorker.ts` draws the Ecosystem on an OffscreenCanvas, fed snapshots by the simulation worker. It is on where the browser supports it, and the page draws instead when it is not (or with `?offscreen=0`)
  * `src/worker/mapWorker.ts` builds a map (ground, rock) off the main thread for the pages
  * `src/ui/landing/` the landing page cards (Live World, Ecosystem, Trials, Arena) and live stats
  * `scripts/` build and maintenance scripts (WASM assembly, coverage badge, `pickFounders.ts`); `scripts/landing/` makes the landing images (`mapshot`, `og.jpg`)
  * `src/trials.ts`, `src/ecosystem.ts`, `src/landing.ts`, `src/arena.ts`, `src/live.ts` one entry script per page; `predators/index.html` only redirects old Great Hunt links to the landing page
  * `src/sim/wasm/` optional WebAssembly SIMD kernels (brain forward, one-call sense); `.wat` sources are assembled into `kernels.generated.ts` with `npm run wasm` (wabt), and a test fails if they drift
  * `public/pool.json` Ecosystem seed pool: 300 Trials-trained founders picked for diversity from two `node src/buildPool.ts` sweeps and the earlier pool; the file's `command` field holds the recipe (each sweep about 3 h on 6 threads)
  * `public/coi-serviceworker.js` self-unregistering stub, kept at the old URL because visitors may still have the retired shared-memory service worker installed; on its next update check it removes itself and reloads their pages once. Nothing registers it any more, so it can be deleted once old installs are unlikely
* `server/` the Live World server (see `server/README.md`); `src/typescript/src/live/` holds the page modules
* `src/python/` planned analysis of headless run output (empty so far)
* `docs/` status (`status.md`), version history (`changes.md`), plans, tuning and perf notes, `world-maps/`
* `tests/` tests for all code

## What this is
A live evolution simulation that runs in the browser: press Start and watch creatures evolve.
The same TypeScript simulation also runs headless (Node) for batch runs, to be analysed in Python (planned).

