# T10 B8: trained founders and uploads in Live (2026-11-13)

Question: when the Arena's training tiers (Light, Medium, Strong) fine-tune a Live founder or an uploaded design, does the trained brain do better in the Live world, and does the tier's 32-seed re-score pick the brains that do?

## Method

Starts: the six shipped founders (`rlStarts.ts`, founders) and three B1 uploads (p3, p5, p10 from `runs/b1/strong/ppo-mix1-s1`), made by `runs/b8/mkstarts.ts`.
Each start was trained with `rlTiers.ts --protocol ppo05 --rescore 32` at each tier and training seeds 1 to 3, 81 units in all, 2 threads under the shared lock.
The re-score keeps the trained brain only when it beats the start on 32 held-out seeds ("picked").
Live check: `probes/b8-live.ts` seeds the server's LiveWorld (800 copies of each founder), inserts 3 copies of each start's original brain and of its Light, Medium and Strong brains from one training seed, and runs 240 s.
All four sets share one world, so they compete.
There were 9 runs, training seeds 1 to 3 against world seeds 1 to 3. Each took about 135 s wall at 3400 to 3850 creatures.
`probes/b8-analyze.py runs/b8 runs/b8/live` makes the tables. A cell is one (training seed, world), and the value is the mean over the 3 copies.
The CIs are 1.96 standard errors over cells or cases. Cells share worlds and starts, so the CIs are optimistic.

## Re-score picks

| Start        | Light picks | Medium picks | Strong picks |
|--------------|------------:|-------------:|-------------:|
| GentleGrazer | 3/3         | 3/3          | 3/3          |
| Grazer       | 2/3         | 2/3          | 3/3          |
| Juggernaut   | 0/3         | 0/3          | 0/3          |
| Oracle       | 0/3         | 1/3          | 1/3          |
| Pathfinder   | 3/3         | 3/3          | 3/3          |
| Rammer       | 0/3         | 1/3          | 0/3          |
| up-p10       | 3/3         | 3/3          | 2/3          |
| up-p3        | 3/3         | 3/3          | 3/3          |
| up-p5        | 2/3         | 3/3          | 3/3          |
| All          | 16/27       | 19/27        | 18/27        |

## Live, trained minus original

Every trained brain, picked or not, pooled over starts, training seeds and worlds:

| Group             | Cases | Life s        | Food/min     | Poison/min   | Children     | Share life > 0 |
|-------------------|------:|---------------|--------------|--------------|--------------|---------------:|
| Picked            | 159   | +28.3 (±7.6)  | +3.2 (±1.1)  | +0.02 (±0.01) | +2.2 (±0.5) | 0.70           |
| Not picked        | 84    | +12.8 (±10.7) | +1.5 (±1.8)  | -0.01 (±0.02) | +0.9 (±0.8) | 0.64           |
| Light, picked     | 48    | +36.2 (±11.8) | +4.0 (±2.0)  | +0.02        | +2.7 (±0.9)  | 0.79           |
| Medium, picked    | 57    | +16.7 (±12.5) | +2.3 (±1.9)  | +0.01        | +1.5 (±0.9)  | 0.65           |
| Strong, picked    | 54    | +33.4 (±14.1) | +3.6 (±1.9)  | +0.03        | +2.6 (±1.0)  | 0.69           |

The kept brain (the re-score's choice, which is the original when nothing was picked) minus the original, median over the 9 starts: Light life +10.2 s and food +1.2/min, Medium +8.7 s and +2.4/min, Strong +7.1 s and +0.7/min.
No kept brain is clearly worse than its original in Light or Strong. In Medium one start is down (up-p10, -30.7 s).

Per start, every case (picked or not), life s and food/min:

| Start        | Light          | Medium         | Strong         |
|--------------|----------------|----------------|----------------|
| GentleGrazer | +23.3 / +2.4   | +7.5 / +2.4    | +19.0 / +2.8   |
| Grazer       | +10.7 / +1.8   | +43.9 / +6.4   | +47.7 / +3.9   |
| Juggernaut   | +24.9 / +2.7   | -1.8 / +4.4    | +44.2 / +8.8   |
| Oracle       | +22.7 / +3.8   | +48.9 / +4.6   | +19.0 / +2.8   |
| Pathfinder   | +55.2 / +9.7   | +29.5 / +4.8   | +81.0 / +13.5  |
| Rammer       | -13.0 / -5.3   | -23.3 / -7.6   | -20.1 / -5.6   |
| up-p10       | -4.8 / -1.3    | -30.7 / -3.6   | -11.7 / -3.0   |
| up-p3        | +58.7 / +2.4   | +48.0 / +3.7   | +46.3 / +2.7   |
| up-p5        | +69.9 / +10.2  | +23.9 / +4.5   | +0.2 / -0.7    |

## Reading

- Training transfers to Live for most starts. Picked brains gain about twice as much as unpicked ones (life +28 s vs +13 s, children +2.2 vs +0.9), so the re-score is a useful filter.
- The filter is not perfect. The Juggernaut and the Oracle are mostly not picked, yet their trained brains gain in Live. up-p10 is picked in 8 of 9 cases and loses in Live at every tier.
- The Rammer gets worse in Live at every tier (-13 to -23 s, -5 to -8 food/min). Its training mix rewards ramming, which Live pays little for (kill bonus 5). The re-score keeps 1 of its 9 trained brains.
- No tier is clearly best. Light, the cheapest (a 54 CPU s budget, against 134 s for Medium and 357 s for Strong), does as well as Strong here. This one-seed-per-cell check cannot rank the tiers more finely than that.
- Poison per minute does not change (within ±0.1).
- Caveats: 240 s in a world of founder copies, inserted at visitor energy, 3 copies per brain, and optimistic CIs. This says nothing about long-run evolution, which C7 showed reshapes brains within an hour.
