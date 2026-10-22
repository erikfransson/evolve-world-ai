# T3: what makes an env good for training (C1b)

Reward shaping, signal to noise per env, curriculum, a held-out protocol, and a ranking of the envs.
Append-only: mark items done, do not rewrite.
Probes in `docs/rl-notes/probes/` (run from `src/typescript`, single thread, nice 19, under the heavy lock):
`t3-snr.ts` (fixed policies on held-out seeds, plus an ES pair probe), `t3-train.ts` (short serial ES runs over env stages, for curriculum and shaping), `t3-dump.ts` (built-in env specs as JSON for plan files).

## Results

Fixed policies on the same 32 held-out seeds (`heldSeeds(32)`, `trainer.ts:11`).
weak = mean of 8 random designs (`random:1..8`). trivial = best of standing still, straight full thrust, constant circle (turn 0.5, thrust 0.6). best = best of pool:0..3 and the 4 Live founders (`public/live-founders.json`).
SNR = (best - weak) / per-episode sd of the trained policies.
free = max(trivial, weak) / best, the share of the top score a policy gets for doing nothing useful.
alive = share of the episode the best policy lives (1 also when it cleared the food early).
rz = share of episodes where a random design scores exactly 0.
det64 = smallest gain a paired comparison on 64 held-out seeds detects (5% two-sided, 80% power), as % of the weak-to-best gap, from the paired sd of best vs second best.
rel1 = ES candidate reliability around pool:0 at sigma 0.08 with one shared episode: true candidate variance / (true + candidate x seed variance); 8 antithetic pairs on 16 seeds; "-" means no candidate differed.
Bigger envs (forage-sparse, poison-field, endurance, live-patch) used 16 seeds, 4 random designs, pool:0..1 and 4 pairs on 8 seeds, so their numbers are rougher.
Dash and Hot box are copies of the rl-54-56 specs (`agent-a03180e17cb80c724` worktree, uncommitted `envs.ts`) that need no engine change; Dash food is Dash without the fast bonus.

