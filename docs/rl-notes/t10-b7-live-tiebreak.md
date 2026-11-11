# T10 B7: Live transfer tie-break, Strong lr 0.001 against 0.003 (2026-11-11)

Question 1: does ppo-mix1 (Strong, PPO lr 0.001, shipped) transfer to the Live world better than ppo-mix (lr 0.003)?
Question 2: the same for Medium, ppo-mix (lr 0.003, shipped) against ppo-mix1 (lr 0.001).
Medium runs for both lrs with 6 training seeds already existed in `runs/b1/medium` (from B1 and B3), so nothing was trained.

## Method

`probes/b7-live.ts` is `b1-live.ts` plus per-creature food and poison counts.
It seeds the server's LiveWorld (800 copies of each founder, 4900 creatures at the end), inserts 3 copies of each of the 10 bodies of 6 sets (untrained, Strong current, Strong ppo-mix1, Strong ppo-mix, Medium ppo-mix1, Medium ppo-mix) with Live's visitor start energy, and runs 240 s.
Sets share one world per run, so they compete.
One run per (training seed 1 to 6, world seed).
Cells are (training seed, world); the cell value of a body is the mean life over its 3 copies, and food or poison per minute is the sum of items over the sum of life.
Done: 20 cells per body (world seeds 1 to 3 fully, world 4 for training seeds 1 and 2 only; the rest was dropped because of lock queueing).
Life is censored at 240 s, food and poison counts are read once per second.
Differences are paired per cell; up/down = bodies whose 95% CI (over cells, cells in one world share a world so the CI is somewhat optimistic) is above/below 0; seeds agree = bodies where all 6 training-seed means have the same sign.
Analysis: `probes/b7-analyze.py`.

## Results (median over the 10 bodies of the cell mean, then paired differences over bodies)

| set | life s | food/min | poison/min | children |
|---|--:|--:|--:|--:|
| Mmix | 214.85 | 7.48 | 0.03 | 1.57 |
| Mmix1 | 202.43 | 7.31 | 0.04 | 1.42 |
| Scur | 158.12 | 6.14 | 0.03 | 1.23 |
| Smix | 217.11 | 8.50 | 0.03 | 1.54 |
| Smix1 | 218.38 | 8.74 | 0.02 | 2.02 |
| untr | 134.67 | 0.33 | 0.00 | 0.04 |

### Smix1 minus Smix
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | -38.38 | -4.02 | +35.30 | 2 | 3 | 1/10 |
| food/min | -1.83 | +0.54 | +2.48 | 3 | 2 | 0/10 |
| poison/min | -0.06 | -0.01 | +0.02 | 0 | 0 | 0/10 |
| children | -0.43 | +0.42 | +0.93 | 4 | 1 | 1/10 |

### Smix1 minus untr
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | -12.97 | +81.17 | +113.77 | 9 | 0 | 8/10 |
| food/min | +3.68 | +8.09 | +12.49 | 10 | 0 | 10/10 |
| poison/min | -0.06 | +0.01 | +0.12 | 4 | 1 | 2/10 |
| children | +0.27 | +1.90 | +3.10 | 10 | 0 | 8/10 |

### Smix minus untr
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | +3.57 | +77.28 | +110.32 | 9 | 0 | 6/10 |
| food/min | +4.78 | +7.38 | +10.76 | 10 | 0 | 10/10 |
| poison/min | -0.06 | +0.03 | +0.15 | 5 | 1 | 2/10 |
| children | +0.43 | +1.32 | +2.17 | 10 | 0 | 9/10 |

### Smix1 minus Scur
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | -10.02 | +39.11 | +108.87 | 7 | 0 | 6/10 |
| food/min | -0.61 | +2.69 | +5.78 | 8 | 0 | 6/10 |
| poison/min | -0.16 | +0.00 | +0.11 | 2 | 2 | 3/10 |
| children | -1.88 | +0.25 | +1.77 | 4 | 2 | 4/10 |

### Mmix minus Mmix1
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | -16.80 | +5.25 | +51.63 | 2 | 1 | 1/10 |
| food/min | -1.24 | -0.33 | +3.96 | 1 | 2 | 1/10 |
| poison/min | -0.13 | -0.01 | +0.03 | 0 | 2 | 1/10 |
| children | -0.20 | +0.09 | +1.12 | 2 | 0 | 1/10 |

### Mmix minus untr
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | -13.03 | +67.00 | +117.20 | 9 | 0 | 7/10 |
| food/min | +3.92 | +6.25 | +9.39 | 10 | 0 | 9/10 |
| poison/min | -0.06 | +0.02 | +0.08 | 6 | 1 | 1/10 |
| children | +0.20 | +1.46 | +2.10 | 10 | 0 | 8/10 |

### Mmix1 minus untr
| metric | min | median | max | up | down | seeds agree |
|---|--:|--:|--:|--:|--:|--:|
| life s | +1.37 | +49.32 | +113.83 | 7 | 0 | 7/10 |
| food/min | +1.70 | +5.97 | +10.62 | 10 | 0 | 9/10 |
| poison/min | -0.05 | +0.04 | +0.17 | 5 | 0 | 1/10 |
| children | +0.25 | +1.14 | +2.12 | 9 | 0 | 9/10 |

## Verdict

Strong stays at PPO lr 0.001.
- Strong ppo-mix1 against ppo-mix: no difference in Live. Life -4 s (median over bodies, 2 up and 3 down), food +0.5 per minute (3 up, 2 down), children +0.4 (4 up, 1 down), seed agreement 0 to 1 body of 10. Levels are the same too (life 218 against 217 s, food 8.7 against 8.5). Nothing supports switching to 0.003, and 0.003 does not win on poison either (differences about 0.01 per minute).
- Both Strong brains transfer well against untrained: life +81 s and +77 s (9 bodies up, 0 down), food +8.1 and +7.4 per minute on 10/10 bodies with all seeds agreeing.
- Strong ppo-mix1 against current: life +39 s (7 up, 0 down), food +2.7 per minute (8 up, 0 down), poison per minute unchanged.
- Poison per minute is tiny in Live for every set (0.00 to 0.04), so it cannot separate the protocols.

## Medium

Medium ppo-mix (lr 0.003, shipped) against ppo-mix1 (lr 0.001): life +5 s (2 up, 1 down), food -0.3 per minute (1 up, 2 down), poison -0.01 (0 up, 2 down), children +0.09, seed agreement 0 to 1 body of 10.
Levels: life 215 against 202 s, food 7.5 against 7.3.
The tie holds for Medium as well, the shipped lr 0.003 is not contradicted, and the small life edge (+13 s in the level table) is within the spread over bodies (min -17, max +52).
Medium and Strong sets did not differ from each other in this world beyond noise (Strong ppo-mix1 life 218 s against Medium ppo-mix 215 s).

## Caveats

- Fresh Live world at the 4900 cap, life censored at 240 s, sets compete in one world (see B1).
- 20 cells per body, 3 copies per cell; cells within one world are not independent, so CIs are optimistic.
- Same body set and Live check as B1 (10 bodies, random starts), not founders or uploads.
