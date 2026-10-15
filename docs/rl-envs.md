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
| Four rooms (rooms)  | Avoid and find a way | four rooms with a door in each wall                 | 0.00 -> 0.28   | PPO 60 s: 0.00 -> 0.19 |
| Islands (islands)   | Avoid and find a way | food on three islands, poison in the water          | 0.00 -> 1.81   | PPO 60 s: 0.00 -> 1.56 |
| Ring road (ring)    | Avoid and find a way | food on a lane between two stinging poison rings    | ES not recorded | PPO 60 s from pool: 9.35 |
| Bottleneck          | Avoid and find a way | the fence with two rivals at the gap                | not measured   |              |
| Flash (flash)       | Memory               | 5 food all round in a 600 x 600 room, visible 2 s of 15 | memory 3.19 vs none 2.17 (600 it, pop 100, 6 seeds) | |
| Glimpse (glimpse)   | Memory               | a patch of 12 food in 500 x 500, visible 1.5 s of 25 | memory 3.17 vs none 2.10 (6 seeds) | |
| Truffles (truffles) | Memory               | the same patch, never visible, 30 s                 | memory 2.22 vs none 1.64 (6 seeds) | |
| Sprint (sprint)     | Energy               | 600 x 120 strip, food at the far end, 100 energy    | 0.00 -> 4.08   | PPO 0        |
| Toll road           | Energy               | a closed belt of mild poison, most food behind it   | not measured   |              |
| Lean times          | Energy               | low energy, slow regrowth, stinging poison          | 0.91 -> 0.92 (200 it) | 0.94 -> 2.05 (200 it); PPO 60 s: 0.94 -> 5.99 |
| Wait for it (wait)  | Energy               | 260 x 260, 3 food regrowing slowly, 60 energy, end energy pays | lab bodies 600 it: 1.01 -> 1.38, 1.11 -> 1.11 | 0.87 -> 4.78 (600 it) |
| Aggressor           | Fight                | 200 energy among weak grazers, collision damage     | 1.43 -> 1.31 (2026-10-15) | 1.11 -> 1.35 (2026-10-15) |
| Escape              | Fight                | graze while 2 trained aggressors hunt you           | 0.79 -> 1.24 (no ram reward, so unchanged by the ram fix) | 0.66 -> 1.04 |
| Duel (duel)         | Compete              | one seed-pool rival                                 | 0.09 -> 2.20   | 1.81 -> 3.08 |
| Melee (melee)       | Compete              | 4 self-play rivals, regrowing food                  | 0.00 -> 2.03   | 0.63 -> 0.91 |
| Brawl (brawl)       | Fight                | Melee with collision damage, rams pay               | 0.50 -> 1.66 (2026-10-15) | 0.66 -> 1.25 (2026-10-15) |
| Crowd (crowd)       | Compete              | many rivals on regrowing food                       | ES beats PPO   |              |

Slower foragers, filed by tag since 2026-10-15: Sparse plains (forage-sparse) in Find food, Poison field in Avoid and find a way, Rivals in Compete, Endurance in Energy. Advanced now holds only hunters and prey (hidden while the Arena trains foragers only). Poison field and Endurance hardly move from random genomes even in 600 iterations (gains 0.0 to 0.4) but do from a pool founder (0.37 -> 0.95 and 0.80 -> 2.02).

Bigger (Live-like, 90 s, start energy 300, lethal poison, bumps hurt, seed pool crowds; Busy meadow was dropped on 2026-10-15). Measured differently from the table above, as they are too slow for population 200: ES at population 100 for 200 iterations, held-out on 16 seeds, from random genomes of three bodies (5 to 12 rays, hidden 8 to 24+24, memory 0 to 8 units), 2 seeds each; mean over the 6 runs and the best run.

