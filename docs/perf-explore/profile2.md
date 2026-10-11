# Per-phase profile at 12k, 20k, 30k

Branch `worktree-agent-a6d063fc3cb59d409`, 2026-10-11, based on main at e17cba7.

| Idea | Before | After | Speedup | Exact? | Verdict |
|------|--------|-------|---------|--------|---------|
| PhaseTimer laps in the tick (`ecoBench --profile`) | no profile | same fingerprints with and without | n/a | yes | Kept, laps are `?.` no-ops when off |
| 3 helpers at 12k, 20k, 30k | 7.03, 21.98, 48.00 ms/tick (serial) | 7.11, 17.86, 40.67 | 0.99x, 1.23x, 1.18x | yes, same fingerprint | Measured under load 16 to 25, see notes |

## Setup

`node src/ecoBench.ts --seconds 60 --seed 1 --width W --profile`, plus `--threads 3 --shared` for the helper runs. Three repeats each, `nice -n 15`, at most two processes at once. Steady part is the ticks after the first quarter. Medians of three repeats.

Load average (1 min) during the 18 runs was 16 to 25. Repeat spread at 30k serial was 41.7 to 50.0 ms per tick (about 10%). Phases under 0.3 ms are noise.

Population is not at the Normal-preset steady state. It starts at 1000 founders (scaled by area) and falls during the 60 s. Steady mean population: 436 (12k), 1168 (20k), 2754 (30k). The per-1000 figures divide by these.

Fingerprints match between serial and 3-helper runs at each width (418441205, 344191640, 771101801).

## Ranked phases, serial, 30k

| Rank | Phase | ms/tick | Share | per 1000 creatures |
|------|-------|---------|-------|--------------------|
| 1 | "wasm sense items, queue" (JS item rays, walls, crowd queue) | 14.36 | 30% | 5.22 |
| 2 | "wasm brain encode and slots" (JS input encode, brain upload) | 7.70 | 16% | 2.80 |
| 3 | "wasm brain run" | 6.24 | 13% | 2.27 |
| 4 | memory and steer | 4.48 | 9% | 1.63 |
| 5 | eat | 4.33 | 9% | 1.57 |
| 6 | collisions | 3.42 | 7% | 1.24 |
| 7 | brain copy out | 1.48 | 3% | 0.54 |
| 8 | sort batch | 1.38 | 3% | 0.50 |
| 9 | crowd rays run | 1.28 | 3% | 0.47 |
| 10 | crowd grid | 1.27 | 3% | 0.46 |

The sum of phases matches steadyMsPerTick within 0.1%, so the laps cover the whole tick.

## Coordinator serial share, 3 helpers

Serial on the coordinator: publish, collect, collisions, births, settle and deaths, eat, regrow.

| Width | Serial ms | Serial share of tick |
|-------|-----------|----------------------|
| 20k | 3.4 of 17.9 | 19% |
| 30k | 9.1 of 40.7 | 22% |

At 30k the largest serial items are collisions 3.6 ms, publish 2.5 ms and collect 1.9 ms.

## Growth faster than population

Per-1000 costs are roughly flat from 20k to 30k. No phase shows a clear super-linear trend here.
- crowd grid per 1000: 0.39 (12k), 0.46 (20k), 0.46 (30k). Its full-grid clear is O(area), but it is about 3% of the tick.
- eat per 1000: 1.04, 1.55, 1.57. Rose at 20k, then flat.
- memory and steer per 1000: 1.35, 1.72, 1.63.
- Not measured: the snapshot item scan in worker/ecoRunner.ts (about 30 Hz, O(item capacity) per snapshot). It is outside ecoBench and I only read the code.

## Notes

- The helper runs are contention-limited. Under load 16 to 25 on 8 cores, the coordinator's own sense share at 30k took about 23 ms, against about 8 ms expected from the serial sense cost split four ways. Wall-clock helper speedups are therefore pessimistic. The serial-share numbers are wall time too, so treat them as upper bounds.
- In helper runs the sense laps cover only the coordinator's share. Helper work shows up only as "wait for helpers" (5.3 ms at 20k, 4.9 ms at 30k).
- The label "wasm sense items, queue" is misleading. It is JS per-creature item rays and wall sense plus queueing, so the largest single cost is JS.
- "wasm brain encode and slots" is also JS (input encode and brain weight upload). It is the second-largest cost and is not on the brief's list. Likely the next target.

## Cost in code

About 40 lines across sim/ecosystem.ts, sim/creature.ts, sim/wasm/senseKernels.ts, sim/ecoShare.ts, worker/ecoPool.ts and ecoBench.ts, plus sim/profile.ts (19 lines).
