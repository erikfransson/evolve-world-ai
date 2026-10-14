# RL environments

Index of the RL environments (`src/typescript/src/sim/rl/envs.ts`) with measured learning.
Ids are stable: tune an env under its id, add a new id for a new task.

## Measuring

`node src/rlTrain.ts --env ID --from random:1|pool:0 --iters 60 --pairs 100 --episodes 1 --eval 32 --threads 2` in `src/typescript`: evolution strategies at population 200 for 60 iterations, held-out reward on 32 seeds no iteration trains on.
An env teaches when a random brain gains clearly within that budget; a pool founder (trained in Trials) often starts higher and gains less.
Self-play envs (Melee, Brawl) score against the learner's own league, so their held-out values are relative, and a scorer without a league (serial `scoreLearner`) meets mirrors of the candidate instead.

## Forager envs

| Env (id)            | Group                | Idea                                                | Random 0 -> 60 | Pool 0 -> 60 |
| ------------------- | -------------------- | --------------------------------------------------- | -------------- | ------------ |
| Nibble (nibble)     | Find food            | 3 food in a 200 x 200 box, fast                     | 0.09 -> 1.97   | 2.24 -> 3.89 |
| Corridor (corridor) | Find food            | long 600 x 150 room                                 | 0.06 -> 0.69   | 0.97 -> 1.25 |
| Far food (far-food) | Find food            | 3 food in a 400 x 400 room, search                  | 0.03 -> 0.61   | 0.53 -> 0.89 |
| Patch (patch)       | Find food            | all food in one patch, start in the middle          | 0.00 -> 2.27   | 1.41 -> 1.63 |
| Minefield           | Avoid and find a way | 4 food among 12 lethal poison                       | 0.16 -> 0.94   | 0.47 -> 0.47 |
| Fence (fence)       | Avoid and find a way | stinging wall with a gap, 2 food this side, +1 per wall crossed | 0.06 -> 1.84 (200 it) | PPO 60 s: 0.63 -> 1.94 |
| Zigzag (maze)       | Avoid and find a way | two stinging walls, gaps at opposite ends, +1 per wall crossed | 0.09 -> 1.41 (200 it) | PPO 60 s from random: 0.09 -> 1.63 |
| Four rooms (rooms)  | Avoid and find a way | four rooms with a door in each wall                 | 0.00 -> 0.28   | PPO 60 s: 0.00 -> 0.19 |
| Islands (islands)   | Avoid and find a way | food on three islands, poison in the water          | 0.00 -> 1.81   | PPO 60 s: 0.00 -> 1.56 |
| Ring road (ring)    | Avoid and find a way | food on a lane between two stinging poison rings    | ES not recorded | PPO 60 s from pool: 9.35 |
| Bottleneck          | Avoid and find a way | the fence with two rivals at the gap                | not measured   |              |
| Flash (flash)       | Memory               | 3 food in a 600 x 600 room, visible 2 s of 12       | memory 1.60 vs none 1.11 (400 it, pop 100, 3 seeds) | |
| Sprint (sprint)     | Energy               | 600 x 120 strip, food at the far end, 100 energy    | 0.00 -> 4.08   | PPO 0        |
| Toll road           | Energy               | a closed belt of mild poison, most food behind it   | not measured   |              |
| Lean times          | Energy               | low energy, slow regrowth, stinging poison          | 0.91 -> 0.92 (200 it) | 0.94 -> 2.05 (200 it); PPO 60 s: 0.94 -> 5.99 |
| Aggressor           | Fight                | 200 energy among weak grazers, collision damage     | 1.37 -> 1.62   | 1.21 -> 1.80 |
| Escape              | Fight                | graze while 2 trained aggressors hunt you           | 0.79 -> 1.24   | 0.66 -> 1.04 |
| Duel (duel)         | Compete              | one seed-pool rival                                 | 0.09 -> 2.20   | 1.81 -> 3.08 |
| Melee (melee)       | Compete              | 4 self-play rivals, regrowing food                  | 0.00 -> 2.03   | 0.63 -> 0.91 |
| Brawl (brawl)       | Compete              | Melee with collision damage, rams pay               | 0.54 -> 1.94   | 0.72 -> 1.05 |
| Crowd (crowd)       | Compete              | many rivals on regrowing food                       | ES beats PPO   |              |

Advanced (bigger, slower): forage-sparse, poison-field, rivals, endurance; hunters and prey (hidden while the Arena trains foragers only).

Bigger (Live-like, 90 s, start energy 300, lethal poison, bumps hurt, seed pool crowds): live-patch, live-famine, live-meadow, live-poison, live-commons.

## Notes

- 2026-10-11: dropped near-duplicates (forage-box, box, box-poison, nibble-poison, scatter). Fence and Zigzag with lethal walls never learned (no candidate got through); walls now sting (25 energy) and 2 food lie on the learner's side as a first step. Lean times showed no signal at 25-30 energy; raised to 40 energy, 8 food, food reward 0.5.
- The library (`public/rl/library.json`) holds rivals by env id: one aggressor trained 200 iterations from pool:0 (held-out 1.21 -> 1.75), used by Escape. Rivals only come from envs of the same world and species.
- Fence and Zigzag learned the near food but not the gap (200 iterations: 1.47 and 1.0, under the 2 near items); with +1 per wall crossed they reach 1.84 and 1.41. Lean times stayed flat from random even with stinging poison: one lethal bite or quick starvation made rewards all-or-nothing; a pool founder learns it.
- Backprop RL (PPO, `docs/rl-grad-notes.md`) learns faster than ES in wall time on every env tried, by far on Lean times (random 0.91 -> 2.91, pool 0.94 -> 5.99 in 60 s on one thread).
- 2026-10-12: Memory group. Each memory env is checked with the same body with memory 4+4 vs 0+0 (ES, pop 100, 400 iterations, 3 seeds); only an env with a clear gap ships. Flash passes (1.60 vs 1.11). Signal door (a T-maze: cue bite left or right, corridor, one room in the time) shows no gap (3.84 vs 3.82) and is held back; its `cuedoor` layout stays for custom envs. Three arms never got past one corridor and was dropped, as was Patience.
- Population: at equal episodes, pop 100 learned most (Nibble 3.20, Minefield 1.00) against 50 (2.48, 0.69) and 500 (2.78, 0.56); the Arena default is 100.
