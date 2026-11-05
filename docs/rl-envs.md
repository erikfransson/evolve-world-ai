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
| Over the horizon (horizon) | Explore        | 10 food in 3 clusters 2 to 3 sight lengths out, 1600 x 1600 | 0.23 -> 5.92, 0.00 -> 2.36, 0.00 -> 2.69 (bodies 1 to 3) | |
| Sparse trail (trail) | Explore            | line of 3 singles and a cache of 5, each 1.8 sight lengths on, start facing 30-60 degrees off | 0.55 -> 3.92, 0.00 -> 7.53, 0.00 -> 1.00 (bodies 1 to 3) | |
| Clean sweep (sweep5) | Time pressure       | 5 food in 350 x 350, food 0.2 + clock left 0.2      | not trained (see Time pressure notes) | |
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
| Corral (corral)     | Fight                | 16 weak foragers in a 300 x 300 pen, 12 s, 300 energy, only rams pay | 0.50 -> 2.23 rams (2026-10-28) | 2.03 -> 2.63 rams (2026-10-28) |
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
Checked against the C1b env criteria E1-E8 with `docs/rl-notes/probes/t3-snr.ts` (rl-notes 17f9b8d, 64 held-out seeds): Fading food, Stings and Race pass; Lap (below) misses E5 and is kept anyway.
E6 (energy reward) does not apply; E7 holds by design.

| Env (id)             | Idea                                          | E1 SNR | E2 scripted / best | E3 best alive | E4 seeds for 25% | E5 random scores | E8 ms/ep |
| -------------------- | --------------------------------------------- | ------ | ------------------ | ------------- | ---------------- | ---------------- | -------- |
| Fading food (fading) | 8 food in 400 x 400, 20 s                      | 4.78   | 0.08               | 1.00          | 8                | 19%              | 5.1      |
| Stings (stings)      | Fading food with 4 stinging poison (20 energy) | 3.83   | 0.08               | 0.95          | 15               | 16%              | 4.6      |
| Race (race)          | 300 x 300, 15 s, one pool rival eats too       | 3.59   | 0.15               | 1.00          | 13               | 29%              | 6.0      |
| Lap (lap)            | Ring lane of 8 food between stinging poison rings, 25 s | 4.99   | 0.05               | 0.86          | 9                | 0% (miss)        | 2.8      |

Training from fresh designs (ES pop 100, 150 iterations, 1 episode, `randomLearner` bodies 1 to 3, final genome on 64 held-out seeds): Fading food 0.13 -> 4.76 (sd over runs 2.00), Stings 0.14 -> 4.76 (1.90), Race 0.32 -> 4.53 (1.05) (the three originals; Lap is trained in the Round 2 note); curves rise steadily, though body 1 stops near 2.6 in both fading envs.
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

## Round 2 envs (2026-10-28): Corral and Lap

Recipe as in Measuring and the Fight section (ES pop 200, 60 iterations, 1 episode, held-out on 64 seeds, one run per cell), bodies random:1 and random:2, `t3-snr.ts` on 64 seeds with 4 random designs, pool:0..1 and the Live founders.
Distinctness: a creature trained on another env, scored on the new env, as a share of the new env's own gain from the same start; 85% or more is a duplicate.

