# T7: raising the held-out ceiling from the env and creature side (C3)

Which env mixes, curricula, rewards and brain sizes make creatures better on envs they were not trained on.
Append-only: mark items done, do not rewrite.
Probes `probes/t7-run.ts` (one ES run over stages, then a 14-env battery on 64 held-out seeds), `probes/t7-batch.sh` (job list in 2 single-thread lanes), `probes/t7-agg.py` (paired comparison).

## Results

Setup: Explorer body (8 rays, hidden 12+12, memory 1+1, 880 weights) from a random genome per training seed, ES pop 100, 1 episode, sigma 0.08, lr 0.02, 300 iterations unless noted.
Score = reward / Explorer founder's reward on the same 64 held-out seeds, averaged over a group of envs (1.0 = founder level).
mix6 = nibble, far-food, corridor, patch, minefield, fading. unseen = rooms, islands, ring-road, fence, stings, race, duel, sprint (none trained on by any config).
Differences are paired by training seed (same initial genome, same held-out seeds); CI is 95% over training seeds (t, n - 1).

| id  | idea | config vs base | trained group diff | unseen diff | seeds | verdict |
| --- | ---- | -------------- | ------------------ | ----------- | ----- | ------- |
| R1  | env mix | mix6 rotated vs far-food alone, 300 it | +0.11 ± 0.08 | +0.20 ± 0.10 | 8 | keep: raises unseen by a third (0.56 to 0.76); costs far-food itself -0.53 ± 0.36 raw |
| R2  | curriculum | nibble 100 then far-food 200 vs far-food 300 | -0.06 ± 0.08 | -0.08 ± 0.26 | 4 (+3 in T3) | drop: 6 losses, 1 tie on far-food over 7 seeds |
| R3  | time-pressure env | fading 300 vs far-food 300 | -0.03 ± 0.06 | +0.06 ± 0.21 | 4 | drop |
| R4  | early reward | mix6 with early on every env vs mix6 | -0.09 ± 0.09 | -0.09 ± 0.19 | 8 | drop |
| R5  | net energy income | mix6 rewarded by end minus start energy vs mix6 | -0.35 ± 0.54 | -0.34 ± 0.42 | 4 | drop: 2 of 4 seeds learn to stand still (farmable, E2) |
| R6  | brain size | hidden 6 / 32+32 / 12+12 with memory 4+4 vs Explorer 12+12 | +0.06 / +0.05 / +0.05 (± 0.14 to 0.16) | -0.01 / +0.06 / +0.05 (± 0.21 to 0.40) | 4 | drop: no size matters at this budget |
| R7  | longer training | mix6 900 vs 300 iterations | +0.11 ± 0.06 | +0.04 ± 0.10 | 4 | trained envs keep rising, unseen flattens |
| R8  | PBT | 4 members with exploit vs 4 independent, pick on a selection set | -0.01 ± 0.14 | +0.04 ± 0.39 | 4 | drop: selection-set gains do not carry over |

Recommendation: train on a rotated mix of the envs whose skills should transfer (one env per ES step, all candidates on it), not on one env and not on an easy-to-hard ladder; judge on untrained envs. Not tested: self-play or rival libraries (rivals only in race and duel of the battery).

## Log

