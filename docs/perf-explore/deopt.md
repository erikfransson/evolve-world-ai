# V8 JIT audit of the tick's JavaScript (idea 105, study, no code change)

Branch `pl-deopt` from `perf-live` e204b2e. Node 24.18, all runs `taskset -c 2,3,6,7 nice 19 idle`, load 8-19. Scratch copies of `liveBench.ts` (tick markers, `%HaveSameMap`) were deleted; the branch holds only this file.
Question: do deoptimizations, polymorphic or megamorphic property loads, Smi/double flips or functions stuck in Maglev cost the JS part of the tick (about 5-7%, `scout-js.md`)?

## What the traces showed
| Check | How | Result |
|-------|-----|--------|
| Deopts after warm-up, mixed case | `--trace-deopt --trace-opt`, 60 s, tick markers every 150 ticks | 262 deopts, 261 before tick 450 (build and warm-up; reasons: insufficient type feedback, wrong map, OSR exits). 1 in the 1350 steady ticks (`keepOut`, once) |
| Deopts after warm-up, long run | same, 600 s (18000 ticks, 12000 steady) | 15 in the steady part, none repeated more than 3 times per function: `keepInside` 5 (rare wall-bounce branches meet feedback late), `remapWeights` 4, `set`, `remove`, `find`, `reorder`, `keepOut` once each. All cheap and one-shot |
| Deopts, cap case | `--only juggernaut --copies 4900`, 120 s | 27 in warm-up, 12 later, all single (`keepInside` wrong map once at tick 2700) |
| Object shapes | `%HaveSameMap` over all 3284 members at the end of the mixed run | 1 map each for member, `creature`, `creature.state` (`ResidentState`), `plan`, `brain`, and each object-valued creature and member field. All fields are set in the constructors, so no late-added fields and no `resident` flip |
| Megamorphic and polymorphic ICs | `--log-ic`, 60 s, last state per site, mapped to source by line and column | Megamorphic sites are map building and startup (`mapBuild.ts`, `envs.ts`, module loading). Polymorphic sites in the sim: `refit` and `growColumns` (typed array kinds, called per birth or grow), `copyPlan`, `keepInside`/`keepOut` (`Body` is `ResidentState` or a plain state in tests and RL, only the live path matters), `crowd.ts:121`. None in a per-creature loop of the live tick |
| Smi/double flips | deopt reasons "not a Smi" / "lost precision" | Only in warm-up map building (`field`, `buildMap`). Not in the tick |
| Functions in Maglev instead of TurboFan | `--trace-opt` marking events by tick, 600 s | Per-tick functions (`step`, `fill`, `pack`, `senseRows`, `runRows`, `touch`, `finishTick`, `sweepStart`) reach TurboFan only at tick about 10500 (350 simulated s, 2 min wall). `patchCell`, `sharedPhase`, `forwardRun`, `syncItems` reach it in the first 150 ticks. `prepareTick`, `prepareRows`, `senseThinkRows`, `runRegion`, `collideAll`, `eatAt`, `eatItem`, `consume`, `giveBirth`, `settle` stay in Maglev for the whole run (low invocation counts or short bodies) |
| Does the tier matter | `--always-turbofan` against default, 3 alternating pairs, `--profile`, fingerprint 708687555 in all | JS-heavy phases: slots 0.268 0.329 0.322 base, 0.318 0.313 0.320 turbofan; memory and steer 0.864 1.036 1.023 / 1.030 1.021 1.041; eat 0.847 1.025 1.000 / 1.010 1.001 1.024; collisions 0.159 0.187 0.190 / 0.186 0.188 0.196. Tick 9.44 11.34 11.14 base, 11.10 11.15 11.36 turbofan: no gain (the 9.44 run was a quiet moment) |
| Earlier tier-up | `--invocation-count-for-turbofan=300 --minimum-invocations-after-ic-update=30`, 3 pairs | tick 10.93 11.29 10.90 base, 10.93 11.20 11.85 earlier. No gain, fingerprint equal |
| JS share | `--cpu-prof` 200 us, 120 s, first 40% dropped | wasm 95.1%, JS 4.6%. Top JS self time: `patchCell` 0.83%, `forwardRun` 0.78%, `sharedPhase` 0.55%, `randomSpot` 0.20%, `membersKernel.run` 0.17%, `crowdKernel.rebuild` 0.14%, everything else under 0.12% |

## Reading
- The steady tick has no deopt loop, no megamorphic load and no shape instability. `v8.md` (ecoBench) found the same; this repeats it on the live setting and on the cap case with tick-resolved traces.
- Even forcing TurboFan on every function leaves the JS phases unchanged, so the Maglev residents (`eatAt`, `prepareTick`, ...) cost nothing extra. The remaining JS cost is typed-array traffic and cache misses (`patchCell` shifts, `forwardRun` stamp and walk), not code quality.
- The 60 s bench runs its steady part (ticks 450-1800) before the per-tick functions reach TurboFan. The always-turbofan pairs show this does not bias the numbers.
- The dozen late one-shot deopts (`keepInside`, `remapWeights`) cost one recompile each on the compiler thread over a whole run: not worth touching.

## Verdict
Nothing to fix; the JS part of the tick is JIT-clean. Idea 105 rejected, no code change (fingerprint 708687555 unchanged, the engine is untouched). The 4.6% JS share bounds any further JS work at under 0.5 ms a tick, and `patchCell` and `forwardRun` are memory-bound (`scout-js.md`).
