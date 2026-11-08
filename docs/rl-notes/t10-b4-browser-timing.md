# T10 B4: Live tier updates in a real browser

Question: does the probe's rule "1 browser second = 1.79 CPU-s of a node thread" (`BROWSER_CPU_PER_SECOND` in `src/rlTiers.ts`) hold for the Live tiers?

## Method

- Page `probes/b4/` imports `live/training.ts` unchanged (same Arena worker, 3 helpers, `pool.json` and `rl/library.json` from the built site), built with `probes/b4/vite.config.mjs`.
- `probes/b4/run.mjs` serves the build on 127.0.0.1, starts headless Chrome 157 (`/usr/bin/google-chrome`, puppeteer-core from a scratch install), calls `phasesFor` + `train` as the add panel does, and counts the worker's `iteration` messages.
- Episodes use the probe's formula (iterations x episodes per iteration + 4 held-out seeds x envs per check). Wall = call of `train` to the last `done`, so worker start-up and the pool load are included.
- Bodies: `p3` (8 rays, 1x16, 1+1 memory) and `p6` (3x32), both fresh (PPO tier recipe), and ES (pretrain + fine-tune, half of the seconds each) for the Grazer founder and for untrained `p3`.
- Probe reference: B1 `ppo-hi` (Light), `ppo-mix` (Medium), `ppo-mix1` (Strong) for PPO, `current` for ES, seeds 1 and 2, same bodies. Raw browser rows: `probes/b4/results.jsonl`. Table: `node b4-table.mjs`.
- 2 runs per cell, one Chrome at a time under the shared heavy lock, `nice -n 19 ionice -c3 chrt --idle 0`.

## Results

Browser iterations are the mean of 2 runs (single runs in brackets).
Load is the 1-minute load average before each run on this 8-thread machine, which other agents kept at 9 to 13 throughout.
`CPU-s/s` is ratio x 1.79, the browser's implied CPU-seconds per second in probe terms.

| tier   | body        | mode | browser iters (runs) | probe iters | ratio | CPU-s/s | browser episodes | probe episodes | wall s | start-up s |
|--------|-------------|------|----------------------|-------------|-------|---------|------------------|----------------|--------|------------|
| Light  | p3          | PPO  | 86.5 (89, 84)        | 111.5       | 0.78  | 1.39    | 1912             | 2488           | 31.0   | 1.0        |
| Light  | p6          | PPO  | 52.5 (51, 54)        | 83.5        | 0.63  | 1.13    | 1160             | 1848           | 31.6   | 1.6        |
| Light  | p3          | ES   | 55.5 (54, 57)        | 69.5        | 0.80  | 1.43    | 7480             | 9312           | 31.4   | 0.7+0.7    |
| Light  | Grazer      | ES   | 61.0 (58, 64)        | n/a         | n/a   | n/a     | 8338             | n/a            | 31.6   | 0.7+0.9    |
| Medium | p3          | PPO  | 121.5 (121, 122)     | 165.0       | 0.74  | 1.32    | 2712             | 3680           | 76.4   | 1.4        |
| Medium | p6          | PPO  | 76.5 (70, 83)        | 104.5       | 0.73  | 1.31    | 1704             | 2328           | 76.3   | 1.3        |
| Medium | p3          | ES   | 163.0 (149, 177)     | 149.0       | 1.09  | 1.96    | 21686            | 19804          | 76.5   | 0.7+0.7    |
| Medium | Grazer      | ES   | 164.0 (153, 175)     | n/a         | n/a   | n/a     | 22196            | n/a            | 76.5   | 0.7+0.8    |
| Strong | p3          | PPO  | 365.0 (339, 391)     | 434.5       | 0.84  | 1.50    | 8160             | 9720           | 201.8  | 1.8        |
| Strong | p6          | PPO  | 208.0 (204, 212)     | 301.5       | 0.69  | 1.24    | 4640             | 6744           | 202.0  | 2.0        |
| Strong | p3          | ES   | 491.5 (476, 507)     | 419.5       | 1.17  | 2.09    | 66360            | 56282          | 201.5  | 0.7+0.8    |
| Strong | Grazer      | ES   | 438.0 (428, 448)     | n/a         | n/a   | n/a     | 59140            | n/a            | 201.4  | 0.5+0.9    |

- The Grazer has no probe row (the probe used the panel bodies), but it tracks `p3` ES.
- ES iterations are the sum of both phases (e.g. Strong p3: 371 + 105 in one run).
- Light hits its 30 s clock exactly, since the clock starts at "ready". Wall = tier seconds + 0.7 to 2 s start-up per phase. The pool load is inside that start-up.
- Run-to-run spread is 5 to 15 % at Medium and Strong (ES Medium p3: 149 vs 177), comparable to the machine load swing, so only differences above about 10 % mean anything.

## Cores

`navigator.hardwareConcurrency` = 8 in headless Chrome 157 here.
The Live run keeps about 4 threads busy (Arena worker + 3 helpers), plus the page.
Load was 9 to 13 on 8 threads and the runs were at idle priority, so these numbers are for a contended machine, not a quiet one.

## Verdict

- PPO gets 63 to 84 % of the probe's updates (mean about 0.73): about 0.78 for `p3` and 0.63 to 0.73 for `p6`, with a larger brain doing worse. This matches the reviewer's 60 to 75 % (serial update step, uneven episodes). The browser's effective rate for PPO is about 1.1 to 1.5 CPU-s/s, not 1.79.
- ES gets 80 to 117 % (Light 0.80, Medium 1.09, Strong 1.17): the 1.79 assumption is right or slightly low at Medium and Strong. Light ES is lower because the 2-phase start-up and the short phases cost a larger share of 30 s.
- Consequence for the tier choice: B1 compared PPO and ES at equal CPU budget. In the browser PPO has about 0.75 of its probe budget and ES about 1.0 to 1.15, so PPO's edge over ES is smaller than B1 measured. If B1's PPO win was close at some tier, re-run that tier with the PPO budget at about 1.3 CPU-s/s (about 0.75 x 1.79) and ES at about 1.9. Each tier's PPO row above is the update count to use: Light about 85 (`p3`) or 52 (`p6`), Medium about 120 or 77, Strong about 365 or 208.
- A slower laptop: updates scale roughly with single-core speed as long as 4 cores are free. With fewer free cores the 3 helpers share them. That is not measured here, only expected to scale about linearly with core count below 4, so a 2-core device would get about half the ES updates and a somewhat larger share of PPO (its serial update is not slowed by fewer cores).
- Not measured: a quiet machine, a visible-tab browser with rendering load (headless page, no canvas), and other browsers.
