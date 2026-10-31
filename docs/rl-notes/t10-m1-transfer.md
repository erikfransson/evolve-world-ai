# T10 M1: transfer battery and design panel (yardstick)

How well does training work for any user-designed creature, judged by competence and Live survival instead of training reward?
Append-only: mark items done, do not rewrite.

## Results

Reference every idea is compared against. 8 panel designs, 64 held-out seeds, battery of 11 envs (scopes below). Cells are min / median / max over the 8 designs.
Untrained = panel at its fixed init seeds. ES and backprop = the Arena default recipe, 5 small envs mixed (nibble, far-food, corridor, patch, minefield), 200 ES steps or 500 backprop updates per design.

| set       | scope  | food per min          | poison bites per min | s to first food      | s to clear all food | survival (share of episode) |
| --------- | ------ | --------------------- | -------------------- | -------------------- | ------------------- | --------------------------- |
| untrained | small  | 0.05 / 0.25 / 1.89    | 0.07 / 0.54 / 2.67   | 21.6 / 26.8 / 27.6   | 28.0 / 28.0 / 28.0  | 0.45 / 0.71 / 0.77          |
| untrained | bigger | 0.04 / 0.26 / 1.39    | 0.00 / 0.37 / 1.69   | 46.9 / 72.5 / 84.3   | (no clear)          | 0.70 / 0.95 / 1.00          |
| untrained | long   | 0.06 / 0.33 / 1.65    | 0.00 / 0.04 / 0.46   | 47.3 / 144.6 / 213.8 | (no clear)          | 0.39 / 0.52 / 0.54          |
| ES        | small  | 7.78 / 16.86 / 19.32  | 1.55 / 4.28 / 5.14   | 5.4 / 8.3 / 14.7     | 21.7 / 24.6 / 27.4  | 0.40 / 0.58 / 0.86          |
| ES        | bigger | 2.55 / 5.35 / 8.06    | 0.41 / 1.06 / 1.71   | 16.5 / 24.0 / 38.9   | (no clear)          | 0.54 / 0.62 / 0.89          |
| ES        | long   | 3.27 / 6.47 / 9.29    | 0.12 / 0.36 / 0.71   | 4.0 / 9.9 / 40.3     | (no clear)          | 0.25 / 0.32 / 0.75          |
| backprop  | small  | 3.86 / 14.21 / 19.33  | 1.86 / 3.01 / 3.64   | 6.2 / 8.2 / 18.5     | 22.3 / 25.0 / 27.7  | 0.46 / 0.64 / 0.70          |
| backprop  | bigger | 1.11 / 4.64 / 9.46    | 0.65 / 1.04 / 2.37   | 13.8 / 25.2 / 56.5   | (no clear)          | 0.53 / 0.65 / 0.83          |
| backprop  | long   | 1.36 / 5.98 / 13.02   | 0.25 / 0.29 / 0.61   | 3.7 / 11.2 / 97.8    | (no clear)          | 0.26 / 0.35 / 0.65          |

Rates use the seconds really played (a cleared episode stops early), clear time is the episode length when the learner does not eat everything, and a cleared episode counts as survived. Clear time only means something on the small scope (bigger and long envs regrow food and never clear, so the column is the constant episode length there).

Reading:
- Training raises food per min in all 8 designs for both methods (paired CI above 0, every scope) and cuts time to first food in all 8.
- Poison bites per min: paired CI above 0 in 7 of 8 designs for ES and 8 of 8 for backprop (all-scope mean over envs); on the bigger scope alone 6 of 8 for both. One ES design (p2-narrow-long) bites less. So "7 to 8 of 8" holds for the all-scope mean, not for every scope.
- Live-like survival goes down: bigger scope, CI below 0 in 7 of 8 (ES) and 8 of 8 (backprop). Untrained creatures barely move and live long on start energy, while trained ones forage and sting themselves. Read survival next to food. Only p2-narrow-long (5 narrow long rays) gains survival under ES (+0.19 bigger).
- Design spread is large: food per min on bigger envs runs 1.1 to 9.5 (backprop), tiny 3-ray p1 stays worst for both methods, 3x32 p6 and 16-ray p5 are strongest.
- Backprop used about 60 to 135 CPU s per design for 500 updates, ES about 250 to 345 CPU s for 200 steps, so the two budgets are not equal. Backprop at about 2500 updates would match ES CPU.

