# Initial plan (rough draft)

This is the starting point, kept as history, not a specification.
The values below are the first guesses. The current defaults are in `src/typescript/src/sim/config.ts` and the modes in `docs/modes-plan.md`.

## Idea
Small blob creatures move around a big world with walls, food, and optionally poison.
Each creature sees only through a fan of short laser rays and is driven by a small neural network.
A genetic algorithm evolves the networks over generations while the user watches.

## Current guesses

| Topic      | Current guess                                                                                       |
|------------|-----------------------------------------------------------------------------------------------------|
| Evolution  | Generational: run an epoch, score each creature, breed the next generation, reset the world         |
| Vision     | 8 rays spread over about 75 degrees, length about 10% of the screen at default zoom                |
| Ray input  | Per ray, closeness (0 to 1) and what was hit (food, poison, wall), plus energy, speed and turn rate  |
| Brain      | Inputs, then 1 to 4 hidden layers of 4 to 32 neurons, then outputs for turn and thrust              |
| World      | 1600 x 1000 box with solid walls, food and poison given as densities, eaten items are gone (optional regrowth) |
| Layout     | Same layout for every creature in a generation, new layout each generation                          |
| Isolation  | Each creature lives alone in its own copy of the world, so a generation can be simulated in parallel |
| Watching   | The worker computes a generation fast, the page replays it by re-running from the seed            |
| Energy     | Start at half of max energy (max 100), constant cost for being alive, cost proportional to thrust   |
| Movement   | Fish-like: thrust forward against drag, high sideways drag, smoothed turning                        |
| Food       | Eating food gives about +20 energy                                                                  |
| Poison     | Eating poison removes 200 energy, so it is always lethal                                            |
| Engine     | Fixed timestep and seeded randomness, simulation code separate from drawing, runs in a Web Worker  |
| Headless   | The same simulation runs under Node for batch runs, with results analysed in Python               |

## Settings before Start (first list)
- World: seed, size, food density, poison on/off, poison density.
- Population: size, epoch length, mutation rate.
- Brain: number of hidden layers, neurons per layer.
- Run: simulation speed.

## Genetic algorithm starting point
- Fitness is how long the creature survives, so finding food and avoiding poison pay off through energy.
- A generation ends when every creature is out of energy. There is no lifetime cap, food is finite instead.
- Selection is pluggable so we can play with it later, e.g. top 10% breed the rest, or fitness-proportional.
- The best few are copied unchanged into the next generation.
- Children get mixed weights from two parents plus small random mutations.

## Watching the simulation
- All creatures drawn at once, overlapping each other.
- Or only the fittest creature, replayed.
- Show the current generation number and the best fitness so far.
- Toggle whether the rays are drawn.
- Creature point of view: everything dark except a circle around the creature with radius equal to the ray length.

## Wanted next (not started)
- Choose which generation to watch next, in a neat way. For example watch generation 1, then 20, then jump to 60, or set a stride such as every 100th generation. Today the replay always shows the newest computed generation, and only one generation is kept, so this needs the worker to keep or re-create the chosen generations (genomes and layout seed are enough to replay one).

## Revisions
- 2026-10-09: first draft.
- 2026-10-09: fitness changed to survival time with an energy budget, added viewing modes.
- 2026-10-09: creatures live in separate world copies, compute fast then replay, new layout each generation, pluggable selection.
- 2026-10-09: fish-like physics with drag, outputs are turn and thrust. Tuning log in `docs/tuning-notes.md`.
- 2026-10-09: no lifetime cap, finite food, lethal poison, densities, brain also sees speed and turn rate.
- 2026-10-10: refactor into focused modules, faster drain and more drag, performance work for populations up to 2000 (see `docs/perf-notes.md`).
