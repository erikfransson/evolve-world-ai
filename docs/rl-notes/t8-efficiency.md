# T8: held-out gain per CPU second (C4)

Where an RL episode's time goes, what is wasted, and whether adaptive episode counts pay.
Append-only: mark items done, do not rewrite.
Probes in `probes/` (run from `src/typescript`): `t8-profile.ts`, `t8-cpuprof-split.py`, `t8-cpuprof-sum.py`, `t8-adaptive.ts`.
Timings are CPU ms per episode (process.cpuUsage), medians, on a shared laptop under load (load average 5 to 17), so read them to about 10%.

## Results

| item                                    | before                     | after                      | unit                       | command                                                         |
|-----------------------------------------|----------------------------|----------------------------|----------------------------|-----------------------------------------------------------------|
| E8 (at most 10 ms per episode), pool:0  | small envs 3 to 6, Live-like 14 to 26 | n/a             | ms/episode                 | `t8-profile.ts --learner pool:0`                                |
| member scans in JS for 32 or fewer members (SHA below) | rlBench sum 813 | 716 (-12%), fingerprint 799232213 unchanged | ms (sum of 74 env x learner medians) | `rlBench.ts --seeds 6 --reps 3`, A/B 3 times |
| same, per env (pool:39)                 | nibble 6.4, fading 6.7, duel 8.5, live-famine 30.3 | 5.4, 4.8, 7.1, 24.5 | ms/episode (load 17) | same                                               |
| 7158909 on big worlds (Ecosystem tick)  | ecoBench pop 600: 1.39, predators: 3.15 | 1.44, 3.16; fingerprints 739359978, 410981010 unchanged | CPU ms/tick, median of 3 A/B | `ecoBench.ts --seconds 30 --pop 600`, `--predators --seconds 40` |
| adaptive episodes: successive halving on pairs, from pool:0 | fixed 10x5: far-food 0.0247, corridor 0.0490 | sh 0.0116, 0.0400 (50x1: 0.0107, 0.0203) | held-out gain per training CPU s, 4 seeds, 128 fresh seeds | `probes/t8-run-adaptive.sh ENV DIR` |
| early stop once no food is left         | n/a                        | not kept                   | 0 such ticks in 7 envs     | `t8-profile.ts --plain` (food-gone ticks)                       |

## Log

- 2026-10-22. Profile (pool:0 founder, 24 seeds, load average 6). CPU ms per episode, ticks played of the full length, creatures per tick:

  | env         | ms/episode | ticks played | creatures | fixed setup ms | us per tick |
  |-------------|------------|--------------|-----------|----------------|-------------|
  | nibble      | 3.8        | 319 / 450    | 1.0       | 0.5            | 10.6        |
  | far-food    | 3.1        | 261 / 900    | 1.0       | 0.6            | 9.8         |
  | fading      | 4.1        | 336 / 600    | 1.0       | 1.9            | 6.4         |
  | race        | 5.4        | 374 / 450    | 1.9       | 0.8            | 12.4        |
  | duel        | 5.5        | 379 / 750    | 1.9       | 0.2            | 13.8        |
  | live-patch  | 26.3       | 796 / 2700   | 10.4      | 2.0            | 30.5        |
  | live-famine | 14.4       | 1215 / 2700  | 3.3       | 0.9            | 11.1        |

  - Small envs meet E8 (10 ms), the Live-like ones do not (14 to 35 ms, random learners too). Episodes already end when the learner dies, and nearly all do: the founders starve long before the end (far-food at 29% of its length).
  - Split by `node --cpu-prof` (50 us sampling, nearest TypeScript frame, `t8-cpuprof-split.py`), share of runEpisode CPU:

  | env         | sense (rays, items) | brains | motion | crowd grid | member scans | eat, contacts | setup | episode loop |
  |-------------|---------------------|--------|--------|------------|--------------|---------------|-------|--------------|
  | nibble      | 35%                 | 7%     | 9%     | 4%         | 16%          | 10%           | 15%   | 2%           |
  | far-food    | 34%                 | 4%     | 13%    | 4%         | 13%          | 8%            | 21%   | 2%           |
  | fading      | 35%                 | 5%     | 7%     | 5%         | 16%          | 11%           | 14%   | 2%           |
  | race        | 36%                 | 7%     | 6%     | 7%         | 15%          | 13%           | 12%   | 1%           |
  | duel        | 33%                 | 8%     | 11%    | 7%         | 15%          | 12%           | 11%   | 2%           |
  | live-patch  | 40%                 | 16%    | 9%     | 14%        | 6%           | 6%            | 5%    | 3%           |
  | live-famine | 35%                 | 11%    | 9%     | 11%        | 13%          | 10%           | 6%    | 4%           |

  - Setup includes the probe's 64 one-tick episodes, so it reads a little high. Held-out checks and worker messaging do not show: rlTrain checks 16 seeds every 10 iterations (2.5% of the episodes at its defaults, 6.4% for the T2 recipe of 64 seeds), and the pool sends one batch of up to 16 episodes per message.
  - Brains are cheap in small envs (4 to 8%): the per-tick cost is fixed overhead around a one-creature world, not thinking. In Live-like envs about 9 in 10 sensing and brain calls are the rivals', which the engine must run to keep the episode the same.
