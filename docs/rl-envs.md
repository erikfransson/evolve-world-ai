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
| Two stops (two-stops) | Memory              | 2 clusters of 4 food on opposite sides, shown 2 s of 18 (kept anyway, see notes) | memory 3.76 vs none 2.92 (6 seeds, 6 of 6) | |
| Sprint (sprint)     | Energy               | 600 x 120 strip, food at the far end, 100 energy    | 0.00 -> 4.08   | PPO 0        |
| Toll road           | Energy               | a closed belt of mild poison, most food behind it   | not measured   |              |
| Lean times          | Energy               | low energy, slow regrowth, stinging poison          | 0.91 -> 0.92 (200 it) | 0.94 -> 2.05 (200 it); PPO 60 s: 0.94 -> 5.99 |
| Wait for it (wait)  | Energy               | 260 x 260, 3 food regrowing slowly, 60 energy, end energy pays | lab bodies 600 it: 1.01 -> 1.38, 1.11 -> 1.11 | 0.87 -> 4.78 (600 it) |
| Aggressor           | Fight                | 200 energy among weak grazers, collision damage     | 1.43 -> 1.31 (2026-10-15) | 1.11 -> 1.35 (2026-10-15) |
| Escape              | Fight                | graze while 2 trained aggressors hunt you           | 0.79 -> 1.24 (no ram reward, so unchanged by the ram fix) | 0.66 -> 1.04 |
| Duel (duel)         | Compete              | one seed-pool rival                                 | 0.09 -> 2.20   | 1.81 -> 3.08 |
| Melee (melee)       | Compete              | 4 self-play rivals, regrowing food                  | 0.00 -> 2.03   | 0.63 -> 0.91 |
| Brawl (brawl)       | Fight                | Melee with collision damage, rams pay               | 0.50 -> 1.66 (2026-10-15) | 0.66 -> 1.25 (2026-10-15) |
| Ambush (ambush)     | Fight                | 3 weak pool foragers in a 360 x 360 room of food, 25 s, 80 energy, kills pay 2 + 30 energy | 0.50 -> 1.59 (2026-10-28) | 1.47 -> 2.58 (2026-10-28) |
| Turf war (turf-war) | Fight                | 8 food start in one patch, 3 rivals race for it, slow regrowth round the room, rams pay | 0.27 -> 2.84 (2026-10-28) | 3.27 -> 3.34 (2026-10-28) |
| Cull (cull)         | Fight                | 5 weak foragers, little food, each kill and bite pays by the time left | 1.16 -> 3.40 (2026-10-28) | 2.61 -> 4.23 (2026-10-28) |
| Crowd (crowd)       | Compete              | many rivals on regrowing food                       | ES beats PPO   |              |
| Patch war (patch-war) | Compete            | one regrowing patch, 5 pool rivals, bumps cost energy | 0.86 -> 9.01 (2026-10-28) | 5.65 -> 7.83 |

Slower foragers, filed by tag since 2026-10-15: Sparse plains (forage-sparse) in Find food, Poison field in Avoid and find a way, Rivals in Compete, Endurance in Energy. Advanced now holds only hunters and prey (hidden while the Arena trains foragers only). Poison field and Endurance hardly move from random genomes even in 600 iterations (gains 0.0 to 0.4) but do from a pool founder (0.37 -> 0.95 and 0.80 -> 2.02).

Bigger (Live-like, 90 s, start energy 300, lethal poison, bumps hurt, seed pool crowds; Busy meadow was dropped on 2026-10-15). Measured differently from the table above, as they are too slow for population 200: ES at population 100 for 200 iterations, held-out on 16 seeds, from random genomes of three bodies (5 to 12 rays, hidden 8 to 24+24, memory 0 to 8 units), 2 seeds each; mean over the 6 runs and the best run.