| env           | weak | trivial | best            | SNR  | free | alive | rz   | det64 | rel1 | ms/ep | verdict |
| ------------- | ---- | ------- | --------------- | ---- | ---- | ----- | ---- | ----- | ---- | ----- | ------- |
| nibble        | 0.21 | 0.47    | explorer 3.76   | 3.8  | 0.12 | 1.00  | 0.82 | 6%    | 0.22 | 3     | keep    |
| wait          | 1.06 | 1.54    | explorer 4.80   | 3.9  | 0.32 | 1.00  | 0.00 | 3%    | 0.20 | 9     | keep, watch free share |
| lean-times    | 0.81 | 1.03    | explorer 13.50  | 3.7  | 0.08 | 0.97  | 0.00 | 7%    | 0.03 | 7     | keep    |
| duel          | 0.27 | 0.38    | explorer 5.09   | 3.2  | 0.07 | 0.94  | 0.78 | 6%    | 0.09 | 7     | keep    |
| dash-food     | 0.36 | 0.62    | juggernaut 4.41 | 4.4  | 0.14 | 1.00  | 0.69 | 8%    | 0.23 | 3     | (probe) |
| dash          | 0.36 | 0.62    | juggernaut 5.05 | 3.9  | 0.12 | 1.00  | 0.69 | 14%   | 0.23 | 3     | (rl-54-56) fix: fast bonus doubles noise |
| hot-box       | 0.35 | 0.69    | juggernaut 5.31 | 2.8  | 0.13 | 0.93  | 0.70 | 16%   | 0.04 | 3     | (rl-54-56) ok |
| ring-road     | 0.33 | 0.50    | oracle 8.53     | 6.6  | 0.06 | 0.86  | 0.00 | 12%   | 0.09 | 4     | keep, body-dependent |
| patch         | 0.23 | 0.44    | explorer 9.37   | 2.3  | 0.05 | 0.88  | 0.93 | 13%   | 0.16 | 3     | keep    |
| far-food      | 0.12 | 0.19    | grazer 3.58     | 2.3  | 0.05 | 0.78  | 0.89 | 17%   | 0.05 | 3     | keep    |
| escape        | 0.75 | 0.90    | grazer 5.78     | 2.2  | 0.16 | 0.80  | 0.00 | 17%   | 0.10 | 8     | keep    |
| minefield     | 0.16 | 0.25    | grazer 3.47     | 2.2  | 0.07 | 0.71  | 0.85 | 18%   | 0.00 | 2     | keep    |
| corridor      | 0.16 | 0.16    | explorer 3.26   | 2.1  | 0.05 | 0.67  | 0.85 | 21%   | 0.06 | 3     | keep    |
| islands       | 0.13 | 0.53    | explorer 7.37   | 2.3  | 0.07 | 0.79  | 0.92 | 25%   | 0.01 | 4     | keep    |
| fence         | 0.24 | 0.44    | explorer 4.25   | 1.9  | 0.10 | 0.70  | 0.79 | 25%   | 0.00 | 3     | keep, recheck cross reward |
| sprint        | 0.14 | 0.06    | oracle 4.49     | 2.7  | 0.03 | 0.91  | 0.94 | 26%   | 0.75 | 5     | keep    |
| melee         | 0.14 | 0.25    | explorer 3.88   | 1.6  | 0.06 | 0.65  | 0.87 | 27%   | 0.07 | 9     | keep (self-play, relative) |
| rooms         | 0.09 | 0.25    | explorer 3.14   | 1.9  | 0.08 | 0.50  | 0.91 | 29%   | 0.06 | 3     | keep    |
| crowd         | 0.68 | 0.69    | oracle 6.03     | 2.2  | 0.11 | 0.88  | 0.00 | 29%   | 0.04 | 26    | keep, slow |
| live-patch    | 3.06 | 2.70    | oracle 25.72    | 2.0  | 0.12 | 0.71  | 0.00 | 30%   | 0.04 | 44    | keep (bigger) |
| flash         | 0.05 | 0.31    | oracle 1.56     | 2.3  | 0.20 | 0.76  | 0.95 | 30%   | 0.15 | 3     | keep (memory) |
| brawl         | 0.52 | 0.53    | grazer 3.20     | 1.4  | 0.17 | 0.59  | 0.00 | 33%   | 0.04 | 7     | fix or merge with melee |
| bottleneck    | 0.38 | 0.48    | juggernaut 3.33 | 1.2  | 0.15 | 0.26  | 0.00 | 43%   | 0.02 | 7     | fix |
| forage-sparse | 0.02 | 0.06    | pool:1 0.81     | 1.1  | 0.08 | 0.27  | 0.98 | 27%   | -    | 5     | fix or drop: nobody survives |
| poison-field  | 1.00 | 1.25    | grazer 2.96     | 1.0  | 0.42 | 0.32  | 0.00 | 50%   | -    | 4     | fix: standing still pays |
| aggressor     | 1.21 | 1.36    | juggernaut 1.94 | 1.1  | 0.70 | 1.00  | 0.00 | 52%   | 0.07 | 14    | fix: reward is 70% free |
| toll-road     | 0.08 | 0.19    | juggernaut 1.12 | 1.2  | 0.17 | 0.16  | 0.92 | 70%   | 0.05 | 3     | drop or redesign |
| glimpse       | 0.05 | 0.41    | pool:0 1.56     | 1.1  | 0.26 | 0.46  | 0.98 | 93%   | 0.07 | 3     | drop (unmeasurable) |
| truffles      | 0.05 | 0.41    | pool:0 1.44     | 1.0  | 0.28 | 0.39  | 0.98 | 102%  | 0.07 | 3     | drop (unmeasurable) |
| endurance     | 1.96 | 2.49    | explorer 1.69   | -0.5 | 1.48 | 0.14  | 0.00 | inf   | 0.09 | 4     | drop: standing still beats every founder |

