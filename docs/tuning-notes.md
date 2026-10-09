# Tuning notes

Running log of parameter experiments. Newest results at the top of the table.
Runs use `npm run headless` with a JSON override merged over `DEFAULT_CONFIG`, population 300, truncation selection unless noted.
"Mean" is the population mean survival time in seconds, averaged over the generations given.

| Date       | Change from defaults at the time                         | Epoch | Mean gen 0-4 | Mean late          | Best late | Verdict                                   |
|------------|----------------------------------------------------------|-------|--------------|--------------------|-----------|-------------------------------------------|
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
- From 2026-10-09 the world is 1600 x 1000 and item amounts are densities (1 = one item per rayLength^2). Food 0.5 and poison 0.1 give 80 and 16 items, similar per-area amounts to the food 40 / poison 20 runs above (50 and 10 per million square units versus 40 and 20).
- Lethal poison (poisonEnergy above maxEnergy) cuts poison eaten by the top 30 from 0.54 to 0.2 per minute and lowers mean survival, which keeps the max lifetime cap from saturating as fast.
- Best fitness saturates at the epoch cap, so mean fitness is the better progress signal.
- An evolved creature (food 40, 30 generations) swims smooth looping sweeps across the whole world and survives 300 s, while weak ones curve into a wall and starve.
- A late generation takes about 10 s to compute because good creatures live the full epoch.

## Ideas not yet tried
- Evaluate each creature on two layouts to reduce layout luck.
- Tournament with a larger size (5 to 7).
- Plot best and mean fitness over generations on the page.
