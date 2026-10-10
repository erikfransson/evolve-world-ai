# Modes plan (2026-10-10)

The site becomes a landing page with one card per mode.
All modes share one engine (world items, ray casting, creature physics, brain, mutation); each mode owns its layout, loop and drawing.

| Mode       | Path          | State                                                                 |
| ---------- | ------------- | --------------------------------------------------------------------- |
| Trials     | `trials/`     | The current app: each creature alone in its world copy, generations. |
| Ecosystem  | `ecosystem/`  | New: one shared world, regrowing food, births, collisions.            |
| Live World | `live/`       | Placeholder: an always-on shared world, built later.                  |

Landing page at the site root: big "Evolve World" title and a selection card per mode, each with a small animated or drawn preview of what happens there.
Vite multi-page build, so each mode has its own `index.html` and entry script.

## Ecosystem rules (defaults, all tunable before Start)
- One world, all creatures live in it together, simulated in a worker and rendered live.
- Food regrows at `foodRegrowRate` items per second per density cell, up to `foodMaxDensity`.
- Poison regrows at `poisonRegrowRate` up to `poisonMaxDensity`, so the board cannot fill with poison.
- Start energy 50, one food gives 20.
- Birth when energy reaches 150: the parent pays 75, the child starts with 50 next to the parent.
- After a birth the parent waits `birthCooldown` seconds (default 10) before the next one.
- The child is launched in a random direction at `birthSpeed` instead of sitting still next to the parent.
- The child gets the parent's genome with mutation and the parent's colour with a small hue drift; every founder gets a random colour.
- A creature's energy fill is full at the birth threshold.
- Creatures collide and bounce off each other.
- Rays also see creatures: a creature hit flag, plus the seen creature's energy (squashed like the own energy input).
- Trials keeps its current ray inputs.
- If every creature dies the run stops and offers Reseed or Back to menu.
- Stats: population, births, deaths, food and poison counts, and a population graph over time.
- Population cap 10000 (births wait at the cap); food scarcity should keep it well below.
- Default world 8000 x 5000 (25x the Trials area), founders at random positions with random colours, notably bigger than Trials; the view zooms and pans over the whole world.
- Click a creature to follow it zoomed in (rays, brain, energy, age, children, lineage depth); a World view button zooms back out.
- Speed buttons 1x to 32x plus Max (simulate as fast as possible, draw a few frames per second), pause and resume.
- Brain inputs in both modes gain sideways speed; Ecosystem rays add a creature flag and the seen creature's energy.

## Ecosystem build plan
Contract: `EcoConfig` in `src/sim/ecoConfig.ts`, built on `EngineConfig` (the shared part of `SimConfig`).

| Step | Work                                                                                              | Depends on |
| ---- | ------------------------------------------------------------------------------------------------- | ---------- |
| E1   | Engine: input layout (sideways speed, creature hits), `Ecosystem` step, regrowth, births, collisions, headless bench | contract   |
| E2   | Camera: zoom at cursor, drag and pinch pan, fit world, smooth follow                              | -          |
| E3   | Page shell: settings form, controls, stat tiles, cards, extinction overlay                        | contract   |
| E4   | Worker, snapshot protocol, rendering with camera, selection and follow, brain panel, graph        | E1 to E3   |
| E5   | Performance: worker pool (postMessage), shared memory when cross-origin isolated (coi-serviceworker), WebAssembly SIMD brain and creature rays | E4 |
