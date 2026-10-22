# T6: why training plateaus, learner side (C3)

Why a fresh body stalls and founders sit at their ceiling, and which learner changes raise the held-out ceiling at equal CPU.
Append-only: mark items done, do not rewrite.
Probes (run from `src/typescript`): `probes/t6-train.ts` (phases of ES and PPO at a fixed process CPU budget, final genome on fixed test seeds HELD_BASE + 30000 + k with per-seed rewards), `probes/t6-run.sh` (job list under the heavy lock), `probes/t6-diag.ts` (plan, saturation, ES neighbourhood of a trained genome), `probes/t6-agg.py` (group means, gain vs a reference with a Welch 95% CI over training seeds).
Outputs go to `src/typescript/runs/t6/` (git-ignored).

## Results

Gain = difference of group means of the final genome on 64 test seeds, 95% CI by Welch t over training seeds. Budget in process CPU seconds (2 threads), ES default 50 pairs x 1 episode, sigma 0.08, lr 0.02.
References: fading body 1 = ES default, 6 runs (seeds 1-3 plus 3 other start genomes on the same body), mean 3.75; far-food pool:0 = ES 10x5 at 60 s, mean 1.44 (start about 0.5). Seeds = runs in idea vs reference. Paired test-seed CI on every gain is about +-0.3, so the training-seed spread dominates.

| idea | env | start | gain (95% CI) | seeds | budget |
|------|-----|-------|---------------|-------|--------|
| longer rays (body 1 plan, ray length 56 -> 212) | fading | random:1 | +3.09 (+1.90, +4.29) | 3 vs 6 | 150 s |
| 3x budget (450 s) | fading | random:1 | +0.06 (-0.80, +0.92) | 3 vs 6 | 450 vs 150 s |
| PPO 75 s then ES 75 s | fading | random:1 | +0.14 (-0.67, +0.96) | 3 vs 6 | 150 s |
| ES pop 200 (100 pairs) | fading | random:1 | -0.44 (-1.30, +0.42) | 3 vs 6 | 150 s |
| ES 10 pairs x 5 episodes | fading | random:1 | -0.58 (-1.23, +0.07) | 3 vs 6 | 150 s |
| PPO only (everyTick, KL 0.02) | fading | random:1 | -0.62 (-1.04, -0.20) | 3 vs 6 | 150 s |
| sigma anneal 0.08 -> 0.02 | fading | random:1 | -1.03 (-2.30, +0.24) | 3 vs 6 | 150 s |
| ES 75 s then PPO 75 s | fading | random:1 | -1.29 (-1.85, -0.72) | 3 vs 6 | 150 s |
| 3x budget (180 s), ES 10x5 | far-food | pool:0 | +1.34 (+0.34, +2.34) | 3 vs 3 | 180 vs 60 s |
| PPO only (everyTick, KL 0.02) | far-food | pool:0 | +0.58 (-0.35, +1.51) | 3 vs 3 | 60 s |
| ES 50x1 instead of 10x5 | far-food | pool:0 | -0.02 (-1.01, +0.97) | 3 vs 3 | 60 s |
| ES 10x5 30 s then PPO 30 s | far-food | pool:0 | -0.11 (-1.09, +0.88) | 3 vs 3 | 60 s |
| sigma anneal 0.08 -> 0.02 | far-food | pool:0 | -0.38 (-1.14, +0.39) | 3 vs 3 | 60 s |

## Log

- 2026-10-22. Fresh bodies on fading, ES default, 150 CPU s (30k to 46k episodes, 3x the rl-envs.md runs). Final on 64 test seeds: body 1 3.60, 3.09, 3.93 (mean 3.54); body 2 5.55, 5.64, 5.84 (5.68); body 3 6.92, 6.51, 7.24 (6.89). Body 1 with three other random genomes on the same plan (`--init 11..13`): 4.24, 3.97, 3.65 (3.95). Training seeds spread 0.3 to 0.4 within a body, bodies differ by 1.2 to 3.4. So the stall belongs to the body, not to the start genome or the ES seed. Body 1's curve (32 seeds) rises to about 3 by 15k episodes and then wanders 2.2 to 3.4.
- 2026-10-22. `t6-diag.ts` on the final genomes (8 seeds for saturation; neighbourhood: 20 antithetic pairs on 16 common seeds, top 3 candidates re-scored on 64 fresh seeds).
  - Sight: ray length body 1 56, body 2 130, body 3 212 (rays 8, 7, 10; hidden 28, 27, 22). The final score follows ray length (3.5, 5.7, 6.9). In a 400 x 400 box with 8 food, body 1 sees food only at 56 units, so most of an episode it searches blind. A body capacity limit (sensors), not a learner one.
  - Outputs: thrust saturated (|u| > 2 on 83 to 99% of ticks, i.e. full speed, which the env wants), turn mostly not (10 to 25%). Saturation is not what stops these runs.
  - At the plateau theta sits on a peak: the mean candidate scores below theta at every sigma (sigma 0.08: body 1 2.59 vs 2.97, body 2 4.59 vs 5.04, body 3 5.65 vs 6.49). The two half-population gradient estimates have cosine -0.04 to +0.05, inside the random-vector sd (0.022 to 0.025), so the step direction is noise. Candidate share of per-episode variance 0.00 to 0.18 at sigma 0.08. The best 3 of 40 candidates do not beat theta on fresh seeds (body 1 2.96, 2.58, 2.77 vs 2.97; body 3 6.78, 6.53, 6.52 vs 6.49). ES at this point estimates the slope of a Gaussian-blurred score whose top is below theta, from episodes that cannot tell candidates apart.
- 2026-10-22. Learner ideas, fading body 1 (fresh) and far-food pool:0 (founder), 3 training seeds each, equal process CPU (table above; `t6-agg.py runs/t6 fa-es-b1`, `ff-10x5`). PPO runs everyTick with targetKl 0.02 (T1's founder setting).
  - Sensor test: body 1's plan with ray length 212 (same brain, same genome size) reaches 7.15, 7.20, 6.16 against 3.75, the level of body 3. With the 3x budget body 1 stays at 3.80 (4.10, 3.28, 4.04; its curve flat from about 100 s). So body 1's stall is its 56-unit sight, not the learner: it sits at the ceiling of its body.
  - On the stalled body no learner change helps: sigma anneal, pop 200, 10x5, PPO alone, ES then PPO are all at or below the reference, and ES then PPO is clearly worse (-1.29). PPO then ES is level (+0.14, n.s.). Nothing here is worth adopting for fresh bodies.
  - Founder far-food is not at a ceiling: it is budget-limited. ES 10x5 goes 0.5 -> 1.44 at 60 s and 2.78 at 180 s, and the 180 s curves still rise (held32 at 135 -> 180 s: 2.67 -> 2.15, 2.55 -> 2.89, 1.38 -> 2.67). T2's 60-iteration runs (6000 episodes) stopped far too early to show a ceiling. PPO alone beats ES at 60 s in all 3 seeds (2.22, 2.32, 1.52 vs 1.39, 1.85, 1.09; +0.58, CI crosses 0 at n = 3). Sigma anneal and ES-then-PPO do not help.
  - Sigma anneal hurts in both settings (-1.03, -0.38): a smaller sigma at the end shrinks candidate differences further below the episode noise (diag: share 0.00 at sigma 0.02), so the last third of the budget is spent on noise. Dropped.
