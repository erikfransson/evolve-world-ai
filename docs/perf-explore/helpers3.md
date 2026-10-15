| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Coordinator weight in the owner choice (`load * w` for the coordinator, w 0.7 to 1.5) | 3 helpers, w 1: main thread 24.6 to 25.2 CPU ms per tick, total 74 to 80 | w 1.25: main 22.6, total 75.6; w 1.5: main 21.5, total 75.3; w 0.85: main 25.6, total 73.9 | not measurable (see below) | yes (fingerprint 112434895 for every w, 12 s run) | none (636 to 658 MB) | 7 | Not worth it |
| Collect each helper reply early (slice the coordinator's own sensing) | not built | | at most 1.4 ms by the helpers2 estimate | | | | Not tried |
| Ship the coordinator's crowd grid to helpers | not built | | less CPU (about 1.2 ms per helper), longer critical path | | | | Not tried |

Inland Sea, 10000 creatures, ecoBench as in the brief, 12 s, `--threads 3`. The load stayed at 10.4 to 14.4 on 8 cores throughout (limit for thread benchmarks is 8), and `cpuPercent` was 82 to 88, so wall time is unusable. The coordinator's own sensing took 43 to 57 ms wall against about 13 ms CPU, and its wait for the helpers swung from 2 to 15 ms with no relation to the weight.

Main-thread CPU alone is the wrong metric here. Giving the coordinator less work lowers `mainCpuMsPerTick` (25.2, 22.8, 21.5 for w 1, 1.25, 1.5) but moves the wait to the coordinator, so the critical path does not shrink. Balance estimate from the helpers2 numbers (coordinator: 4.8 ms serial before its sensing, about 13.5 for its quarter share, 6 after; helper: 3.3 ms before it starts, 3.6 fixed, about 14.7 for a quarter share; helper CPU measured 18.3 at w 1, 17.6 at w 1.25, 17.9 at w 1.5): the helpers finish about 3 ms after the coordinator at w 1, so a larger coordinator share (w about 0.85, share 0.29) would equalise them and save under 1 ms of about 27 (3%). That sign is the opposite of idea (1) as stated. It is a model, not a measurement, and it needs an idle machine.

Code reverted; nothing from this round is merged. The weight is a one-line change in `ShareCoordinator.publish` (owner choice) if a quiet machine shows a gain.

## Ideas not tried
1. Pipeline tick N's shared phase (4.6 ms) with tick N+1's helper sensing, if the inputs allow it.
2. Measure on an idle machine with a per-phase wall trace (own, wait, collect) to tune w from data.
