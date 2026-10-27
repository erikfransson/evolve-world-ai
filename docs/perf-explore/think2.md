# Think every other tick (T2)

`eco.thinkEvery` (default 1, `liveConfig` 2): each creature senses and runs its brain only on ticks where `(tick + id) % thinkEvery == 0`, and always on its first tick (its outputs are not yet its own).
Between thinks it keeps its last outputs, and memory, steer, movement, eating, collisions, births and deaths run every tick as before.
Memory units still update every tick toward the held targets, so the memory time constants in simulated seconds are unchanged and `step.wat` is untouched.

How:
- `senseThinkRows` (`wasm/residentStep.ts`) runs `prepareRows` on the whole batch (the step needs every ground factor), then hands only the thinking rows and selves to `runRows`. The selected creature is read back only on ticks it thinks.
- JS path: `thinkersOf` filters the `SenseBatch` for `senseThinkBatch`, the step still walks the whole batch.
- Helpers: the packet carries the tick (`H_TICK`), each helper filters its own creatures the same way, and with thinkEvery above 1 the brain outputs travel back every tick (`Packet.outputs`) and go out with each BORN record. So the coordinator holds every output, a restore onto new helpers and a fallback to one thread continue identically.
- Saves carry `creatures.outputs` (f32, checked to lie in -1 to 1) when thinkEvery is above 1; `eco.thinkEvery` is checked to be whole, 1 to 8.
- `liveBench --think N` overrides the setting.

Deployment note: a save from today's server has no `thinkEvery` and restores with 1; the live world switches to 2 only on a fresh world or a config change on load.

## Speed

`node src/liveBench.ts --seconds 60`, base is the `perf-live` worktree, alternating pairs, load 17-19 on 8 cores.

| Case                       | Base cpuMsPerTick      | thinkEvery 2           | Ratio of medians | Peak RSS base / T2 MB |
|----------------------------|------------------------|------------------------|------------------|-----------------------|
| 4 founders x 800           | 15.67, 15.36, 15.66    | 10.36, 10.50, 10.02    | 1.51x            | 216-218 / 217-250     |
| Juggernaut x 4900 (cap)    | 18.86, 18.97, 18.79    | 11.50, 12.83, 12.95    | 1.47x            | 255-259 / 252-254     |

Phases at 4 x 800, thinkEvery 2 (base in brackets): senser 3.18 (5.74), brain forward 2.65 (5.23), slots 1.21 (1.04), memory and steer 1.31 (1.26), eat 1.04 (1.05).
The peak RSS spread is GC timing: the same deterministic run gave 217 and 250 MB.
thinkEvery 1 is bit-identical: fingerprint 708687555 (4 x 800, 15.42 ms) and 10334191 (Juggernaut, 18.94 ms), both equal to base.

## Behaviour

`liveBench --seconds 600 --copies 800 --seed N --every 60 --think K`, one thread.

| Seed | thinkEvery | Births | Deaths | Food left | Population at 0, 60, ... 600 s                               | CPU ms per tick |
|------|------------|--------|--------|-----------|--------------------------------------------------------------|-----------------|
| 1    | 1          | 5052   | 5243   | 18955     | 3200 3284 3253 3247 3219 3180 3166 3104 3074 3022 3009        | 12.56           |
| 1    | 2          | 8202   | 8035   | 22227     | 3200 3297 3225 3230 3233 3274 3226 3229 3245 3355 3367        | 9.88            |
| 2    | 1          | 4910   | 5099   | 19243     | 3200 3323 3311 3293 3227 3233 3149 3107 3046 2982 3011        | 13.68           |
| 2    | 2          | 9147   | 8826   | 21681     | 3200 3349 3314 3325 3306 3330 3354 3325 3409 3437 3521        | 10.11           |
| 3    | 1          | 5878   | 5976   | 18207     | 3200 3331 3304 3269 3270 3250 3197 3209 3148 3125 3102        | 14.29           |
| 3    | 2          | 8882   | 8630   | 22021     | 3200 3309 3311 3270 3298 3249 3308 3288 3326 3371 3452        | 9.42            |

The difference is outside the seed-to-seed spread.
With thinkEvery 1 the population drifts down to 3009-3102 at 600 s, with 2 it drifts up to 3367-3521.
Births and deaths are 1.5-1.9x higher, and 3-4k more food is left.
The 60 s runs show the same: 739 against 428 births (4 x 800), 1632 against 927 at the Juggernaut cap.
So creatures die sooner (slower reactions, likely more lethal bumps and missed food) but the world holds more of them, probably because the mix shifts toward smaller brains under the weight cap (not measured; the bench prints no lineage shares).
Per 1000 creatures the 600 s runs cost 2.84-3.03 ms against 4.01-4.46 ms, 1.43x.

## Verdict suggestion

1.5x per tick, the largest single gain of the campaign, at no memory cost, exact at thinkEvery 1.
The Live World's dynamics change clearly (twice the churn, a different population trend), so merging it is Erik's call on behaviour, not on speed.
Before turning it on: check lineage shares and lifespans over a longer run, and decide how a restored live world picks the setting up.