Commands (from `src/typescript`):
`node ../../docs/rl-notes/probes/t3-snr.ts --envs nibble,corridor,... --seeds 32 --pairs 8 --pseeds 16 --out small.json` (small envs, about 3 min in total);
`--envs live-patch,forage-sparse,poison-field,endurance --seeds 16 --pairs 4 --pseeds 8 --randoms 4 --pools 2` (bigger);
`--file tp.json` (the Dash, Hot box and Dash food specs, plain EnvSpec JSON).

### Criteria for a good env (checkable with `t3-snr.ts`)

| id  | criterion | threshold | fails today |
| --- | --------- | --------- | ----------- |
| E1  | Headroom: a trained creature beats random designs clearly | SNR >= 1.5 | glimpse, truffles, toll-road, aggressor, bottleneck, poison-field, forage-sparse, brawl (1.4), endurance |
| E2  | No free reward: doing nothing useful earns little | free <= 0.3 | endurance 1.48, aggressor 0.70, poison-field 0.42, wait 0.32 (borderline) |
| E3  | The task is survivable in its horizon: a good policy lives most of the episode | alive >= 0.6 for the best founder | endurance 0.14, toll-road 0.16, bottleneck 0.26, forage-sparse 0.27, poison-field 0.32, truffles 0.39, glimpse 0.46, rooms 0.50, brawl 0.59 |
| E4  | Measurable: 64 paired held-out seeds resolve a gain of a quarter of the gap | det64 <= 25% | see table; glimpse 93%, truffles 102%, toll-road 70% |
| E5  | A first reward is reachable from scratch: random designs score in some episodes, or a dense term guides them | rz <= 0.9, or start from a founder | glimpse, truffles, forage-sparse 0.98, flash 0.95, sprint 0.94, patch 0.93, rooms, islands, toll-road (all fine from a founder) |
| E6  | Every reward term moves with behaviour: no saturated terms | energy weight only where learner start energy <= 2 x species startEnergy (50), since `energySignal` = 1 - exp(-E/50) (`sensors.ts:141`) is 0.98 at E = 200 | aggressor (200, weight 1); the lab aggression envs `envs-k50.json` (200 to 300, weight 0.3 to 0.6, a small flat alive bonus) |
| E7  | Time pressure pays per bite, not only for clearing everything | prefer `early` (rl-54-56) over `fast`, or check that good policies clear the food in >= 30% of episodes | dash: fast bonus raises det64 from 8% to 14% and leaves the ES signal unchanged |
| E8  | Cheap | <= 10 ms per episode for a small env (population 100 x 1 episode per step) | crowd 26, live-patch 44 (fine as "bigger") |

### Held-out protocol