| Env (id)                       | Idea                                           | Random 0 -> 200, mean of 6        | Best run |
| ------------------------------ | ---------------------------------------------- | --------------------------------- | -------- |
| Live patch (live-patch)        | 1200 x 1200, 60 food, 20 rivals                | 2.92 -> 19.52                     | 29.42    |
| Feast and famine (live-famine) | 2200 x 2200, 35 food, slow regrowth, 8 rivals  | 2.64 -> 7.57                      | 8.99     |
| Poison country (live-poison)   | 1500 x 1500, 40 food, 90 poison, 12 rivals     | 3.41 -> 5.06                      | 6.41     |
| Crowded commons (live-commons) | 20 food, 25 weak rivals, rams pay 2            | 2.23 -> 6.73 (before the ram fix) | 7.79     |

## Notes

- 2026-10-11: dropped near-duplicates (forage-box, box, box-poison, nibble-poison, scatter). Fence and Zigzag with lethal walls never learned (no candidate got through); walls now sting (25 energy) and 2 food lie on the learner's side as a first step. Lean times showed no signal at 25-30 energy; raised to 40 energy, 8 food, food reward 0.5.
- The library (`public/rl/library.json`) holds rivals by env id: one aggressor trained 200 iterations from pool:0 (held-out 1.21 -> 1.75), used by Escape. Rivals only come from envs of the same world and species.
- Fence and Zigzag learned the near food but not the gap (200 iterations: 1.47 and 1.0, under the 2 near items); with +1 per wall crossed they reach 1.84 and 1.41. Lean times stayed flat from random even with stinging poison: one lethal bite or quick starvation made rewards all-or-nothing; a pool founder learns it.
- Backprop RL (PPO, `docs/rl-grad-notes.md`) learns faster than ES in wall time on every env tried, by far on Lean times (random 0.91 -> 2.91, pool 0.94 -> 5.99 in 60 s on one thread).
- 2026-10-12: Memory group. Each memory env is checked with the same body with memory 4+4 vs 0+0 (ES, pop 100, 400 iterations, 3 seeds); only an env with a clear gap ships. Flash passes (1.60 vs 1.11). Signal door (a T-maze: cue bite left or right, corridor, one room in the time) shows no gap (3.84 vs 3.82) and is held back; its `cuedoor` layout stays for custom envs. Three arms never got past one corridor and was dropped, as was Patience.
- 2026-10-15: a ram no longer pays for a rival that starves, is killed by another rival, or dies of poison beside the learner (`isRam` in `env.ts`; no ram pays on a tick when any creature ate poison), and a rival dying on its first tick is judged too. Aggressor and Brawl were re-measured after the change. Aggressor from random did not gain in this one 60-iteration run (1.43 -> 1.31, before 1.37 -> 1.62); one seed cannot tell the fix from noise.
- 2026-10-15 review of all envs (lab notes in the arena-founders worktree, `runs/lab/notes.md`): three bodies (scout 8 rays and no memory, default 5 rays, big 12 rays and 24+24 with 4+4 memory), 2 seeds each, 200 iterations per env, then every trained creature scored on every env. Zigzag was dropped: Four rooms and Fence training reach 104% and 96% of its own gain. Busy meadow was dropped: Live patch training reaches 101% of it, and it 87% of Live patch. Duel, Melee, Brawl and Escape also transfer 80 to 100% to each other, but they stay for now, as they differ in rivals (one pool rival, a league, rams, hunters). The body decides some envs: Ring road is learned by the scout and big bodies (5.5) but not the default one (0.08), and Bottleneck only by the big one.
- Fight candidates, 2026-10-15: Pick your fights (ram 5 weak rivals, avoid 3 strong ones) learned from no start in 600 iterations, and Intercept (chase weak foragers over a bigger field) is learned better by Aggressor training than by its own, so neither shipped. Wait for it shipped in Energy.
- Memory, 2026-10-15: each env is checked over 6 seeds, as 3 seeds overstated two gaps. Flash went from 3 to 5 bites (gap 1.02 against 0.66). Islands glimpse (2.52 vs 2.41), Glimpse with poison (1.47 vs 1.79), bigger or tighter patches, hidden poison (an engine option, reverted) and food at random distances showed no gap. A creature without memory units can carry a bit in its own speed and turn, which is why one-bit cue tasks such as Signal door do not need memory.
- Population: at equal episodes, pop 100 learned most (Nibble 3.20, Minefield 1.00) against 50 (2.48, 0.69) and 500 (2.78, 0.56); the Arena default is 100.
