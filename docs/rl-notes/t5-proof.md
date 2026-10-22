# T5: do creatures learn systematically, beyond lucky candidates? (C2)

Append-only: mark items done, do not rewrite.
Protocol script `src/typescript/src/rlProof.ts`, statistics in `src/sim/rl/proofStats.ts` (test `tests/typescript/proofStats.test.ts`).

## Results

Fresh designs (run k starts from random:k), 3 runs per cell, 64 fixed held-out seeds (`heldSeeds(64)`), 6 checkpoints.
ES 60 iterations, 50 pairs x 1 episode, sigma 0.08, lr 0.02. PPO 200 updates, everyTick, targetKl 0.02, repeat 3, lr 0.003.
Gains are the final weights minus the reference on the same seeds, mean over runs and seeds, bootstrap 95% CI over runs and seeds (2000 draws).
Slope is the least-squares rise of the mean held-out curve over the whole run (start 0, end 1).

| env      | learner | start | final | runs, final            | vs start           | vs best trivial             | vs random designs  | slope              | runs CI > 0 | learns |
|----------|---------|-------|-------|------------------------|--------------------|-----------------------------|--------------------|--------------------|-------------|--------|
| nibble   | ES      | 0.12  | 3.27  | 2.65, 3.63, 3.54       | +3.15 [2.59, 3.55] | circle 0.48: +2.79 [2.22, 3.24] | +3.10 [2.52, 3.50] | +2.85 [2.02, 3.42] | 3/3         | yes    |
| nibble   | PPO     | 0.12  | 2.99  | 2.64, 3.57, 2.75       | +2.87 [2.44, 3.41] | circle 0.48: +2.50 [2.04, 3.06] | +2.81 [2.37, 3.39] | +2.26 [1.64, 3.20] | 3/3         | yes    |
| far-food | ES      | 0.04  | 1.17  | 0.47, 1.37, 1.67       | +1.13 [0.44, 1.76] | straight 0.17: +1.00 [0.30, 1.62] | +1.12 [0.43, 1.73] | +1.04 [0.32, 1.73] | 3/3         | yes    |
| far-food | PPO     | 0.04  | 1.04  | 1.27, 1.64, 0.20       | +1.00 [0.19, 1.66] | straight 0.17: +0.87 [0.06, 1.55] | +0.99 [0.16, 1.67] | +0.92 [0.23, 1.48] | 3/3         | yes, 1 run weak |
| fading   | ES      | 0.13  | 4.23  | 2.52, 4.80, 5.36       | +4.10 [2.51, 5.32] | straight 0.60: +3.63 [1.98, 4.82] | +4.08 [2.43, 5.27] | +4.09 [1.71, 5.62] | 3/3         | yes    |
| fading   | PPO     | 0.13  | 4.52  | 3.31, 5.64, 4.59       | +4.39 [3.31, 5.37] | straight 0.60: +3.91 [2.76, 5.03] | +4.37 [3.23, 5.45] | +4.09 [2.84, 5.16] | 3/3         | yes    |

"learns" = yes when the pooled gain over start, the gain over the best trivial policy and the slope all have CI above 0, and every run's own gain CI (over seeds) is above 0.

## Log

- 2026-10-22. Protocol, and why it rules out luck.
  - The saved weights are the last iteration's theta, never a best candidate or a best checkpoint, so nothing is selected on the held-out seeds (t2: the best candidate is luck).
  - Every policy, baseline and checkpoint plays the same fixed held-out seeds (HELD_BASE + k, never trained on), so all comparisons are paired per seed. 64 seeds track 128 fresh ones (t2, r 0.96).
  - Baselines on those seeds: the pre-training copy (each run's start), the mean of 8 other random designs (random:1000..1007), and three constant policies (still, straight full thrust, circle turn 0.5 thrust 0.6, as `probes/t3-snr.ts`); the best of the three by mean is reported (a conservative choice).
  - Run-to-run spread exceeds held-out noise (t2), so the pooled CI resamples runs as well as seeds (crossed bootstrap, the seed draw shared across runs). With 3 runs the run part is coarse; per-run CIs show whether each run learned on its own.
  - Command, from `src/typescript`: `node src/rlProof.ts --env far-food --learner es --runs 3 --iters 60 --checks 6 --held 64 --out ff-es.json`, and for PPO `--learner ppo --every-tick --target-kl 0.02 --iters 200`. Each cell took 0.6 to 2.9 min on 2 threads (ES) or the main thread (PPO), outside lock waits.
- 2026-10-22. Batch at small budgets (table above). Learning is demonstrated on all three envs with both learners: 18 of 18 runs end above their start with a per-run CI clear of 0, and the mean final scores are 6 to 7 times the best trivial policy's score.
  - Spread between runs is large: far-food ES 0.47 to 1.67, fading ES 2.52 to 5.36. far-food PPO run 3 barely moved (0.02 -> 0.20, about the straight-thrust baseline 0.17), so a single PPO run on far-food can fail at this budget. Claims about a recipe need 3 or more runs.
  - PPO's last iterate is not always its best: nibble runs 1 and 3 fell from 3.18 and 3.60 to 2.64 and 2.75 in the last checkpoint interval. The slope still rises; an averaged or KL-tighter end phase may help (untested).
  - Open: the same protocol from founders (`--from pool:N`), where t1 and t2 saw gains of +0.1 to +0.3, close to the noise; this needs 128 seeds (`--held 128`) and 5 runs.