- Paired, fixed seeds for every compared creature (the code already does this, `trainer.ts:11`). Report the mean paired difference with 1.96 x sd_d / sqrt(n).
- n = (2.8 sd_d / delta)^2 for 80% power. Measured sd_d between two trained creatures is 0.6 to 5 reward units per episode (table); with n = 64 a gain of 3% to 30% of the weak-to-best gap is detectable on the envs worth keeping. 32 seeds (the docs' default) resolves only 8% to 42%; the Arena's 4 seeds per env resolves nothing below the full gap.
- Use 64 seeds per env for an end-of-run claim, 128 for claims under 15% of the gap. Pairing helps most where the same seed is hard for both creatures (nibble: unpaired needs 109 seeds, paired 21; duel 157 vs 28; wait 104 vs 5) and not at all where the best and second-best creature fail on different seeds (islands, glimpse).
- Keep two disjoint held-out sets: one to pick a checkpoint or a candidate, one to report. A pick on the reporting set is biased upward (T2: theta on two 32-seed sets differs by up to 0.64).
- Training-seed spread is larger than held-out noise: the same plan from three random designs ended at far-food 0.82, 2.19, 2.21 (log below). Compare configs over >= 3 training seeds (5 for a claim), and report the spread.

## Log

- 2026-10-21. Code read. Reward is a fixed linear sum of food, kills, seconds alive, energy signal at the end, the clear-all bonus, rams and walls crossed (`env.ts:381`). The fast bonus is seconds left when the learner itself ate every starting item, only without regrowth (`env.ts:353`, `:373`), so it is zero in any episode where one item is missed. The end-energy term goes through `energySignal(E, startEnergy)` = 1 - exp(-E/startEnergy) (`sensors.ts:141`) with the species startEnergy 50 (`ecoConfig.ts:60`), so above about 150 energy it is a flat alive bonus. Held-out seeds are HELD_BASE + k (`trainer.ts:10-11`), fixed and the same for all compared genomes; training seeds are fresh each step (`trainer.ts:104`).
- 2026-10-21. Fixed-policy probe on the 23 small envs (results table). Every small env separates weak from good by 1 to 6.6 per-episode sd, so weak vs good is never the problem; the problem is resolving the small gains that training produces. The Live founders beat the pool founders everywhere except Glimpse, Truffles (pool:0 best) and forage-sparse (pool:1 best), often by 2 to 5x (live-patch: pool 4.3 and 6.9, founders 20 to 26).
- 2026-10-21. ES pair probe agrees with T2 (`t2-es.md`): with one shared episode per candidate, 0 to 25% of the spread between candidates around pool:0 is real (rel1), on every env but Sprint (0.75). So the "best" of issue #54 is mostly luck on every env, not on a few bad ones. Sprint is the exception because its reward is nearly a function of the policy: full thrust down the strip reaches the food or does not.
- 2026-10-21. Envs that fail on design, not noise (mechanisms named, each falsifiable by the fix in brackets):
  - Endurance: every founder dies within 10% to 21% of the 120 s (alive 0.07 to 0.14), and standing still lives longest (0.21), so the reward (0.1 per second alive, `envs.ts:238`) ranks still 2.49 above every trained creature (best 1.69). The world is 1400 x 1400 with 20 food at the default 50 energy, which is starvation for anyone who moves. [Give start energy 150 to 300 or food 60; a fixed env should have the founders well above still.]
  - Aggressor: still scores 1.36 of the Juggernaut's 1.94 (free 0.70). The reward is ram 1 + energy 1 (`envs.ts:119`) at learner energy 200, where energySignal is 0.98 for any survivor; rams are rare, so the reward is mostly "stay alive". [Drop the energy term or start at 50 to 100 energy.]
  - Poison field (also l-poison-field in lean-A.json): still 1.25 beats every random design and pool founder; reward survive 0.05 x 45 s pays 2.25 for not moving against 1 per food, and one bite of lethal poison ends the run. [Cut survive to 0.01 or make poison sting.]
  - Forage-sparse: the best eats 0.8 of 14 food in 60 s and lives 27% of it. Too sparse and too hungry for any current body. [More food or more energy.]
  - Toll road: the best founder lives 16% of the episode (30 energy, 8 per sting) and eats 1.1. [Needs a redesign; it hardly separates founders from random designs.]
  - Glimpse and Truffles: the same layout (patch radius 60, 12 food), and for weak policies identical to the last digit (ES probe values equal), because food is only visible for the first 1.5 s or never. Best 1.56 and 1.44 with sd 1.4, and the two pool founders disagree on which seeds are easy (r = -0.26), so 64 seeds resolve no gain under the full gap. They tested memory (`docs/rl-envs.md` line 28) but are poor training envs. [Keep only Flash as the memory env, or make Glimpse food visible longer.]
- 2026-10-21. Time pressure (#56). The clear-all bonus is the noisiest reward term measured: on Dash (rl-54-56 spec, food 1 + fast 0.5) the paired sd between Juggernaut and Explorer is 1.86, without the bonus 0.90, so the seeds needed for the same detectable gain go from 39 to 124. ES candidates around pool:0 never cleared Dash, so the bonus added nothing to their signal (rel1 0.23 with and without). A per-bite time weight (the branch's `early` reward) rewards speed on every bite and should keep the noise of the food term; check Fading and Race with `t3-snr.ts` once the branch builds.
- 2026-10-21. Shaping and curriculum runs (`t3-train.ts`, population 100, 1 episode, 120 iterations in total per run, eval on 64 held-out seeds, from random:1..3 which are three different bodies; same random start per seed for each pair of plans, so the per-seed comparison is paired):

  | question | plan A | plan B | food A (s1, s2, s3) | food B (s1, s2, s3) | paired reward diff B - A, 95% |
  | -------- | ------ | ------ | ------------------- | ------------------- | ----------------------------- |
  | curriculum on far-food | far-food 120 | nibble 60, far-food 60 | 0.75, 1.75, 1.64 | 0.69, 1.30, 1.34 | -0.07 ± 0.36, -0.80 ± 0.52, -0.65 ± 0.43 |
  | fast bonus on far-food | food 1 + fast 0.1 | food 1 | 0.75, 1.75, 1.64 | 0.41, 1.64, 1.45 | -0.38 ± 0.33, -0.02 ± 0.38, -0.42 ± 0.52 |
  | cross reward on fence | food, fast, cross 1 | food, fast | 0.66, 2.00, 0.25 | 1.03, 2.39, 3.06 | +0.25 ± 0.35, +0.34 ± 0.51, +2.96 ± 0.62 |
  | stinging first on minefield | lethal 120 | sting 25 for 60, lethal 60 | 0.39, 1.14, 0.73 | 0.41, 0.92, 1.33 | +0.02 ± 0.20, -0.23 ± 0.30, +0.62 ± 0.33 |

  - Curriculum: at equal budget the Nibble-first ladder lost on far-food in 2 of 3 seeds and tied the third. The easy stage teaches "find close food", which far-food already teaches from its first iterations, and costs half the far-food budget. Unverified whether a ladder helps when the hard env gives no first reward at all (far-food random designs score in 11% of episodes, so it was not that case).
  - Fast bonus: on far-food it did not hurt food eaten and helped in 2 of 3 seeds (food 1.38 vs 1.17 mean). Likely because runs that eat 1.5 to 2 of 3 items sometimes clear all 3, so the bonus carries signal (unverified: clear rate of the trained runs not logged). This does not contradict the Dash noise result: the bonus helps where clearing is common in training, adds noise where it is rare.
  - Cross reward on Fence: training without the +1 per wall crossed ate more food in 3 of 3 seeds (0.97 vs 2.16 mean; seed 3: 0.25 vs 3.06). With the cross reward a candidate earns the same +1 for poking past the wall line as for a bite, so ES settles on crossing. This contradicts the earlier record (`docs/rl-envs.md` line 55: 1.84 with cross vs 1.47 without, 200 iterations, one run); with 3 seeds and spread this large, neither is settled. Proposed: 5 seeds x 200 iterations, both plans (about 25 min).
  - Stinging first on Minefield: inconclusive (one win, one loss, one tie).
  - Training-seed spread (0.25 to 3.06 food for the same plan) is larger than any effect above. Every config comparison needs several training seeds.
- 2026-10-21. Lab envs (read-only from `agg/src/typescript/runs/agg/`, world and role filled in as forager, rivals from `founders-lib.json`). lean-A.json is the built-in nibble, far-food, patch, minefield, poison-field with lethal-ish poison 50; its numbers match the built-ins (l-nibble = nibble to the digit, l-poison-field still 1.25 vs best 3.13, free 0.40, same fault as poison-field). The four aggression families of `envs-k50.json` (agg-00, -08, -16, -24; 16 seeds) and two inland envs (`inland-t.json`) measured with the Live founders and pool:0..1 as references:

  | env       | weak | trivial         | best            | SNR  | det64 | ms/ep | note |
  | --------- | ---- | --------------- | --------------- | ---- | ----- | ----- | ---- |
  | agg-00    | 1.43 | straight 1.37   | juggernaut 7.42 | 2.4  | 27%   | 17    | Wounded herd |
  | agg-08    | 1.29 | straight 1.38   | oracle 7.45     | 2.4  | 19%   | 13    |      |
  | agg-16    | 1.32 | straight 1.39   | juggernaut 9.57 | 3.1  | 21%   | 14    |      |
  | agg-24    | 1.68 | circle 1.72     | explorer 9.76   | 3.0  | 17%   | 18    |      |
  | inland-00 | 0.63 | still 0.73      | explorer 1.75   | 0.9  | 67%   | 16    | 24 food, 13 rivals in 1300 x 1300: too little food |
  | inland-01 | 0.78 | straight 1.14   | grazer 10.04    | 1.4  | 31%   | 24    | 63 food in 900 x 900; Grazer 10.0 vs Explorer 6.1 |

  The inland family (24 random draws) spans unmeasurable to fair; a family drawn at random should be screened with `t3-snr.ts` and the members failing E1 or E3 dropped before training, since their noise enters the summed reward at full weight (T2: the multi-env score is a plain mean, `trainer.ts:164`).
- 2026-10-21. Duels (`duel2.json`, scripted charger). No founder was trained on duels, so the reference is weak here, but the trivial policies tie or beat every founder: hit straight 2.77 vs Juggernaut 2.70, dodge still 0.77 vs 0.63, mixed still 1.84 vs 1.76, side still 0.77 vs 0.62. SNR 0.06 to 1.2. The reward (ram 2, survive 0.15 x 5 to 8 s, energy 1 at 26 to 300 learner energy) is dominated by the survive and saturated energy terms; a ram is worth 2 but happens rarely. Before keeping them as training envs, score the lab's jaug and jduel creatures with `t3-snr.ts` (add them as policies) and check that they beat the scripted ones by >= 1.5 sd. Not done here.
- 2026-10-21. Ranking (by E1 to E4, then E8). Best to train on: nibble, lean-times, wait, duel, ring-road (body-dependent: only Oracle 8.5, Explorer 1.3), patch, far-food, escape, minefield, corridor, sprint. Fair: islands, fence, rooms, melee, crowd (slow), flash, live-patch (slow), the k50 aggression families. Fix: aggressor (free 0.70), poison-field and l-poison-field (still pays), brawl (alive 0.59, det64 33%), bottleneck (alive 0.26), inland members with little food. Drop or redesign: endurance, forage-sparse, toll-road, glimpse, truffles (Flash stays the memory env), and the duel envs until a trained duelist beats the scripted ones.
- 2026-10-21. Limits of these numbers. det64 uses the best and second-best creature, which differ a lot on some envs (glimpse, ring-road), so it is an upper bound for before-and-after comparisons of one training run, where the two creatures are close. The reference creatures were not trained on most envs, so "best" is a floor on what an env allows. Bigger and lab rows rest on 16 seeds.
- Open, proposed runs (each under 25 min at 2 threads): (a) Fence cross vs no cross, 5 seeds x 200 iterations; (b) the fixed Endurance, Aggressor and Poison field (changes named above) through `t3-snr.ts`, accept when E1 to E3 pass; (c) Fading and Race from rl-54-56 through `t3-snr.ts` once that branch builds, and Dash with `early` instead of `fast`; (d) curriculum where the hard env has no first reward from scratch (rz >= 0.95: flash, sprint), ladder vs direct at equal budget, 5 seeds.
