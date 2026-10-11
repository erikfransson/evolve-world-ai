# Helper message passing (round 2)

| Idea                                   | Before                              | After                          | Speedup            | Exact? | Peak RSS change                       | Lines added | Verdict                        |
|----------------------------------------|-------------------------------------|--------------------------------|--------------------|--------|---------------------------------------|-------------|--------------------------------|
| Genomes only to the owning helper      | first packet 102 MB published x4    | 6.6 MB; tick 0 5.9 s to 5.0 s  | tick 0 only        | yes    | 50k, pop 10000, 4 helpers: 1.37 to 1.0 GB at tick 0 | about 25    | Merge                          |
| First tick gets the start timeout      | pool lost at tick 0 (5 s) under load | survives                      | robustness         | yes    | none                                  | 3           | Merge                          |
| Owner cached on EcoCreature            | publish 2.1 ms                      | 1.75 ms (median of 4 pairs)    | about 2% of coordinator CPU | yes | none                          | 3           | Optional                       |
| Transfer (ping-pong) buffers           | already done                        | n/a                            | n/a                | yes    | none                                  | 0           | Nothing to gain                |
| Spatial split / send less per helper   | helper apply+crowd+load 1.4 of 7.6 ms | at most 0.7 ms saved         | under 5%           | yes    | n/a                                   | large       | Not worth it                   |
| Overlap serial phase with next sense   | n/a                                 | next sense depends on shared phase | not exact      | no     | n/a                                   | n/a         | Rejected                       |

Machine load was 25-40 on 8 cores throughout, so wall times are meaningless. Numbers below are thread CPU ms per tick (process.threadCpuUsage).

## Per-tick cost, width 20000 (2742 creatures), 3 helpers, coordinator thread CPU
publish 2.0, copy 0.6, post 0.6, own sense+advance 7.2, wait/receive 0.7, collect 1.3, shared phase 2.8: total 13.4 (serial run 24.6).
Helper: apply 0.5, crowd 0.15, load 0.75, sense 4.6, post-sense 1.3: 7.4.
Packet 1.35 MB, published part 0.72 MB (copied once per helper, 0.2 ms each). Transfer post costs 0.2 ms per helper. Round trip under load 4-6 ms each way, unloaded unknown.
So messaging overhead is about 5.5 of 13.4 ms on the coordinator (publish, copy, post, receive, collect), the shared phase 2.8 is inherent. Helpers are idle about 40% of the tick (during the coordinator's serial phases). That serial phase cannot overlap the next sense exactly.

## Scaling, coordinator CPU per tick (ms, critical path if helpers keep up)
| Helpers | 20000 (2742) | 30000 (6171) |
|---------|--------------|--------------|
| 0       | 24.6         | 61.9         |
| 1       | 18.7         | 41.5         |
| 2       | 15.9         | 35.6         |
| 3       | 13.4         | 36.2         |
| 4       | 14.0         | 29.1         |
Noisy. Gain from 3 to 4 helpers is about 5% at 20000 and 7-20% at 30000; keep defaultHelpers at 4 for big worlds, no change.
RSS (MB): 20000: 250, 381, 422, 507, 552 (about 75 per helper). 30000: 411, 692, 802, 887, 1034 (about 150 per helper). Helper count is capped at 2 for further runs by the owner.
Fingerprints are equal for every helper count (20000: 105589597, 30000: 698110544); after the change `--pop 600 --seconds 30` gives 494818766 for 0 and 2 helpers; ecoPool tests pass.
