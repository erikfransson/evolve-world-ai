# Tuning notes

Running log of parameter experiments. Newest results at the top of the table.
Runs use `npm run headless` with a JSON override merged over `DEFAULT_CONFIG`, population 300, truncation selection unless noted.
"Mean" is the population mean survival time in seconds, averaged over the generations given.

| Date       | Change from defaults at the time                         | Epoch | Mean gen 0-4 | Mean late          | Best late | Verdict                                   |
|------------|----------------------------------------------------------|-------|--------------|--------------------|-----------|-------------------------------------------|
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
- Best fitness saturates at the epoch cap, so mean fitness is the better progress signal.
- An evolved creature (food 40, 30 generations) swims smooth looping sweeps across the whole world and survives 300 s, while weak ones curve into a wall and starve.
- A late generation takes about 10 s to compute because good creatures live the full epoch.

## Ideas not yet tried
- Evaluate each creature on two layouts to reduce layout luck.
- Tournament with a larger size (5 to 7).
- Plot best and mean fitness over generations on the page.
