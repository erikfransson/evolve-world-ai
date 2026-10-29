# Think every tick while another creature is near (T3)

Follow-up to `think2.md`.
With `eco.thinkEvery` above 1, a creature now also thinks on every tick after a think that had another creature in range, so it reacts to others as with thinkEvery 1.
The rule is `thinksNow`: first tick, or `sees`, or `(tick + id) % thinkEvery == 0`.

`sees` is "another creature is a crowd candidate": within ray length plus radius (plus the 1e-9 margin) and inside the ray fan's wedge test, the same filter the crowd rays use before their ray tests.
It is wider than "a ray hit a creature" (it includes creatures between rays), costs nothing to compute, and needs no change in the per-ray passes.

How:
- WASM: `fill.wat` puts the row address in the sense record (`REC_ROW`, the free word at 60), and `sense.wat` stores `cand != end` into the row (`R_SEES`, free word at 180) right after the crowd gather. One load and one store per creature, the only `sense.wat` change.
- JS: `Crowd.castRays` returns whether it gathered a candidate, `senseThink` keeps it in `Creature.sees` (the row field for resident creatures, a field otherwise).
- Helpers: the per-creature output block in `Packet.outputs` gains one word after the outputs (`OUTPUT_SIZE + stride + 1`), and BORN records carry it after the outputs, so restore onto new helpers and fallback to one thread stay identical.
- Saves: `creatures.sees`, the list positions with the flag set, only with thinkEvery above 1 (checked whole, in range). An older save without it restores with no flag set.
- `liveBench` prints `bumpKills` (lethal bumps with one survivor, via `eco.onBumpKill`) and with `--profile` `thinkShare` (creatures thinking per steady tick).
- Tests (`thinkEvery.test.ts`): the hold test now allows for `sees` and requires thinks caused by it, a placed three-creature test on both paths (one sees another ahead, one has it behind its fan, one alone, then the next tick's thinks), and the helper, restore and helper-failure test checks the saved flags. Removing the helper carry turns the helper tests red.

## Speed

`node src/liveBench.ts --seconds 60`, base is the `perf-live` worktree (thinkEvery 1), alternating rounds of base, T3 at 1, T3 at 2, and `perf-live --think 2` (the T2 rule), load 15-17 on 8 cores.

| Case                    | Base (every tick)      | T3 at 1                | T3 at 2                | T2 rule at 2           | Base / T3 at 2 | Base / T2 |
|-------------------------|------------------------|------------------------|------------------------|------------------------|----------------|-----------|
| 4 founders x 800        | 14.96, 14.79, 14.62    | 14.80, 14.76, 14.52    | 10.88, 10.90, 10.99    | 10.33, 10.43, 10.22    | 1.36x          | 1.43x     |
| Juggernaut x 4900 (cap) | 18.24, 18.40, 18.15    | 18.32, 16.13, 18.09    | 13.75, 12.49, 13.43    | 12.88, 12.15, 12.84    | 1.36x          | 1.42x     |

Thinking share per steady tick at thinkEvery 2: 0.559 (4 x 800) and 0.554 (Juggernaut), so the rule adds about 11% of creatures (the 11-12% with a crowd candidate, as in `senselive.md`).
Phases at 4 x 800 with `--profile`: senser 3.25, brain forward 2.97, slots 1.30, memory and steer 1.38.
Peak RSS 213-218 MB and 251-258 MB, the same as base.
thinkEvery 1 is bit-identical in every pair: fingerprint 708687555 and 10334191, as base.

## Behaviour

`liveBench --seconds 600 --copies 800 --seed N --every 60 --think K`, one at a time at idle priority. thinkEvery 1 repeats `think2.md` exactly (seed 1 to 3 births 5052, 4910, 5878).

| Seed | thinkEvery | Births | Deaths | Bump kills | Food left | Population at 0, 60, ... 600 s                          | CPU ms per tick |
|------|------------|--------|--------|------------|-----------|---------------------------------------------------------|-----------------|
| 1    | 1          | 5052   | 5243   | 225        | 18955     | 3200 3284 3253 3247 3219 3180 3166 3104 3074 3022 3009   | 13.75           |
| 1    | 2 (T3)     | 7107   | 7138   | 306        | 24402     | 3200 3239 3155 3108 3097 3089 3130 3112 3077 3093 3169   | 10.40           |
| 2    | 1          | 4910   | 5099   | 201        | 19243     | 3200 3323 3311 3293 3227 3233 3149 3107 3046 2982 3011   | 13.72           |
| 2    | 2 (T3)     | 8867   | 8675   | 381        | 21990     | 3200 3328 3274 3250 3273 3229 3208 3304 3317 3373 3392   | 10.54           |
| 3    | 1          | 5878   | 5976   | 259        | 18207     | 3200 3331 3304 3269 3270 3250 3197 3209 3148 3125 3102   | 13.32           |
| 3    | 2 (T3)     | 6705   | 6786   | 275        | 24574     | 3200 3244 3153 3111 3045 3069 3068 3045 3134 3117 3119   | 10.18           |

The T2 rule gave births 8202, 9147, 8882 and population 3367-3521 at 600 s (`think2.md`).
T3 moves part of the way back: births 6705-8867 (1.14-1.8x of thinkEvery 1), population at 600 s 3119-3392 against 3009-3102.
The dynamics are still outside the seed-to-seed spread of thinkEvery 1: every T3 run has more births, more deaths, more food left and a higher end population than every thinkEvery 1 run.
The 60 s runs agree: births 696 against 428 (T2 rule 739) at 4 x 800, and 1709 against 927 (T2 rule 1632) at the Juggernaut cap.

Bump kills are not the mechanism: they are 4-5% of deaths, and T3 adds 16-180 of them per 600 s against 800-3600 extra deaths.
A probe over 120 s (seed 1, 4 x 800, scratch script) points at the creature's own control loop instead:

| Collision damage | thinkEvery | Births | Deaths | Food eaten | Bump kills | Mean speed | Mean abs turn rate | Mean energy | Share with `sees` |
|------------------|------------|--------|--------|------------|------------|------------|--------------------|-------------|-------------------|
| 0.3 (live)       | 1          | 672    | 619    | 100639     | 27         | 71.4       | 0.73               | 542         | 0.116             |
| 0.3 (live)       | 2 (T3)     | 1271   | 1316   | 89288      | 63         | 70.0       | 0.92               | 438         | 0.116             |
| 0                | 1          | 703    | 614    | 99739      | 0          | 71.4       | 0.73               | 546         | 0.117             |
| 0                | 2 (T3)     | 1193   | 1174   | 89769      | 0          | 70.1       | 0.92               | 448         | 0.113             |

Creatures turn 26% more, eat 11% less food and hold 19% less energy, with only 12% of them near anyone.
With collision damage off the doubling of churn stays (births 703 against 1193), so encounters are not what drives it.
The likely cause is that each brain also reads its own speed and turn rate, and a held output is a two-tick delay in that feedback loop, which overshoots in steering towards food.
This last step is not measured. A check would hold only the thrust output and refresh the turn output every tick. That needs the brain every tick, so it is a diagnosis, not a speed-up.

## Verdict suggestion

The rule works as designed (exact at 1, 56% of creatures think per tick, 1.36x instead of 1.43x per tick, no memory cost) but does not bring the dynamics back within the thinkEvery 1 spread.
Do not switch the live world to 2 on the strength of it.
Reject. The collision-off pair shows the extra churn does not come from encounters, so no rule about nearby creatures can remove it. The remaining effect looks like the held outputs' delay in each creature's own steering.
