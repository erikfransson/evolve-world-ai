# profile3: reference profile at the new target

Main ff1dd88 plus the profiler port (commit ef27947). Serial, WASM on, seed 1. CPU ms from process.cpuUsage over steady ticks (after the first quarter). Single run per config, load 10 to 18. Expect a few percent of noise.

Commands: `node src/ecoBench.ts --width W --seconds S --profile`; The Great Hunt adds `--predators`.

## Key findings

- `--width 38000` with default founders gives 10000 founders, not about 5k. Founders scale with area (1000 at width 12000 times scale squared, so 10030 at 38000), and maxPopulation caps at 10000. Steady population is 9.2k to 9.8k at 38000 to 70000. For about 5k at 38000 pass `--pop 5000` (steady 4.6k).
- Population is pinned near the 10000 cap across widths, so per-tick cost growth with width is mostly not population growth.
- Per creature, grows faster than population (38000 to 70000, per 1000 creatures per tick): crowd grid +24% (0.30 to 0.37 ms), sort batch +23% (0.33 to 0.40), senser run +14% (3.38 to 3.86 us per creature), eat +12%.
- Regrow grows with area, not population: 0.053 to 0.244 ms per tick (4.3 times per creature), still only 0.3% of the tick.
- Flat per creature: brain forward, memory and steer, collisions, births.
- Total CPU ms per tick rises +16% from 38000 to 70000 while steady population rises +7%.

## Summary

| Config | Seconds | CPU ms/steady tick | steady pop | ms per 1000 creatures | peak RSS MB | fingerprint |
|---|---|---|---|---|---|---|
| Ecosystem 38000 | 20 | 79.67 | 9180 | 8.679 | 319 | 883623516 |
| Ecosystem 50000 | 20 | 81.99 | 9249 | 8.865 | 327 | 417440906 |
| Ecosystem 70000 | 10 | 92.21 | 9808 | 9.402 | 332 | 386149819 |
| Ecosystem 38000 --pop 5000 | 20 | 36.64 | 4632 | 7.910 | 207 | 270265186 |
| Great Hunt 30000 | 20 | 105.66 | 10000 | 10.566 | 317 | 144548800 |
| Great Hunt 38000 | 20 | 99.62 | 10000 | 9.962 | 324 | 416601369 |

The 70000 run has 225 steady ticks, so it is the noisiest row. The Great Hunt 38000 row is faster per tick than 30000, which is probably load noise (one run each, no A/B pairs).

## Per phase (ms per steady tick, share of total)

| Phase | 38000 | 50000 | 70000 | Hunt 30000 | Hunt 38000 |
|---|---|---|---|---|---|
| wasm senser run (item and crowd rays, inputs) | 31.07 (39.0%) | 32.72 (39.9%) | 37.82 (41.0%) | 43.34 (41.0%) | 40.72 (40.9%) |
| memory and steer | 14.78 (18.6%) | 15.10 (18.4%) | 15.98 (17.3%) | 20.63 (19.5%) | 19.69 (19.8%) |
| wasm brain forward | 14.22 (17.9%) | 14.02 (17.1%) | 15.01 (16.3%) | 16.50 (15.6%) | 16.01 (16.1%) |
| eat | 5.92 (7.4%) | 6.27 (7.7%) | 7.09 (7.7%) | 6.09 (5.8%) | 6.08 (6.1%) |
| collisions | 5.31 (6.7%) | 4.98 (6.1%) | 5.54 (6.0%) | 3.80 (3.6%) | 2.65 (2.7%) |
| sort batch | 3.02 (3.8%) | 3.17 (3.9%) | 3.96 (4.3%) | 3.44 (3.3%) | 3.34 (3.4%) |
| crowd grid | 2.77 (3.5%) | 2.90 (3.5%) | 3.66 (4.0%) | 3.25 (3.1%) | 3.16 (3.2%) |
| hunt | 0.008 (0.0%) | 0.009 (0.0%) | 0.010 (0.0%) | 4.28 (4.1%) | 4.10 (4.1%) |
| births | 1.10 (1.4%) | 1.20 (1.5%) | 1.16 (1.3%) | 1.76 (1.7%) | 1.47 (1.5%) |
| wasm brain set and slots | 0.64 (0.8%) | 0.80 (1.0%) | 0.93 (1.0%) | 1.49 (1.4%) | 1.39 (1.4%) |
| settle and deaths | 0.38 (0.5%) | 0.35 (0.4%) | 0.35 (0.4%) | 0.47 (0.4%) | 0.42 (0.4%) |
| wasm brain copy out | 0.36 (0.4%) | 0.36 (0.4%) | 0.39 (0.4%) | 0.46 (0.4%) | 0.46 (0.5%) |
| regrow | 0.05 (0.1%) | 0.06 (0.1%) | 0.24 (0.3%) | 0.07 (0.1%) | 0.09 (0.1%) |
| sense and think, rest | 0.01 (0.0%) | 0.01 (0.0%) | 0.01 (0.0%) | 0.01 (0.0%) | 0.01 (0.0%) |

The Great Hunt has its own `hunt` phase (about 4 percent).

## Per creature growth, Ecosystem, 38000 to 70000

Microseconds per creature per tick (phase ms divided by steady population).

| Phase | 38000 | 50000 | 70000 | 70000 vs 38000 |
|---|---|---|---|---|
| crowd grid | 0.302 | 0.314 | 0.373 | +24% |
| sort batch | 0.329 | 0.343 | 0.404 | +23% |
| wasm senser run | 3.384 | 3.537 | 3.855 | +14% |
| eat | 0.645 | 0.678 | 0.723 | +12% |
| wasm brain forward | 1.549 | 1.516 | 1.530 | flat |
| memory and steer | 1.610 | 1.632 | 1.629 | flat |
| collisions | 0.579 | 0.539 | 0.565 | flat |
| regrow | 0.0058 | 0.0067 | 0.0249 | 4.3 times, area driven |
| total | 8.68 | 8.86 | 9.40 | +8% |

Population 38000 to 70000 is +7%, so phases above +7% are growing faster than population. Three points, one seed, so treat the slopes as indicative.
