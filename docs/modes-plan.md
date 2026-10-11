# Modes plan (2026-10-10)

The site becomes a landing page with one card per mode.
All modes share one engine (world items, ray casting, creature physics, brain, mutation); each mode owns its layout, loop and drawing.

| Mode           | Path          | State                                                                                          |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Trials         | `trials/`     | The current app: each creature alone in its world copy, generations.                           |
| Ecosystem      | `ecosystem/`  | New: one shared world, regrowing food, births, collisions.                                     |
| The Great Hunt | `predators/`  | Ecosystem engine with two species: plants feed prey, predators hunt prey.                      |
| RL Arena       | `arena/`      | Design a creature, train it with evolution strategies in short environments, watch and save.   |
| Live World     | `live/`       | Placeholder: an always-on shared world, built later.                                           |

Landing page at the site root: big "Evolve World" title and a selection card per mode, each with a small animated or drawn preview of what happens there.
Vite multi-page build, so each mode has its own `index.html` and entry script.

## Ecosystem rules (defaults, all tunable before Start)
- One world, all creatures live in it together, simulated in a worker and rendered live.
- Food regrows at `foodRegrowRate` items per second per density cell, up to `foodMaxDensity`.
- Poison regrows at `poisonRegrowRate` up to `poisonMaxDensity`, so the board cannot fill with poison.
- Start energy 50, one food gives 20.
- Each creature carries its own birth energy, birth cost and birth cooldown, drawn for founders from run-setting ranges (defaults 100-225, 50-110, 5-20 s) and nudged by `birthDrift` in each child. The child starts with exactly the energy the parent pays, and a parent that pays all it has dies.
- The child appears next to the parent and leaves at `birthSpeed` relative to it, split between them so momentum is kept and they do not collide at once.
- The child gets the parent's genome with mutation and the parent's colour with a small hue drift; every founder gets a random colour.
- A creature's energy fill is full at the middle of the birth energy range.
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
- Seed pool (#11, done): `src/buildPool.ts` runs Trials evolutions over a sampled grid of plans and worlds and keeps 300 diverse validated creatures in `public/pool.json`. Ecosystem `poolFraction` (default 30%, 50% per species in the Great Hunt) of founders are mutated copies, round-robin over the pool; their Trials genomes get zero weights for the creature ray features. Without the file, all founders are random.

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
  - Lineages tend to collapse to one founder per species after about 10 minutes.

## RL environments and Arena (issues #27, #32), agreed 2026-10-11
- Environments are short episodes (30 to 120 s) on the Ecosystem engine, so a creature trained there acts the same in the Ecosystem or The Great Hunt. Index and measured learning: `docs/rl-envs.md`.
- Learning is evolution strategies on the creature's weights (`src/sim/rl/es.ts`), a nudge from its current weights.
- Arena page (`arena/`): design a creature (kind, rays, brain, memory) or start from a pool founder or a file, pick or customise environments, train, watch the best candidate in up to 9 environments and its brain, save the creature.
- Trained rivals live in `public/rl/library.json` by env id; later envs draw on them, so hunters and prey train each other.

## Uploaded creatures and settings (Live World), required before any upload exists
Visitors will upload creature files and settings that then run on our server. Treat every upload as hostile data.
- Data only. A creature file is JSON that is parsed, never evaluated or imported as code, and never used as a key path, a file path or HTML. `parseCreatureFile` (`src/sim/rl/creatureFile.ts`) is the one gate: it rebuilds every kept value from checked numbers and short plain strings and drops everything else.
- Bounded cost. Plans stay within `PLAN_LIMITS`, genomes match their plan's exact length with finite bounded weights, files have a size cap, and worlds and settings have the same limits as the forms (`ENV_LIMITS`, `checkEnv`), so no upload can make the simulation slow or large. The server enforces per-user and global limits on uploads and creature counts.
- No injection. Store uploads as parsed values through parameterised queries or a document store API, never by string-building queries or shell commands. Names render with `textContent`, never `innerHTML`.
- Isolation. The server simulation runs without file, network or process access beyond its job, under memory and CPU limits, so a bug in validation still cannot reach the host.
- Re-validate on the server. The browser's checks are a convenience; the server runs the same parser on every upload and on every value read back from storage.