Founders on the same battery (untrained-run file t10-m1-untrained.json), all scope means: Juggernaut food 15.6 per min, poison 2.6, first food 8 s, survival 0.66; Oracle 14.8, 1.6, 8 s, 0.70; Grazer 15.6, 1.2, 7 s, 0.78. Random design random:1 food 0.19, survival 0.82.

## What the CLI measures

`src/rlTransfer.ts` plays each genome on 11 envs x N seeds (default 64) at seeds TRANSFER_BASE + k = HELD_BASE + 50000 + k (1592640336 + k), clear of training seeds and of the standard held-out seeds.
Scope bigger: live-patch, live-famine, live-poison, live-now, live-commons (90 s, rivals from public/pool.json, bumps hurt).
Scope small: minefield, stings, patch, far-food, islands. Scope long: live-now at 240 s (rules as of 2026-10, regrowing food, 20 pool rivals).
Per episode: survival (alive seconds / episode seconds, a cleared episode counts as 1), died (0/1), food and poison bites per minute of play (real elapsed seconds, floored at 5 s), seconds to first bite and to clearing all food (episode length when none), energy lost to poison, end energy. The JSON records short hashes of pool.json and library.json.
Scopes "small" give competence, "bigger" and "long" give Live-like survival. Means over envs weight each env equally.
With `--baseline FILE` each genome is paired with the baseline genome of the same name (else the first, or `--baseline-name`): paired t over seeds of the per-seed mean over envs, per scope, per design, then min, median, max over designs and how many designs have a CI above or below 0. Per-env paired values are in the output JSON (`paired[].diff.byEnv`).
Small-scope envs minefield, patch and far-food are also in the panel training mix, but on different seeds.
Engine change: runEpisode returns poison, poisonEnergy, firstFood and died (a per-creature poison counter in contacts.eatAt). rlBench fingerprint 1301207144 before and after.

## Commands (src/typescript)

Prefix long ones with `flock <repo>/.claude/heavy.lock nice -n 19 ionice -c3 chrt --idle 0`.
- Untrained panel, founders, a random design: `node src/rlTransfer.ts --from panel --from founders --from random:1 --seeds 64 --threads 2 --label untrained --out ../../docs/rl-notes/t10-m1-untrained.json` (111 s wall for 12 genomes, about 9 s per genome; 8 designs 60 s).
- Train the panel: `node src/rlPanelTrain.ts --method es --iters 200 --out ../../docs/rl-notes/t10-m1-panel/es` (21.6 min wall for 8 designs on 2 threads), `--method backprop --iters 500` (9 min).
- Score a trained panel against the reference: `node src/rlTransfer.ts --from panel:../../docs/rl-notes/t10-m1-panel/es --label mine --out mine.json --baseline ../../docs/rl-notes/t10-m1-untrained.json`.
- Use `--baseline ../../docs/rl-notes/t10-m1-panel-es.json` (or `-bp`) to compare an idea against the Arena recipe instead of the untrained start.
- Other genome sources: `learner:PATH` ({plan, genome} JSON), `file:creature.json`, `founder:Grazer`, `pool:N`, `random:SEED`.

## Log

- 2026-10-30. Built the battery, design panel (designPanel.ts, d8f34d1), training script and baselines. Tests: `npm test -- rl arena` 152 pass; tsc clean apart from server/ (ws types missing in the worktree).
- 2026-10-31. Untrained, ES and backprop panel results above. Open: equal-CPU backprop baseline (about 2500 updates), more seeds of training per design (one training seed per design so far), checking that panel gains are not luck (run-to-run spread is large per t5-proof.md).

- 2026-10-31. Review fix: rates now use real elapsed seconds (cleared episodes were counted as full length, which capped food per min), added clear time, scoreLearner's firstFood sum starts at 0, asset hashes in the JSON. Re-scored all three sets (genomes unchanged). ES small-scope median food per min went 12.0 to 16.9. Poison claim rechecked (above). `npm test -- rl arena` exit 0 (153 tests), rlBench fingerprint still 1301207144.