- 2026-10-22. Wasted work found.
  - Member scans (settle and birth candidates, `membersKernel.ts`): two WebAssembly calls per tick cost 0.33 and 0.55 us for a world of one creature (microbenchmark), 13 to 16% of a small episode. The JS loops they replace (the reference path, kept equal by `wasmMembers.test.ts`) are cheaper below a few dozen members. Fixed, see below.
  - Tail after the last food: an early stop for food-only rewards once no food is left and none regrows gave identical rewards on all 37 envs x 2 learners x 48 seeds, but 0 such ticks in the 7 profiled envs (founders starve first, and a learner that clears the food already ends the episode via `clearable`). Savings were within timing noise except flash (about 20%). Not kept.
  - Setup per episode: 0.2 to 2 ms, of which about a fifth is building the crowd and member WebAssembly instances anew each episode (the sense kernels are already reused). Not changed: about 2 to 3% of an episode.
- 2026-10-22. Speed-up: `Ecosystem.sharedPhase` runs the settle and birth scans in JS for worlds of at most 32 members (SMALL_SCAN, like SMALL_SORT for the crowd grid). All RL envs have 1 to 31 creatures; Live worlds have hundreds and keep the kernel, so the Ecosystem tick there is unchanged. rlBench A/B interleaved 3 times (load average 15 to 17): sum of medians 813 -> 716 ms (-12%), result fingerprint 799232213 in all 6 runs.
  - Commit 7158909. Fingerprint and RL tests pass (vitest: ecosystem, wasmMembers, wasmStep, wasmCrowd, ecoLive, liveSaves, maps, simHygiene, rl*, ecoStateMigration, mutationScale, cli: 21 files, 323 tests).
  - Big worlds keep the kernel path. ecoBench A/B interleaved 3 times (load average 6 to 7), CPU ms per tick: pop 600 1.19, 1.39, 1.43 before and 1.44, 1.44, 1.33 after; predators 3.15, 3.15, 3.01 before and 3.16, 3.30, 2.94 after. Same within noise, fingerprints 739359978 and 410981010 in every run. pop 600 ends at 159 creatures, still above 32.
- 2026-10-22. Adaptive episode counts (`probes/t8-adaptive.ts`, `t8-run-adaptive.sh`). From pool:0, 60 iterations of 100 episodes, sigma 0.08, lr 0.02, seeds 1-4, start and final theta on the same 128 fresh seeds (HELD_BASE + 40000 + k). Schemes: fixed 10 pairs x 5 episodes (the T2 recipe), fixed 50 x 1, and successive halving (sh): 20 pairs play 1 shared episode, the 10 pairs with the largest |r+ - r-| play 3 more shared episodes, and only they move theta (100 episodes per iteration too).

  | env      | scheme   | gain per seed (s1 to s4)  | mean gain | train CPU s | gain per CPU s | minus 10x5 per seed     |
  |----------|----------|---------------------------|-----------|-------------|----------------|-------------------------|
  | far-food | 10 x 5   | +0.58 +0.52 +0.25 +0.29   | 0.410     | 16.6        | 0.0247         |                         |
  | far-food | 50 x 1   | +0.35 +0.01 +0.02 +0.34   | 0.181     | 17.0        | 0.0107         | -0.23 -0.51 -0.23 +0.06 |
  | far-food | sh       | -0.04 +0.44 +0.15 +0.22   | 0.193     | 16.7        | 0.0116         | -0.62 -0.08 -0.10 -0.07 |
  | corridor | 10 x 5   | +0.74 +0.85 +0.93 +0.35   | 0.716     | 14.6        | 0.0490         |                         |
  | corridor | 50 x 1   | +0.16 +0.65 +0.02 +0.41   | 0.311     | 15.3        | 0.0203         | -0.57 -0.20 -0.91 +0.06 |
  | corridor | sh       | +0.39 +0.61 +0.51 +0.77   | 0.570     | 14.3        | 0.0400         | -0.35 -0.24 -0.41 +0.41 |

  - CPU per episode is the same for all schemes (2.4 to 3 ms), so gain per CPU second follows the gain. Successive halving loses to fixed 10 x 5 in 7 of 8 seeds and beats 50 x 1 on corridor only. Picking pairs by one episode's |r+ - r-| picks luck, as T2's candidate share (0.00 to 0.02 at one episode) predicts. Fixed 10 x 5 stays the recommendation; it also repeats T2's split2 result (10 x 5 over 50 x 1 in 7 of 8 seeds here).
  - Not tried: more episodes only for candidates near the top. With zscore shaping every candidate weighs in the gradient, and the top by one episode is luck (T2), so the same failure is expected.
- 2026-10-22. Status: profile done, member-scan speed-up committed (7158909), early stop and adaptive episodes tested and not kept. Left: Live-like envs stay above E8 (14 to 35 ms), mostly the rivals' sensing and brains, which an exact engine must run. Reusing the crowd and member WebAssembly instances across episodes would save about 2 to 3%.