**Corral** (Fight, the hunting env): 16 weak pool foragers (40 energy) in a 300 x 300 pen with 3 food, 12 s, learner 300 energy, kill energy 20, reward is one point per ram and nothing else.
Prey starve within about 6 s and a death with another rival touching is not credited, so rams come from hitting early in a crowded pen; the older pure-ram attempts had fewer prey and a learner with 80 to 120 energy.
Training (reward = rams per episode, food eaten about 0.3 and unpaid): random:1 0.50 -> 2.23, random:2 0.48 -> 2.63, pool:0 2.03 -> 2.63. Cull, Ambush and Turf war creatures ram 0.3 to 0.9 per episode in their own envs.
E1 2.29, E2 0.28 (best scripted: straight 0.83 against Juggernaut 2.95), E3 1.00, E4 66 seeds for a quarter of the gap (limit 64, a small miss), E5 random designs score on 40% of seeds, E8 17.3 ms (pool:39) and 11.6 (random) in `rlBench --reps 9` at load average about 32, where Cull reads 10.9 and 9.4 against 5.6 and 5.2 on a quiet machine; so about 8.9 and 6.4 ms when quiet (scaled from Cull's ratio, unmeasured; re-measure on a quiet machine).
Distinctness (share of Corral's own gain, random:1 / random:2): Ambush 84% / 79%, Cull 72% / 56%, Turf war 59% / 65%, Aggressor 2% / 54%, Brawl 40% / 24%. Ambush is close to the limit.
Failed variants: 10 prey in a 360 x 360 pen (E4 needs 108 to 119 seeds, ES reaches only 1.5 rams); the same pen without food (Ambush training reaches 229% of its gain, own gain 0.58 on random:1); `early` instead of a flat ram reward (food bites then dominate); g09, the 15 s version (Ambush training reaches 104% on random:1).

**Lap** (Time pressure): the Ring road layout (lane 64, 450 x 450, 8 food, stinging rings) with `early: 2` and 25 s.
Training: random:1 0 -> 4.51, random:2 0 -> 10.57, pool:0 0.27 -> 2.62.
E1 4.99, E2 0.05, E3 0.86, E4 9 seeds, E8 2.8 ms (loaded).
E5 misses: random designs score exactly 0 on every seed, and the env is body-dependent like Ring road (founders: only Oracle scores, 5.59; Explorer 1.23). Adding `survive: 0.02` removed the learning (0.40 -> 0.44 and 0.29 -> 0.42), so it was left out.
Distinctness (share of Lap's own gain on random:1 / random:2): Fading 9% / 3%, Race 8%, Stings 7%, Corridor 10%, Sprint 38% / 4%, Rooms 42%, Minefield 13%, Islands 9%, Fence 5%, Ring road 0% / 0% (it does not learn from either body in 60 iterations).
Lap is kept anyway despite the E5 miss: it learns from both bodies and no time pressure relative or Ring road trains it.
Reverse transfer: Lap-trained creatures score on Ring road (64 seeds) 0.40 -> 4.33 (random:1) and 0.29 -> 11.05 (random:2), so Lap training solves Ring road, which does not learn on its own in 60 iterations; Lap may make Ring road redundant as a training env.
Failed time pressure candidates, all with `early: 2`, each scored by a Fading-trained creature: a 600 x 150 corridor (Fading reaches 92% of its gain), 300 x 300 with 12 lethal poison (Fading 171%), two library aggressors (Fading 117%), 25 starting energy (duplicate of Fading), four rooms (E3 fails, alive 0.48), islands (gain 0.38), ten slow grazers (15.6 ms per episode), a Sprint strip (Sprint training reaches 84% to 94% of its gain). `early` pays a fast reckless creature, so any env where heading for the nearest food works duplicates Fading.

**Hand to mouth** (Time pressure, energy): ten food in a winding `chain` layout (500 x 500, each 85 from the last, the first 60 from a start that faces it), 30 s, start energy 20, `livingCost` 5 (default 2) so time itself drains, reward food 1, survive 0.05 and fast 0.05 (clearing ends the episode as alive).
Tuned by sweeping `livingCost` 4 to 12 on the 64-seed probe (best founder alive / best score): 4 0.87 / 10.6, 5 0.75 / 9.4, 6 0.57 / 8.1, 8 0.41 / 6.7, 10 0.25 / 4.7, 12 0.19 / 3.9.
Weak seed-pool founders die in 77% of the episode at 4 (pool:0 alive 0.23), the best founders survive; 5 is the tightest value that keeps E3 (alive 0.60 needs below 6).
E1 3.14, E2 0.22, E3 0.75, E4 15%, E5 random designs score 0 on none of the seeds, E8 2.6 ms (loaded).
Training (ES pop 200, 60 iterations, 64 seeds, random bodies 1, 2, 3): 0.26 -> 3.21, 0.25 -> 5.40, 0.27 -> 7.10.
Distinctness (share of its own gain, bodies 1 / 2 / 3): Fading 69% / 69% / 50%, Race 85% / 59% / 29%, Stings 63% / 89% / 43%, Nibble 71% / 12% / 7%, Sprint 74% / 0% / 26%, Lap 12%, Wait for it 0%.
Two borderline misses of the 85% rule (Race in body 1, Stings in body 2), the rest well under; kept because the energy pressure (a bite tops up less than a wasteful leg costs) is the thing Erik asked for and nothing else in Time pressure trains it.

Dropped after the screen (same probe and cross check, 60-iteration ES from random bodies 1 and 2, poison bites per episode in brackets):
- Clean sweep (5 food, score by the clock left at the fifth bite). Re-added on Erik's request as `sweep5` (350 x 350, 15 s, reward food 0.2 + fast 0.2), kept although a duplicate in training: Fading training reaches 154% of its gain. Re-check 2026-11-05 (64 seeds): E1 2.48, E2 0.05, E3 0.99, E4 46 seeds for 25%, E5 80% of random designs score 0, E8 3.9 ms. Earlier probe: Pure clear-all reward: best score 0.32, random designs score 0 on every seed, E1 0.96, E4 59%. With food 0.2 and fast 0.2 in a 350 x 350 room it passes E1 to E5 (E1 2.36, E4 25%) but Fading training reaches 154% of its gain and Race 116%: a duplicate.
- Sweep race (5 food, one pool rival, early 1.5 + food 0.5): E1 2.67, E3 0.85, but Fading training reaches 127% and Race 115% of its gain, and Clean sweep 102%.
- Thorny (each food guarded by 2 thorns 20 to 25 beside it), Bitter rows (alternating food and poison rows), Sparse sting (4 food, 24 mild poison, `early`) and Bramble (60 s regrowing grove among poison). Final parameters (thorns and rows sting 50 at 100 energy, Sparse sting 15, Bramble 35): E1 2.0 to 3.8, E2 0.05 to 0.08, E4 15% to 24%, but Thorny (best founder alive 0.47) and Bitter rows (0.53) miss E3 because even the best founder dies of its stings, Bitter rows and Sparse sting miss E5 (0.92, 0.93). None is distinct: in body 1 Fading training reaches 92% of Thorny's gain and Lean times 89%, Lean times reaches 151% of Bitter rows, Thorny 121% of Sparse sting, Bitter rows 153% and Lean times 154% of Bramble.
  Poison bites per episode rise with training on every one of them, including on the env itself (Thorny 0.00 -> 1.61, relatives 1.09 to 1.64; Bitter rows 1.41 against 1.56 to 2.03; Bramble 2.03; Sparse sting 1.67): ES from a random body in 60 iterations learns to eat, not to avoid, so none of these envs cuts bites more than its relatives, and the poison reward term (R1) is what is missing for that skill, not another layout.
- Decoy (poison clusters that look like food at range) cannot work: rays report food and poison as separate flags (`sensors.ts`, FEAT_FOOD and FEAT_POISON), so the two are never confusable.

## Explore (2026-11-05, track X1)

Erik's ask: creatures should leave and find food beyond their sensing range, not scan in place and walk to what they see.
An Explore env must be out of sight for the learner's own design, so `placeLayout` takes the learner's `rayLength` as an optional last argument (read only by `horizon`, so existing layouts are bit-identical), and every distance is in sight lengths R (R is floored at 50 (a design's ray length can be as short as 10) and is capped so the 1600 x 1600 world holds it).
`EnvSpec.reward.explore` pays per grid cell newly entered (side = max(20, the learner's ray length), the start cell free) and `EpisodeResult.cells` counts the cells visited in every env (a Uint8Array grid, one index per tick); the term is off unless set.
Probes: `docs/rl-notes/probes/x1-explore.ts` (scripted and founder baselines, with cells), `t10-cross.ts` (now also prints food and cells before and after, and each relative's cell share), `t3-snr.ts --scripted-ray 150` (scripted bodies with a sight that matches the layout; the default 10 makes the layout scale down to its 50 floor).

**Over the horizon** (Explore, `horizon`): the learner in the middle of 1600 x 1600, 10 food in three small clusters (4, 3, 3, radius 25), each 2 to 3 R from the start and at least 2 R from the others, in random directions; 60 s, start energy 200, reward food 1.
Baselines (32 seeds, food per episode, max 10; blind bodies with ray length R, seekers have 12 rays all round and steer at food they see):

| Policy                  | R 60  | R 150 | R 250 |
| ----------------------- | ----- | ----- | ----- |
| spin in place           | 0.00  | 0.00  | 0.00  |
| wiggle (blind)          | 1.53  | 0.06  | 0.03  |
| straight, turn at wall (blind) | 2.13 | 0.38 | 0.25 |
| seek + wiggle           | 3.88  | 2.03  | 1.41  |
| seek + straight         | 6.44  | 4.03  | 2.53  |

Cells per episode, same order: spin 1.0, wiggle 46.7 / 13.9 / 7.7, straight 64.3 / 18.2 / 10.9, seek + wiggle 48.4 / 14.7 / 8.4, seek + straight 76.3 / 21.7 / 11.6.
Founders: best pool:3 4.69 food (47% of the maximum), then pool:6 3.56, pool:2 3.41, oracle 3.06; untrained random designs and all 8 panel designs score 0 to 0.28 (food-free on 81% to 100% of seeds).
So spin scores exactly 0, directed travel beats the random walk at every ray length (seek + straight about 2 times seek + wiggle at R 150), and no founder is near the maximum.
E1 2.35, E2 0.04, E3 0.73, E4 63 seeds for 25%, E5 misses (random designs score 0 on 96% of seeds), E8 14 ms per episode (a 1600-sided world; over the 10 ms limit, accepted as a larger env).
Training (ES pop 200, 60 iterations, 64 seeds, random bodies 1 / 2 / 3): food 0.23 -> 5.92, 0.00 -> 2.36, 0.00 -> 2.69; cells 5.0 -> 43.5, 1.0 -> 24.3, 1.0 -> 15.7.
Distinctness, share of its own food gain (bodies 1 / 2 / 3): Far food 15% / 154% / 0%, Patch 78% / 5% / 0%, Sparse plains 30% / 20% / 0%, Islands 21% / 91% / 0%, Hand to mouth 6% / 0% / 0%.
Distinctness by cells covered (share of its own cell gain): Far food 74% / 83% / 16%, Patch 127% / 23% / 8%, Sparse plains 53% / 17% / 11%, Islands 108% / 35% / 0%, Hand to mouth 2% / 16% / 10%.
Honest reading: body 3 is clearly distinct on both measures and body 1 on food (Patch 78%, under 85%), but on body 1 Patch and Islands raise coverage as much as horizon does (127% and 108%), and on body 2 Far food reaches 154% of the food gain and Islands 91%. A short-sighted body meets a horizon of 100 to 150 units, which Far food also trains. Coverage is a weak discriminator, since any env that teaches travel raises it; the food measure and the blind-spot start are what Over the horizon adds. Kept as the one Explore env.

Dropped after redesigns, same probes:
- **Moving on** (`leaving` layout: a small start patch, then three patches out of sight, livingCost 4 to 5). Three versions: (1) start patch of 3, next patches in random directions, energy 60, 60 s: every learner starved after 11% to 31% of the episode (E3), the best founder scored 3.3 of 12; (2) start patch of 2, 14 food, energy 80, 40 s: random:1 trained 0.44 -> 6.28 with cells 2 -> 26, Horizon training reached 58% of it, but E1 1.30, E4 326 seeds, and seek + straight scored under seek + wiggle (1.31 against 3.50 at R 60), because the first two bites decide most of the reward; (3) as (2) with each patch roughly ahead of the last: random:1 learned only the start patch (0.44 -> 2.00, cells 2.0 -> 2.2) and Horizon training reached 104% of it (E1 1.11, E4 274 seeds, seek + straight 2.03 against seek + wiggle 2.50 at R 60). No version has both a baseline gap and a distinct learned skill, so it is dropped (a hook that spawns the next patch when one is cleared was not tried: the engine's item pool is fixed at the start).
- **Explorer** (`wide` layout: sparse food, none within 1.5 R of the start, plus the `explore` reward). Two versions (1600 x 1600, 8 food, 0.04 per cell; 1200 x 1200, 12 food, 0.03). The reward dominates: blind straight roaming scored 4.1 at R 60, above every founder but one (5.5), at the first draft's weight 0.1, and after lowering it the trained creature gained 1.7 almost all from cells (food 0.05 -> 0.28 in version 1, 0.02 -> 0.61 in version 2). Horizon training reaches 96% and Patch 104% of its gain: a duplicate. The `explore` reward and the cell count stay in the engine for custom envs.
- A shortest sight of 125 instead of 50 in Over the horizon (`horizon-f125`, so short-sighted bodies travel farther): random:1 gain fell to 0.88 and Far food reached 132%, so the floor of R stays 50.

## Explore round 2 (2026-11-05, track X2)

Erik asked for more takes on exploration than Horizon's "find fixed clusters out of sight once".
Four candidates were built on the X1 probes (`x1-explore.ts` now also prints the second-half food `late`, the share of episodes above `--reach` bites, rooms entered and a trail gap ratio; `t10-cross.ts` prints `late` and reach for each trained creature). One ships.
New engine facts: `EpisodeResult.late` is the food eaten in the second half of the episode, and a layout reads the learner's sight R as in Horizon. Rays are zero-width lines against item circles of radius 4, so a wall of items 18 apart (the `rooms` spacing) lets a ray through about 56% of the time; walls that must hide a room need items 8 apart.

**Sparse trail** (Explore, `trail`): 1800 x 1800, three single bites and a cache of 5 (radius 25) on a line through the middle in a random direction, each 1.8 R + 10 further on, so the next one is out of sight on leaving the last; the first single is at max(20, 0.8 R), in view. The start heading is 0.5 to 1 rad off the line (random side), so going straight on misses it and the creature must turn once and then hold its course. 75 s, start energy 300, reward food 1.
Baselines (32 seeds, food per episode, max 8; blind bodies have ray length R, seekers 12 rays all round and steer at food they see):

| Policy                          | R 60 | R 150 | R 250 |
| ------------------------------- | ---- | ----- | ----- |
| spin in place                   | 0.00 | 0.00  | 0.00  |
| wiggle (blind)                  | 0.66 | 0.25  | 0.13  |
| straight, turn at wall (blind)  | 0.69 | 0.09  | 0.03  |
| seek + wiggle                   | 3.16 | 2.88  | 1.59  |
| seek + straight                 | 4.41 | 3.53  | 2.94  |

Founders: pool:3 3.88, grazer 1.44, oracle 1.22, juggernaut 0.81 (best 49% of the maximum). The panel designs score 0 to 1.00 untrained (the 1.00 is the single in view), random designs 0 to 0.44.
E1 2.16, E2 0.00, E3 0.73, E4 misses (113 seeds for 25% of the gap; sdPaired 2.63), E5 76% of random designs score 0, E8 14.9 ms per episode (a large world).
Training (ES pop 200, 60 iterations, 64 seeds, bodies 1 / 2 / 3): food 0.55 -> 3.92, 0.00 -> 7.53, 0.00 -> 1.00. Body 3 barely learns it, so it learns on 2 of 3 bodies.
Distinctness, share of Trail's own food gain (bodies 1 / 2 / 3): Far food 34% / 27% / 55%, Patch 27% / 13% / 34%, Sparse plains 12% / 20% / 84%, Islands -4% / 55% / 97%, Hand to mouth 13% / 13% / 86%, Horizon 19% / 31% / 227%, Sprint 60% / 0% / 0%.
In the other direction, Trail training reaches this share of Horizon's gain: 62% / 107% / 0%.
Honest reading: on bodies 1 and 2 Trail is clearly its own skill (no relative above 60%, Horizon training reaches 19% and 31%), and Trail training transfers to Horizon on body 2 (107%), so Horizon does not need it but Trail needs more than Horizon gives. On body 3 Trail does not learn within 60 iterations, and the relatives look like duplicates only because its own gain is 1.0.
The shortcut to avoid: with the start heading within 0.25 rad of the line, blind straight scored 2.25 (28%) at R 150; at 0.5 to 1 rad it scores 0.09.
Gap size matters: with singles 1.3 R + 10 apart a wiggle found the next single as well as a straight seeker (seek + wiggle 3.44, seek + straight 2.69 at R 150); at 1.8 R + 10 straight beats wiggle at every R.

Dropped:
- **Patrol** (`wide` layout: big empty world, 2 bites in sight and 2 beyond 1.5 R, the rest of 14 food regrowing at 0.5 per second at random spots; 1400 x 1400, 60 s, start energy 300). The baseline is good (spin 0, blind straight 1.0, seek + straight 6.1 against seek + wiggle 5.1 at R 150, second half 3.06 against 1.84; E1 3.23, E2 0.02, E4 40 seeds, E5 71%, E8 16.9 ms). The first draft (1600 x 1600, 12 food, regrow 0.4, start energy 150) starved every mover after 40% of the episode. Training fails the distinctness gate: Horizon training reaches 84% / 83% / 100% of Patrol's gain, Hand to mouth 88% on bodies 1 and 3 (gains 1.59, 4.55, 3.84; on body 1 the second-half food did not rise at all, 0.25 -> 0.25). Keeping moving where food regrows is the same travel skill Horizon trains.
- **Greener pastures** (3 bites in view, 10 out of sight at 2 to 3 R, 40 s). The baseline did not separate directed from random travel at the reach measure (straight 1.97 against wiggle 1.16 at R 150, reversed at R 60), and eating the near bites then leaving is Horizon's skill. A trickling poor patch needs patch-local regrowth, which the engine does not have (regrowth is uniform over the map). Not trained.
- **Hidden rooms** (`grid` layout: 3 x 3 rooms, 12 wall segments of poison items 8 apart with one door of 70 each, food in 3 of the 8 outer rooms, 1800 x 1800, 90 s). Every design died at the walls: alive 0.14 to 0.30 of the episode at sting 25 and at sting 10, 2 to 3 rooms entered, best founder 0.75 of 6 food, E1 1.70, E4 1873 seeds for 10%, random designs zero on every seed. A wall of touching items is a bath of stings for a creature that scrapes along it; the walls would need to be passable by cost, which makes them Four rooms again.

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

## Stragglers (2026-11-05, Erik's aggression env)

Fight. No food, 200 x 200, 30 s, learner 30 energy (living and thrust costs run it out in about 12 s standing still), kill energy 15, four targets that stand or drift (a 6-energy one still, two 6-energy ones at speed 0.1, a 44-energy one at speed 0.05), reward survive 0.1 per second + ram 1 + explore 0.03 per new cell.
Two engine options, both opt-in and unused by every older env (rlBench fingerprint 2078579358 unchanged):
- `Rivals.speed` (0 to 1): the group are drifters, the `charger` brain at that share of thrust (0 = still), whose thrust cost is refunded and which heal `DRIFTER_HEAL` = 30 energy/s up to their start energy. Gentle taps are healed away; only one hard hit kills the big one.
- `ramShare` (0 to 1, env field, `eco.ramShare`): splits a bump's damage by each creature's share of the closing speed along the line of centres, a share f of it giving that creature a damage factor 1 + r (1 - 2f) and the other 1 + r (2f - 1). At 1 the learner running at a still target takes no damage and the target takes twice the usual (2 x 0.3 x speed). The total stays the same. Without it the damage is symmetric, and then a run-up saved time but never energy: a kill cost the learner at least the victim's energy at any speed, so slow taps were as good as a hard hit (the first attempt, dropped, and its numbers, are in the history of this file).
Baselines (`docs/rl-notes/probes/f1-ram.ts`, 12 seeds x 3 bodies, seekers read the targets' positions): passive 12.4 s alive; spin 10.3; wiggle 8.1 s; seek at 0.3 thrust 13.0 s with 0.83 rams and the big target never killed; seek at full thrust 29.5 s, 3.33 rams, the big target killed in 100%.
Gates (`t3-snr.ts`, 64 held-out seeds): E1 SNR 2.02, E2 best scripted 1.91 against best founder pool:0 4.21 (45%), E4 15 seeds for a quarter of the gap, E5 random designs score on every seed, E8 5.9 ms per episode (loaded machine). E3 (best alive) not recorded.
Training (ES pop 200, 60 iterations, 1 episode, 64 held-out seeds): random:1 1.20 -> 5.27, random:2 1.23 -> 4.99, random:3 1.09 -> 6.09 (3 of 3).
Distinctness, share of Stragglers' own gain reached by a creature trained elsewhere (body 1 / 2 / 3): Corral 98% / 102% / 77%, Cull 67% / 103% / 77%, Ambush 59% / 75% / 81%, Turf war 39% / 7% / -2%. Corral and Cull overlap above the 85% line on bodies 1 and 2. Erik asked for the env by name, so it is kept despite the overlap (rule: an env he names stays); what separates it is the medium target, which only the run-up kills, and that is not what the overlap measure sees.
Tried before the shipped form: symmetric damage with survive only (no training gain), + ram (one body), + explore (two bodies, Corral 98%, Cull 93%); then `ramShare` 0.5 to 0.7 with heal 8 (the half-speed seeker killed the big target in 50 to 75%); ramShare 1 with heal 8 (taps are free, the half-speed seeker kills it in 100% and survives), which led to heal 30. Task-specific tuning is in `docs/rl-notes/probes/f1-stragglers.json` (symmetric spec, kept for the record).