- 2026-10-22. Founder reference rows (Explorer, Grazer, Juggernaut, Oracle) on the battery: Explorer 3.75 nibble, 2.82 far-food, 3.40 corridor, 8.95 patch, 2.65 minefield, 6.80 fading, 2.90 rooms, 7.28 islands, 1.22 ring-road, 3.84 fence, 6.29 stings, 6.03 race, 4.76 duel, 3.84 sprint. Oracle alone does ring-road (7.49). Grazer fails sprint (0.08).
- 2026-10-22. Batch 1 and 2 (`ff` far-food 300, `mix6` the six envs rotated 300, `lad` nibble 100 then far-food 200, `fad` fading 300, `mixE` mix6 with the early reward on every env, `mixN` mix6 with net energy income as reward; about 80 to 130 s per run on one thread).
  Scores (x Explorer founder), mean over training seeds:

  | config | n | mix6 group | unseen | unseen without sprint |
  | ------ | - | ---------- | ------ | --------------------- |
  | ff     | 8 | 0.72       | 0.56   | 0.60                  |
  | mix6   | 8 | 0.83       | 0.76   | 0.75                  |
  | lad    | 4 | 0.67       | 0.51   | 0.54                  |
  | fad    | 4 | 0.71       | 0.65   | 0.69                  |
  | mixE   | 4 | 0.75       | 0.71   | 0.76                  |
  | mixN   | 4 | 0.42       | 0.39   | 0.41                  |

  - Env mix beats far-food alone at equal episodes: unseen +0.20 ± 0.10 (n 8, 7 wins), mix6 group +0.11 ± 0.08. Per env (raw reward, paired over 8 seeds): rooms +1.09 ± 0.44, islands +1.76 ± 1.12, sprint +2.07 ± 1.34, fence +0.89 ± 1.18; stings, race, duel within ± 0.1. The price is the specialist env: far-food -0.53 ± 0.36. The rotation plays one env per step for all candidates, so the zscore normalises reward scales without per-env weights.
  - Curriculum lost a third time: `lad` - `ff` on the mix6 group -0.06 ± 0.08 (0 of 4 wins), unseen -0.08 ± 0.26, and on far-food itself 2.81 vs 3.19. With round 1 (2 of 3 losses) that is 6 losses, 1 tie in 7 seeds. Dropped.
  - Fading alone (the time-pressure reward) transfers no better than far-food (unseen +0.06 ± 0.21, n 4). Not pursued.
  - Net energy income as reward fails: 2 of 4 seeds collapse to standing still (mixN s4 eats 0.02 to 0.09 per episode; s3 0.5 to 0.9), since moving costs thrust energy and the first bites are rare. It is a farmable reward (E2). Dropped.
  - Early reward on the whole mix: -0.01 ± 0.50 unseen (n 4), one seed at 1.05 (above the founder), one at 0.47. Inconclusive and high variance.
- 2026-10-22. Batch 3, brain capacity at equal budget (mix6, 300 iterations, 8 rays like the Explorer): `capS` hidden 6, no memory; `capW` hidden 32+32, memory 1+1; `capM` hidden 12+12, memory 4+4. Against mix6 (12+12, 1+1), n 4: unseen capS -0.01 ± 0.21, capW +0.06 ± 0.40, capM +0.05 ± 0.32; mix6 group +0.06 ± 0.14, +0.05 ± 0.16, +0.05 ± 0.15. No size wins; a 6-unit brain matches the 880-weight Explorer body, so capacity is not what holds the score below the founder at this budget. The bodies differ in genome length, so their initial genomes are not paired, only the held-out seeds. capW costs about 1.5x the time. Dropped.
- 2026-10-22. Batch 4. `mixE` to 8 seeds: the early reward on the whole mix loses, mix6 group -0.09 ± 0.09 (2 of 8 wins), unseen -0.09 ± 0.19. Dropped (the seed-3 run at 1.05 was luck).
  `mix6L` = mix6 for 900 iterations (same seeds, so its 300 check equals mix6), checks at 300, 600, 900, mean of 4 seeds: mix6 group 0.78, 0.85, 0.89; unseen 0.72, 0.75, 0.76. Paired 900 - 300: mix6 group +0.11 ± 0.06 (4 of 4), unseen +0.04 ± 0.10 (3 of 4). Trained envs keep rising; transfer to unseen envs flattens after about 300 iterations, so past that point the unseen ceiling is set by what the mix covers, not by more iterations.
- 2026-10-22. Batch 5 and 6, population-based training (`probes/t7-pbt.ts`, mix6, 4 members x 300 iterations, so 4x a single run). Every 50 iterations each member plays a selection set (the mix6 envs on 16 seeds disjoint from the reporting seeds); `pbtP` restarts the worst member from the best with sigma and lr each x 0.8 or x 1.25, `pbtI` keeps the 4 members independent (both rebuild Adam every 50 iterations, so they differ only in the exploit step). The member best on the selection set is reported on the battery. pbtP - pbtI, n 4: mix6 group -0.01 ± 0.14 (1 win), unseen +0.04 ± 0.39 (2 wins). PBT's picked member scored higher on the selection set in 3 of 4 seeds (e.g. s2 4.38 vs 3.99) but that did not carry to the reporting seeds: the copy step chases selection-set luck, as T2 found for ES candidates. Dropped. Best-of-4 independent (pbtI, unseen 0.80) vs one mix6 run (0.72, seeds 1 to 4) is not paired (other initial genomes) and costs 4x.
