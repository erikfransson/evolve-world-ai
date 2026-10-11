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
| Lean times          | Energy               | low energy, slow regrowth, stinging poison          | 0.91 -> 0.92 (200 it) | 0.94 -> 2.05 (200 it); PPO 60 s: 0.94 -> 5.99 |
| Aggressor           | Fight                | 200 energy among weak grazers, collision damage     | 1.37 -> 1.62   | 1.21 -> 1.80 |
| Escape              | Fight                | graze while 2 trained aggressors hunt you           | 0.79 -> 1.24   | 0.66 -> 1.04 |
| Duel (duel)         | Compete              | one seed-pool rival                                 | 0.09 -> 2.20   | 1.81 -> 3.08 |
| Melee (melee)       | Compete              | 4 self-play rivals, regrowing food                  | 0.00 -> 2.03   | 0.63 -> 0.91 |
| Brawl (brawl)       | Compete              | Melee with collision damage, rams pay               | 0.54 -> 1.94   | 0.72 -> 1.05 |

Advanced (bigger, slower): forage-sparse, poison-field, rivals, endurance; Great Hunt hunters and prey (hidden while the Arena trains foragers only).

## Notes

- 2026-10-11: dropped near-duplicates (forage-box, box, box-poison, nibble-poison, scatter). Fence and Zigzag with lethal walls never learned (no candidate got through); walls now sting (25 energy) and 2 food lie on the learner's side as a first step. Lean times showed no signal at 25-30 energy; raised to 40 energy, 8 food, food reward 0.5.
- The library (`public/rl/library.json`) holds rivals by env id: one aggressor trained 200 iterations from pool:0 (held-out 1.21 -> 1.75), used by Escape. Rivals only come from envs of the same world and species.
- Fence and Zigzag learned the near food but not the gap (200 iterations: 1.47 and 1.0, under the 2 near items); with +1 per wall crossed they reach 1.84 and 1.41. Lean times stayed flat from random even with stinging poison: one lethal bite or quick starvation made rewards all-or-nothing; a pool founder learns it.
- Backprop RL (PPO, `docs/rl-grad-notes.md`) learns faster than ES in wall time on every env tried, by far on Lean times (random 0.91 -> 2.91, pool 0.94 -> 5.99 in 60 s on one thread).
