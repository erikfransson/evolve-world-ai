# Tuning notes

Running log of parameter experiments. Newest results at the top of the table.
Runs use `npm run headless` with a JSON override merged over `DEFAULT_CONFIG`, population 300, truncation selection unless noted.
"Mean" is the population mean survival time in seconds, averaged over the generations given.

| Date       | Change from defaults at the time                         | Epoch | Mean gen 0-4 | Mean late          | Best late | Verdict                                   |
|------------|----------------------------------------------------------|-------|--------------|--------------------|-----------|-------------------------------------------|
| 2026-10-10 | memory 0.5 (4 short + 4 long) + costs (turn 0.5, ray 0.02, neuron 0.005) | none | 24 | 29 (gen 25-29) | 179 | Learns weakly; main baseline today 49 / 242 |
| 2026-10-10 | costs only (memory 0)                                    | none  | 25           | 50 (gen 25-29)     | 248       | Costs do not hurt learning                |
| 2026-10-10 | memory 0.5, costs 0                                      | none  | 28           | 33 (gen 25-29)     | 181       | Memory causes the drop                    |
| 2026-10-10 | memory 0.5 with both rates 0 (dead memory, extra genes)  | none  | 24           | 48 (gen 25-29)     | 250       | Extra genes alone are harmless            |
| 2026-10-10 | memory 0.5, long rate 0 (4 short units active)           | none  | 24           | 46 (gen 25-29)     | 240       | Short memory alone is fine                |
| 2026-10-10 | memory 0.5, long rate 0.05                               | none  | 24           | 31 (gen 25-29)     | 183       | Faster long memory does not help          |
| 2026-10-10 | memory 0.25 (2 + 2)                                      | none  | 24           | 39 (gen 25-29)     | 232       | Less memory, less harm                    |
| 2026-10-10 | memory 1 (8 + 8), founders with memory inputs at 0     | none  | 23           | 27 (gen 25-29)     | 143       | Most memory, most harm                    |
| 2026-10-10 | memory 0.5, founders with memory weights at 0            | none  | 24           | 29 (gen 25-29)     | 201       | No help, dropped                          |
| 2026-10-10 | engine final: binary brake (output < -0.5, maxBrake 200), wallBounce 0.6, poison kept off start | none  | 25           | 49 (gen 25-29)     | 242       | Baseline 50 / 259; 5 seeds, pop 150. Learns clearly |
| 2026-10-10 | same, braking only (wallBounce 0)                        | none  | 25           | 44 (gen 25-29)     | 209       | Braking costs the most, seeds are noisy   |
| 2026-10-10 | earlier analog brake (any negative output), 5 seeds      | none  | 25           | 46 (gen 25-29)     | 209       | Replaced by the binary brake              |
| 2026-10-10 | wallBounce 0.6 only / poison clear disc only             | none  | 25           | 57 / 56 (gen 25-29) | 284 / 295 | Neither hurts                             |
| 2026-10-09 | drag 2.5 + thrust 200 + 2x drain + food 0.7 (D4)         | none  | 26           | 53 (gen 25-29)     | 247       | New default: faster drain, more drag, still learns |
| 2026-10-09 | drag 2.5 + thrust 200 + 2x drain (D3)                    | none  | 25           | 44 (gen 25-29)     | 137       | Learns slowly                             |
| 2026-10-09 | 2x drain: living 2, thrust 4 (D2)                        | none  | 24           | 45 (gen 25-29)     | 149       | Halves lifetimes                          |
| 2026-10-09 | drag 2.5, maxThrust 200 (top speed kept at 80) (D1)      | none  | 53           | 130 (gen 25-29)    | 614       | More drag helps learning                  |
| 2026-10-09 | uncapped energy storage, poison always kills             | none  | 52           | 90 (gen 25-29)     | 513       | Learns, best life up to 762 s, no idling incentive |
| 2026-10-09 | creature radius 16, food 0.35                            | none  | 54           | 63 (gen 25-29)     | 228       | Too hard                                  |
| 2026-10-09 | creature radius 16                                       | none  | 54           | 96 (gen 25-29)     | 346       | Learns slower than radius 12              |
| 2026-10-09 | creature radius 12, food 0.35                            | none  | 52           | 59 (gen 25-29)     | 251       | Too hard                                  |
| 2026-10-09 | creature radius 12 (was 6), drawn at true size           | none  | 52           | 119 (gen 25-29)    | 488       | New default, visible and honest contact   |
| 2026-10-09 | finite food (no respawn), food 0.5, population 150       | none  | 52           | 144 (gen 25-29)    | 519       | Best so far, 3.7 s per late gen, new default |
| 2026-10-09 | finite food (no respawn), food 0.3                       | none  | 51           | 54 (gen 25-29)     | 249       | Too sparse, no progress                   |
| 2026-10-09 | finite food (no respawn), food 0.5, population 300       | none  | 51           | 109 (gen 25-29)    | 475       | Learns, no cap saturation, 5.9 s per gen  |
| 2026-10-09 | new defaults: 1600x1000, food 0.5, poison 0.1, lethal    | 300 s | 53           | 120 (gen 25-29)    | 300       | Learns steadily, about 6 s per late gen   |
| 2026-10-09 | food 40, poison 40, poisonEnergy 200                     | 300 s | 46           | 54 (gen 35-39)     |           | Too hard, little progress                 |
| 2026-10-09 | food 40, poison 40, poisonEnergy 35                      | 300 s | 47           | 64 (gen 35-39)     |           | Too hard, little progress                 |
| 2026-10-09 | food 40, poison 20, poisonEnergy 200 (lethal)            | 300 s | 48           | 107 (gen 35-39)    |           | Learns, poison 0.2/min vs 0.54, new default |
| 2026-10-09 | food 40, poison 20, poisonEnergy 100                     | 300 s | 48           | 107 (gen 35-39)    |           | Identical to 200, both lethal at max 100  |
| 2026-10-09 | food 40, poison 20, tournament selection (size 3)        | 300 s | 50           | 51 (gen 35-39)     | 89        | No progress, selection too weak           |
| 2026-10-09 | food 40, poison 20, parentFraction 0.2                   | 300 s | 49           | 129 (gen 35-39)    | 300       | Works, slower than top 10%                |
| 2026-10-09 | food 40, poison 20, mutationRate 0.02                    | 300 s | 49           | 186 (gen 35-39)    | 300       | Works, slow start then catches up         |
| 2026-10-09 | food 40, poison 20                                       | 300 s | 50           | 174 (gen 35-39)    | 300       | Good, chosen as new default               |
| 2026-10-09 | food 60, poison 40                                       | 300 s | 56           | 163 (gen 24)       | 300       | Good, best unsaturated until about gen 14 |
| 2026-10-09 | food 30, poison 30                                       | 120 s | 40           | 35 (gen 24)        | 60        | Too sparse, luck dominates, no progress   |
| 2026-10-09 | food 60, poison 40                                       | 120 s | 56           | 91 (gen 24)        | 120       | Best saturates at the cap from gen 0      |
| 2026-10-09 | old defaults (food 150, poison 60)                       | 120 s | 52           | 106 (gen 24)       | 120       | Too easy, best saturates at the cap       |

