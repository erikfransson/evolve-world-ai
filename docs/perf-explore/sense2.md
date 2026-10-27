# Sense every other tick, think every tick (idea 18, `eco.senseEvery`)

Follow-up to `think2.md` and `think3.md`: every creature runs its brain every tick with fresh body inputs and memory, but casts its rays only every senseEvery-th tick (staggered by id, newborns always sense) and keeps the ray part of its brain input in between. Only the ray inputs are one tick stale, for half of the creatures each tick. Code on branch `pl-sense2` (not merged): fill kernel field `F_SENSE`, sensing rows first in the batch, JS twin `Creature.thinkHeld`, helper packets carry the ray inputs, saves carry `creatures.rays` when senseEvery is above 1, senseEvery and thinkEvery above 1 together are refused.

## Speed (liveBench 60 s, rounds of base, senseEvery 1, senseEvery 2, load 9-17)

| Case             | Base                | senseEvery 1        | senseEvery 2        | Base / 2 |
|------------------|---------------------|---------------------|---------------------|----------|
| 4 founders x 800 | 13.32, 13.42, 13.43 | 11.99, 13.41, 13.61 | 12.02, 11.84, 11.96 | 1.12x    |
| Juggernaut x 4900| 16.65, 16.30, 14.60 | 16.72, 15.33, 16.62 | 14.81, 11.43, 14.56 | 1.12x    |

senseEvery 1 is bit-identical (fingerprints 708687555 and 10334191). Senser phase 5.0 to 2.85 ms; the brain is unchanged. Peak RSS unchanged.

## Behaviour (600 s, 4 founders x 800, every 60 s)

| Seed | senseEvery | Births | Deaths | Food  | Bump kills | Population at 600 s |
|------|------------|--------|--------|-------|------------|---------------------|
| 1    | 1          | 5052   | 5243   | 18955 | 225        | 3009                |
| 1    | 2          | 5844   | 5986   | 21570 | 195        | 3058                |
| 2    | 1          | 4910   | 5099   | 19243 | 201        | 3011                |
| 2    | 2          | 6541   | 6575   | 20074 | 235        | 3166                |
| 3    | 1          | 5878   | 5976   | 18207 | 259        | 3102                |
| 3    | 2          | 6405   | 6532   | 20416 | 215        | 3073                |

Births and food at senseEvery 2 fall outside (all three seeds) the senseEvery 1 range (births 4910-5878, food 18207-19243), though closer than thinkEvery 2 (8202-9147). Stale ray inputs alone already change the dynamics.

Verdict: rejected. 1.12x for 211 lines and a visible dynamics change. Parked on `pl-sense2` with thinkEvery 2 as options for Erik.
