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
- If every creature dies the run stops and offers Reseed or Edit settings.
- Stats: population, births, deaths, food and poison counts, and a population graph over time.
- Population cap 10000 (births wait at the cap); food scarcity should keep it well below.
- Default world 12000 x 7500 (about 56x the Trials area), founders at random positions with random colours, notably bigger than Trials; the view zooms and pans over the whole world.
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
| E5   | Performance: worker pool (postMessage), shared memory when cross-origin isolated (coi-serviceworker), WebAssembly SIMD brain and creature rays. E5a done: Ecosystem helper threads (`sim/ecoShare.ts`, `worker/ecoPool.ts`). E5b/E5c done: WASM kernels in Ecosystem sense and think (`sim/wasm/senseKernels.ts`, on by default) | E4 |

## Body plans, memory, seed pool (issues #4, #10, #11), draft
- Each creature carries a body plan: ray count, ray angle, vision length, hidden layers, memory size. Its genome is the plan plus weights sized by it.
- Energy per second also pays for sensing, `rayCost x rays x length / 100`, and for turning, so long or many rays are a trade-off, not free.
- Trials: one plan per run, set in the form as today; different plans compete across runs (the preset challenge, #8).
- Ecosystem: founders may differ. Vision angle and length drift slightly with mutation; rare structural mutations add or remove a ray or a hidden neuron, with weights remapped.
- Memory (#10): recurrent units fed back as brain inputs on the next tick, as leaky averages of their targets: short-term at rate 0.3 per tick, long-term at 0.01 per tick. Default 4 + 4, roughly up to 20% of the weights.
- A tiny energy cost per hidden and memory neuron per second, so bigger brains are not free (tunable, 0 turns it off).
- Seed pool (#11, done): `src/buildPool.ts` runs Trials evolutions over a sampled grid of plans and worlds and keeps 60 diverse validated creatures in `public/pool.json`. Ecosystem `poolFraction` (default 50%) of founders are mutated copies, round-robin over the pool; their Trials genomes get zero weights for the creature ray features. Without the file, all founders are random.

## Presets and lineages (issues #8, #5), draft
- Trials and Ecosystem get about 4 preset worlds (normal, poison everywhere, starvation with long vision, ...) plus custom; Trials worlds grow to 2300 x 1400.
- Top 3 per preset kept in this browser (localStorage); a global board needs a backend and comes later.
- Lineages (#5, done): every creature carries its `founderId` (inherited, a founder is its own). The Lineages card shows the top 8 founders by live count as a stacked bar, a legend (pool or random, share, count) and a stacked share history; clicking a lineage dims everyone else in the world, and the Selected card names the creature's founder. A family tree view comes later.
- Aging (#6, done): optional `eco.aging` (default off), `agingStart` seconds (120) and `agingRate` per minute (0.5); the upkeep is multiplied by 1 + rate x (age - start) / 60 after the start age.
- Collision damage (#13, done): optional `eco.collisionDamage` (default off) and `damagePerSpeed` (0.3). Each bounce costs both creatures `damagePerSpeed` x the normal approach speed, once per impact (head-on at top speed, 160 units/s, costs 48). If exactly one dies, the survivor gains the dead one's energy from just before the hit; if both die, nobody does.

## The Great Hunt (issue #12), agreed 2026-10-11
- Its own mode and landing card, third after Trials and Ecosystem; Live World moves to fourth.
- Built on the Ecosystem engine: plants (food) regrow, species A grazes plants, species B hunts A.
- Touching a prey eats it: the predator gains the prey's stored energy times an efficiency, plus a baseline (both settings).
- Species are fixed: children keep the parent's species. Each species has its own founders, body ranges, speed, costs and energy gain.
- Rays tell species apart and report the seen creature's energy.
- Later: a who-eats-whom table for more species (C, D, E).
- Known follow-ups:
  - Scoreboard entries keep only seed, creature and brain settings, not the species, birth, regrowth, aging or collision settings.
  - Lineages tend to collapse to one founder per species after about 10 minutes.