All rows from 2026-10-09 use the fish-like physics.

## Observations
- 2026-10-10: body plans and memory (#4, #10). Energy per second now also pays turnCost 0.5 at full turn rate, rayCost 0.02 per ray at length 100 (linear in length) and neuronCost 0.005 per hidden neuron and memory unit; braking stays free. Memory setting 0.5 gives 4 short (rate 0.3/tick) + 4 long (0.01/tick) units, 30% of the default Trials weights (23% in the Ecosystem); 1 gives 8 + 8, 46%. Rows above are 5 seeds x 30 generations, pop 150, measured before the 150-unit poison-free start radius. Learning slows with the long-term units; open question whether to lower the default memory.
- 2026-10-10: a thrust output below brakeThreshold (-0.5) brakes at a fixed maxBrake 200 (free, never reverses, coasting between -0.5 and 0), walls reflect with wallBounce 0.6 instead of absorbing, and no poison starts within radius + itemRadius + 10 of the start point (issue #3). Trials results changed on purpose; ecosystem founders also get poison moved away.
- A bigger body does not make foraging easier: it also touches poison more often, so mean survival drops from 144 s (radius 6) to 119 s (12) and 96 s (16).
- From the finite-food rows on there is no lifetime cap ("none"). Lives end when energy runs out, and a 3600 s safety stop is never reached in practice. Best fitness no longer saturates.
- Brain inputs now include forward speed and turn rate besides rays and energy.
- From 2026-10-09 the world is 1600 x 1000 and item amounts are densities (1 = one item per rayLength^2). Food 0.5 and poison 0.1 give 80 and 16 items, similar per-area amounts to the food 40 / poison 20 runs above (50 and 10 per million square units versus 40 and 20).
- Lethal poison (then poisonEnergy above maxEnergy, now poison simply kills) cuts poison eaten by the top 30 from 0.54 to 0.2 per minute and lowers mean survival, which keeps the max lifetime cap from saturating as fast.
- Best fitness saturates at the epoch cap, so mean fitness is the better progress signal.
- An evolved creature (food 40, 30 generations) swims smooth looping sweeps across the whole world and survives 300 s, while weak ones curve into a wall and starve.
- A late generation takes about 10 s to compute because good creatures live the full epoch.
- 2026-10-10: Trials poison-free start radius raised to 150 units (world.poisonClearRadius, capped at 35% of the shorter world side) after the owner saw poison right next to the start.

## Ideas not yet tried
- Evaluate each creature on two layouts to reduce layout luck.
- Tournament with a larger size (5 to 7).
- Plot best and mean fitness over generations on the page.
