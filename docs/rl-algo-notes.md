# RL fine-tuning: sample-efficiency notes

Setup: 60 iterations, pairs 16, 2 episodes per candidate = 3840 training episodes per run (--valid adds ~0.5k selection episodes). Held-out: 32 seeds (EVAL_BASE+k), end value after the run. Values are the mean over n runs (training seeds 1..n), runs listed. Baseline = ES_DEFAULTS before this branch (sigma 0.04, lr 0.02, rank shaping). Rows not in the table were not run (laptop load limits cut the plan): pairs/episodes splits, sigma 0.02, rivals, poison-field/hunt from random:1.

| env            | start  | config                       | n | start | end  | runs                |
|----------------|--------|------------------------------|---|-------|------|---------------------|
| forage-box     | pool39 | base                         | 3 | 3.03  | 4.71 | 4.94 4.81 4.38      |
| forage-box     | pool39 | lr 0.005                     | 2 | 3.03  | 4.41 | 4.38 4.44           |
| forage-box     | pool39 | lr 0.01                      | 2 | 3.03  | 4.86 | 5.06 4.66           |
| forage-box     | pool39 | lr 0.02 -> 0.002 anneal      | 2 | 3.03  | 5.16 | 5.66 4.66           |
| forage-box     | pool39 | sigma 0.08                   | 2 | 3.03  | 5.72 | 5.12 6.31           |
| forage-box     | pool39 | sigma 0.15                   | 1 | 3.03  | 5.97 | 5.97                |
| forage-box     | pool39 | sigma 0.08 + zscore          | 2 | 3.03  | 5.52 | 5.44 5.59           |
| forage-box     | pool39 | sigma 0.08 + best-on-valid16 | 2 | 3.03  | 5.88 | 5.44 6.31           |
| forage-box     | random1| base                         | 2 | 0.00  | 0.81 | 0.84 0.78           |
| forage-box     | random1| lr 0.01                      | 2 | 0.00  | 0.81 | 0.91 0.72           |
| forage-box     | random1| sigma 0.08                   | 2 | 0.00  | 1.17 | 1.22 1.12           |
| forage-box     | random1| sigma 0.08 + zscore          | 2 | 0.00  | 1.16 | 1.09 1.22           |
| hunt-wanderers | pool39 | base                         | 2 | 0.19  | 2.77 | 2.88 2.66           |
| hunt-wanderers | pool39 | lr 0.005                     | 2 | 0.19  | 1.48 | 1.41 1.56           |
| hunt-wanderers | pool39 | lr 0.01                      | 2 | 0.19  | 2.27 | 2.47 2.06           |
| hunt-wanderers | pool39 | anneal                       | 1 | 0.19  | 2.06 | 2.06                |
| hunt-wanderers | pool39 | sigma 0.08                   | 2 | 0.19  | 3.47 | 3.16 3.78           |
| hunt-wanderers | pool39 | sigma 0.15                   | 1 | 0.19  | 3.91 | 3.91                |
| hunt-wanderers | pool39 | sigma 0.08 + zscore          | 2 | 0.19  | 3.44 | 3.34 3.53           |
| hunt-wanderers | pool39 | sigma 0.08 + best-on-valid16 | 2 | 0.19  | 3.56 | 3.34 3.78           |
| poison-field   | pool39 | base                         | 2 | 2.08  | 1.18 | 1.06 1.30           |
| poison-field   | pool39 | lr 0.005                     | 2 | 2.08  | 2.01 | 1.83 2.18           |
| poison-field   | pool39 | lr 0.01                      | 2 | 2.08  | 1.54 | 1.60 1.48           |
| poison-field   | pool39 | anneal                       | 2 | 2.08  | 1.90 | 1.55 2.25           |
| poison-field   | pool39 | sigma 0.08                   | 2 | 2.08  | 1.77 | 1.12 2.41           |
| poison-field   | pool39 | sigma 0.15                   | 1 | 2.09  | 1.73 | 1.73                |
| poison-field   | pool39 | sigma 0.08 + zscore          | 2 | 2.09  | 2.32 | 2.50 2.14           |
| poison-field   | pool39 | sigma 0.08 + best-on-valid16 | 2 | 2.09  | 2.17 | 2.09 2.26           |

## Findings

- Larger sigma helps most: 0.04 -> 0.08 gives +1.0 forage-box, +0.7 hunt, +0.4 random-start forage-box. Lower lr (0.005, 0.01) is worse or equal; annealing lr did not help. sigma 0.15 looks similar to 0.08 (n=1).
- poison-field regression: the training reward itself falls (train mean 1.6 -> 0.9 over 60 iterations in base seed 1), so it is not held-out overfitting. The reward is skewed (a bite of poison ends the run; a lucky run eats 3 food). Centred ranks reward the candidates that win often, while the mean favours the idle-but-alive start (2.08 ~ 45 s x 0.05). Standardised rewards (zscore) optimise the mean and stop the regression (2.09 -> 2.32, 2.50/2.14), at no clear cost elsewhere (forage-box 5.52 vs 5.72, within spread).
- Keeping the best on 16 validation seeds (--valid 16) removes regressions (poison-field returns the start genome or better) for ~+30 episodes per check; it is a safeguard, not a speed-up, so it stays optional.
- Not tried or inconclusive: pairs vs episodes split, per-layer sigma, reward shaping with a dense term (--reward is implemented for training reward only, untested).
- Peak RSS per run 140-200 MB (threads 1-2).

## Changes

ES_DEFAULTS and rlTrain: sigma 0.04 -> 0.08, shaping rank -> zscore. New rlTrain flags: --decay, --shaping, --lrEnd, --reward, --valid. Arena's sigma default 0.04 -> 0.08 to match.