| Env (id)                       | Idea                                           | Random 0 -> 200, mean of 6        | Best run |
| ------------------------------ | ---------------------------------------------- | --------------------------------- | -------- |
| Live patch (live-patch)        | 1200 x 1200, 60 food, 20 rivals                | 2.92 -> 19.52                     | 29.42    |
| Feast and famine (live-famine) | 2200 x 2200, 35 food, slow regrowth, 8 rivals  | 2.64 -> 7.57                      | 8.99     |
| Poison country (live-poison)   | 1500 x 1500, 40 food, 90 poison, 12 rivals     | 3.41 -> 5.06                      | 6.41     |
| Live now (live-now)            | 1200 x 1200, 60 food regrowing 0.6, 20 rivals, sting 20 (one bite), kill bonus 5; Live's rules as of 2026-10 without seasons | 3.61 -> 8.37 (60 it, pop 200, 1 run) | pool:0 7.02 -> 12.05 |
| Crowded commons (live-commons) | 20 food, 25 weak rivals, rams pay 2            | 2.23 -> 6.73 (before the ram fix) | 7.79     |

## Time pressure (#56)

Every bite pays 2 x the share of the episode still left (reward `early`), so speed is paid per bite and the gradient is there from the first lucky bite.
A clear-all bonus (Nibble's `fast`) only pays a perfect run, and tripled the seeds needed in the C1 probe.
Checked against the C1b env criteria E1-E8 with `docs/rl-notes/probes/t3-snr.ts` (rl-notes 17f9b8d, 64 held-out seeds): all three pass.
E6 (energy reward) does not apply; E7 holds by design.

| Env (id)             | Idea                                          | E1 SNR | E2 scripted / best | E3 best alive | E4 seeds for 25% | E5 random scores | E8 ms/ep |
| -------------------- | --------------------------------------------- | ------ | ------------------ | ------------- | ---------------- | ---------------- | -------- |
| Fading food (fading) | 8 food in 400 x 400, 20 s                      | 4.78   | 0.08               | 1.00          | 8                | 19%              | 5.1      |
| Stings (stings)      | Fading food with 4 stinging poison (20 energy) | 3.83   | 0.08               | 0.95          | 15               | 16%              | 4.6      |
| Race (race)          | 300 x 300, 15 s, one pool rival eats too       | 3.59   | 0.15               | 1.00          | 13               | 29%              | 6.0      |

Training from fresh designs (ES pop 100, 150 iterations, 1 episode, `randomLearner` bodies 1 to 3, final genome on 64 held-out seeds): Fading food 0.13 -> 4.76 (sd over runs 2.00), Stings 0.14 -> 4.76 (1.90), Race 0.32 -> 4.53 (1.05); curves rise steadily, though body 1 stops near 2.6 in both fading envs.
Speed check (C1 review): mean learner speed (world units per second while alive) on 32 held-out seeds, mean of the same 3 bodies, each trained 150 iterations at pop 100; reward in brackets.
Untrained bodies move at 0 to 7.

| Trained on  | Own env     | Nibble      | Far food    |
| ----------- | ----------- | ----------- | ----------- |
| Fading food | 69.7 (4.73) | 64.4 (3.25) | 69.2 (1.84) |
| Race        | 68.9 (4.49) | 65.8 (2.65) | 69.6 (1.20) |
| Nibble      | 65.5 (3.50) | (own)       | 63.6 (1.33) |

The time-pressure creatures are not clearly faster: about 5 to 9% faster than the Nibble one in Far food and its equal in Nibble, within the spread between bodies (57.6 to 67.7 for Nibble in Far food).
At this budget every trained creature already moves at 60 to 72, the speed of Live survivors (63 to 77), so in these small worlds speed is not what separates the envs; the slow lean founders in Live need another explanation.
Each claim needs 3 to 5 training seeds or bodies: the spread between runs is larger than the held-out noise.
Dropped after the same checks: Dash (5 food, clear-all bonus, fails E7), Hot box (tight room with stings, run spread 2.3 to 4.5), Mudflats (slow and fast ground, seed cv up to 0.99, the random ground makes layouts too unequal), and lab variants Fading wide, Fading regrow and Race two (all pass, but lower SNR and more seeds needed than the three above).

## More Fight envs (2026-10-28)

Fight had three envs (Aggressor, Escape, Brawl) and Aggressor fails E1 to E3 (`docs/rl-notes/t3-envs.md`: free share 0.70, saturated energy term).
Three new envs, all with collision damage and weak pool foragers as prey, none with a saturated term (start energy 80 to 120, no energy reward).
`early` now also pays a ram by the share of the episode left (`env.ts`), which Cull uses; the other `early` envs have no collision damage, so their rewards are unchanged.
Checked with `t3-snr.ts` (64 held-out seeds, Cull as first measured; Ambush and Turf war re-measured after the trim, 4 random designs, pool:0..1, Live founders; E6 does not apply, E7 holds for Cull by `early` and by short episodes for the others):

| Env (id)  | E1 SNR | E2 scripted / best | E3 best alive | E4 seeds for 25% | E5 random scores | E8 ms/ep |
| --------- | ------ | ------------------ | ------------- | ---------------- | ---------------- | -------- |
| Ambush    | 3.02   | 0.16               | 0.99          | 33               | 45%              | 6.4      |
| Turf war  | 2.59   | 0.06               | 0.94          | 25               | 23%              | 6.5      |
| Cull      | 2.69   | 0.17               | 0.96          | 35               | 41%              | 5.8      |

Training (ES pop 200, 60 iterations, 1 episode, 32 held-out seeds; one run each, so the spread between runs is not measured): rows above in the table.
Rams and food of the same creatures on 64 held-out seeds (reward, rams per episode, food per episode):

| Env      | pool:0 start      | trained from random:1 | trained from pool:0 |
| -------- | ----------------- | --------------------- | ------------------- |
| Ambush   | 1.66, 0.41, 2.81  | 1.66, 0.38, 3.05      | 2.30, 0.48, 4.45    |
| Turf war | 3.27, 0.20, 2.97  | 2.52, 0.20, 2.22      | 3.93, 0.27, 3.53    |
| Cull     | 2.76, 0.58, 0.97  | 2.79, 0.56, 0.97      | 4.30, 0.84, 1.69    |

The gain is mostly food, as the best founders eat 3.6 to 10.1 items against 0.6 to 1.2 rams: the envs are fights over food, not pure hunts.
Only Cull from pool:0 shows more rams (0.58 -> 0.84); Turf war from a pool founder hardly gains (3.27 -> 3.34, one run).
Regrown food is placed uniformly over the room (`addRandomly`), not in the patch, so only the first 8 items of Turf war lie in the patch; the env is a race for the patch plus a slow scatter, not a defended patch.
Speed (E8, `rlBench --reps 9`, CPU ms per episode, median, load average about 4.2): Ambush pool:39 6.1 and random 4.7, Turf war 7.1 and 6.1, Cull 5.6 and 5.2 (Aggressor 10.0 and 8.9).
An earlier Ambush (4 rivals, 30 s) read 10.8 and 5.0 under the same bench and 15.1 ms in a loaded 3-rep run, so it was trimmed to 3 rivals and 25 s, and Turf war to 25 s with regrowth 0.3 (was 0.6, 30 s); both were re-checked.
Dropped after the screen (E1 to E3 with the same probe): pure ram rewards (6 weak pool foragers, no food: SNR 0.88, scripted 44% of best), a Cage (equal energies, no food: SNR 0.21, scripted 88%), a ram-only Cull (SNR 1.16, scripted 34%, alive 0.60), scripted-charger duels (Chase of a fleeing charger SNR 0.67, random designs never score; Hit and Read a charger of known or mixed energy SNR about 0: standing still already scores as the best founder, so no untrained reference shows headroom), Pick your fights (SNR 0.66, as in the 2026-10-15 note) and Aggressor with 100 energy, ram 1 + food 0.3 (passes but 17 ms per episode, over E8).
Open: the duel envs need a trained reference creature before E1 can be judged; PPO ignores the ram reward (`ppo.ts`), so these envs train with ES only.

## More Memory envs (2026-10-28)

Memory gap as before: the same default body (5 rays over 120 deg, sight 180, hidden 12) with memory 4+4 vs 0+0, same random start per seed, ES pop 100, 400 iterations, 1 episode, held-out on 32 seeds, 6 seeds (script kept out of the repo; it is `rlTrain` with a fixed plan).
E1-E8 from `docs/rl-notes/probes/t3-snr.ts` (64 held-out seeds); E6 and E7 do not apply (food reward only).

| Env (id)  | Memory | None | Gap  | Seeds won | E1 SNR | E2 scripted / best | E3 best alive | E4 seeds for 25% | E5 random scores | E8 ms/ep |
| --------- | ------ | ---- | ---- | --------- | ------ | ------------------ | ------------- | ---------------- | ---------------- | -------- |
| Flash (reference) | 3.19 | 2.17 | 1.02 | 5 of 6 | 2.44 | 0.18 | 0.83 | 67  | 5% | 2.2 |
| Two stops  | 3.76 | 2.92 | 0.84 | 6 of 6 | 1.30 | 0.18 | 0.70 | 195 | 2% | 2.5 |

- Two stops (kept anyway, like Glimpse): two clusters (`stops` layout, 150 to 190 from the start) shown for 2 s. Eating one then needs the other's place, beyond sight. Passes E2, E3, E8 but misses E1 (1.30 against 1.5) and needs 195 seeds for a quarter of the gap (E4); kept for its clean gap (6 of 6 seeds), which Erik asked memory envs for. At 30 s the best creature lived only 46% of the time (E3 fail, SNR 1.29, gap 0.73 over 6 seeds, 5 of 6), so it was cut to 18 s.
- Lighthouse (Flash's layout, food shown 0.7 s of every 4 s, 20 s, an engine option `foodCycle`, since removed): memory 2.99 vs 2.44 (0.55, 6 of 6), E1 2.22, E3 0.65, E4 111, but dropped on the transfer check. Same body (memory 4+4), 6 seeds, 400 iterations: Flash training scores 2.71 on Lighthouse, Lighthouse training 2.99, from a start of 0.04, so Flash training reaches 90% of Lighthouse's gain (limit 85%). The same skill as Flash.
- Failed (3 seeds unless noted): Three stops (3 clusters of 3, 30 s) 3.22 vs 3.24, both eat one cluster and neither learns to leave for the next. Blink with 2 clusters shown 1 s of 6 (6 seeds) 2.99 vs 2.83, 3 of 6 seeds, the blink lets a memoryless creature track the clusters. Blink 8 (8 food all round, 0.7 s of 5 s, 25 s, 6 seeds) 5.58 vs 5.05, 4 of 6 seeds with a swing from -1.75 to +2.91.
- Group Memory is now 4 envs. Not done: transfer check of Two stops against Flash and Glimpse, and PPO.

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
- 2026-10-28, new envs (env-more). Recipe as in Measuring (60 iterations, pop 200, 32 held-out seeds), plus a cross check: a creature trained on A, scored on B, as a share of B's own gain from the same random body (bodies random:1 and random:2, 32 seeds, 16 for Live).
  - Shipped Patch war (Compete). Own gain 8.1 (random:1) and 12.8 (random:2). Others reach it at most 70% (Fading) in body 1, but in body 2 Rivals training reaches 101% and Fading patch 89%. It is the hard, crowded superset: its training lifts Patch (106% and 61%), Duel (131% and 94%) and Rivals (153% and 89%). E1 3.73, E2 0.06, n25 21.
  - Shipped Live now (Bigger). Sting 20 (the env has no food energy setting, so the default 20 is one bite as in Live, where a sting 50 equals a bite 50), kill bonus 5; Live's rules as of 2026-10, but without seasons. Re-checked after that fix (64 seeds): E1 4.75, E2 0.13, E3 0.98, E4 7 seeds, 35 ms per episode on a quiet machine (68 ms under load), which is about 3.5 to 7 s CPU per iteration at pop 100; Bigger envs exceed E8 and are accepted with that note. Training from random 3.61 -> 8.37, from pool:0 7.02 -> 12.05. Distinctness figures below are from the first version (sting 50): Live patch training reached 56% and 78% of its gain, Live now training reached Live patch 146% and 37%; not repeated.
  - Failed. Fading patch (patch layout with `early`): fails E5 (random designs score 0 on 94% of seeds), and Patch training reaches about 86% of its gain (145% and 92% the other way), so it is close to a duplicate; it learned (0 -> 3.7 and 7.9) but adds little. Fading fence (fence layout with `early` and cross): passes E1 to E5 but training on Fading reaches 91% of its gain and Fence 105% (duplicate). Grab (patch, 2 pool rivals, regrow): Fading patch, Fence and Patch training reach 105 to 157% of its gain, and E4 needs 84 seeds. Island duel (islands, 1 pool rival): Islands training reaches 94% and Duel 112%. Scramble (50 energy, 4 hungry rivals, energy reward): does not learn from random (1.15 -> 1.15) or a pool founder (0.88), E4 needs 145 seeds. Live flats (Live patch with 25% fast ground): E4 needs 86 seeds and Live patch training reaches 86% of its gain.
