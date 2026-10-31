# T10 D1: why backprop (PPO) hits a wall

Append-only. Tools: `rlGrad.ts --diag out.csv` (per-update stats, `Ppo.lastDiag`, off by default and bit-identical when off), `--envs a,b|all`, `--from design:pN|founder:ID`, `--logstd-min`, `--poison-penalty`. Summaries: `probes/d1-summary.py`, `probes/d1-panel.py`. Raw CSV and genomes: `src/typescript/runs/d1/` (git-ignored). Battery: M1's `rlTransfer.ts` (rates per real minute, 32 seeds).

## Results

| claim | number | where |
|-------|--------|-------|
| Main cause: the learned policy std collapses to the floor (log-std -3, std 0.05) and the run stops exploring | minefield random:1, lr 5e-4: log-std turn -0.69 -> -3.0 by update ~5000; held-out peaks 1.40 at ~2000 then 1.2; same on stings (3.42 peak, 3.3 end) and all 42 envs mixed (3.03 peak, 2.28 end); panel p1 2.66 -> 1.89, p2 4.86 -> 4.69, p3 4.62 -> 3.73 | minefield-lr5e4, stings-lr5e4, all-lr5e4, panel-base-p1..p3 |
| Clipping is always on from update ~2000 | share of minibatches with pre-clip grad norm > 0.5: 0.42 -> 0.92 -> 1.00; norm 0.54 -> 5.9 (1/std growth), 9.9 on p3 | same |
| Not weight growth or saturation | hidden units with abs pre-activation > 2.5: 0.000 in every run; weight L2 first layer 6.0 -> 8.8, max abs weight < 1.0 | same |
| Not critic failure | explained variance 0.3 -> 0.5 (minefield), 0.56 -> 0.71 (stings) | same |
| KL grows, not tiny | approx KL 0.001 -> 0.015, clip fraction 0.002 -> 0.09 as std shrinks | same |
| Arena trains only 16 of 42 envs when "all" is chosen | episode e plays env e % N with 16 episodes per update, so envs 17+ (truffles, two-stops, ..., live-commons) never train | ppo.ts `tasks()`, envs listing |
| Poison has no reward term | stings/fence/ring/islands (damage 20-30, reward early/food only): a bite costs energy only. minefield/corridor (lethal): a bite ends the episode, costing only future food, through the critic | envs.ts, env.ts reward |
| Fixes tried: poison penalty 1.0 per bite | p1 tiny (small scope) poison/min 5.74 -> 2.49, food/min 6.7 -> 8.7, survival 0.37 -> 0.50; bigger poison 2.21 -> 0.95. p6 big: no gain (small poison 2.69 -> 3.62, bigger 0.99 -> 0.97) | transfer.json, 1 seed, 2 designs |
| Fixes tried: log-std floor -1.5 | p6: poison 2.69 -> 2.32 small, 0.99 -> 2.07 bigger; p1: 5.74 -> 5.22 small, no real change. No consistent effect | same |
| Both together | p1: poison 3.78 small, 1.35 bigger; p6: 2.06 small, 1.67 bigger | same |

## Findings in plain language

- The wall is exploration collapse. Adam moves log-std by about the learning rate every minibatch, in a consistent direction, so std falls to the clamp at -3 within a few thousand updates even at lr 5e-4 (slow lr only delays it). With std 0.05 the policy cannot try anything new, the 1/std gradient inflation keeps clipping on, and held-out then drifts down in noise. The panel shows the same on small and large brains (p1, p2, p3).
- Saturation and weight growth are not the problem here (zero saturated hidden units, max weight < 1). Erik's guess does not hold for fresh designs. Founders are different (T1: 67 to 78 percent saturated outputs).
- Poison is only learned indirectly. Non-lethal poison has no reward cost at all, lethal poison only costs the future food. Observations are fine: each ray reports hit kind as separate food, poison, wall flags plus closeness, at any ray length. The return after a death is zero (no bootstrap), so the signal is not lost to gamma 0.985 per decision, but it is small and delayed, and the critic is only half right (explained variance 0.5 to 0.7).
- A per-bite penalty helped the tiny brain clearly and did nothing for the big brain in one seed each. The log-std floor alone did not help in 300 s runs. These runs were short (300 s, 1250 updates for p6, so p6 had not collapsed yet). Treat them as leads, not as proof.

## Not done

Only designs p6 and p1 were scored on the battery for the fixes (lock contention made each run take about 20 min wall), one seed per cell. Entropy bonus, advantage normalisation per env and an lr schedule were not run. Next: fixed update counts instead of seconds, 3 seeds, all 8 panel designs, and test a std floor of -1 to -1.5 with the penalty at 500 to 5000 updates.

## Log

- 2026-10-31. Instrumented PPO, long runs on random:1 (minefield, stings, all envs) and panel baselines. Re-scored with the corrected battery (363ddf6).
