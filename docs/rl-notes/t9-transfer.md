# T9: round-2 recipe on the Live founders, Live screen and balance (C5)

Do founders retrained with the round-2 recipe do better in a Live-like world, and do the species coexist?
Append-only: mark items done, do not rewrite.
Files live in the lab worktree, agg `src/typescript/runs/agg/`: `t9q.sh` (training queue), `t9-battery.ts` (held-out battery, every episode kept), `t9-ana.py` (paired gain, screen balance), `t9-*.json` env sets and results, `t9s-*.log` screens.

## Results

Shipped = origin/main founders. Retrained = round-2 recipe, 20 min each, picked by paired held-out (Explorer s2, Grazer s1, Oracle s2, Juggernaut s2).
Held-out gain = 64 paired seeds on envs not trained on, in units of each env's mean (95% CI). Screen = founderEval, scale 1, 10 copies each, 120 min; E/J/O/G sizes, species alive, Pielou J.

| founder    | held-out gain (pick) | other seed     |
| ---------- | -------------------- | -------------- |
| Explorer   | +0.02 +- 0.08        | -0.11 +- 0.08  |
| Grazer     | +0.17 +- 0.07        | +0.06 +- 0.10  |
| Oracle     | -0.19 +- 0.07        | -0.38 +- 0.07  |
| Juggernaut | -0.08 +- 0.09        | -0.12 +- 0.08  |

| set       | bonus | seed | +60 E/J/O/G       | alive, J | +120 E/J/O/G       | alive, J | Explorer, Oracle gone by |
| --------- | ----- | ---- | ----------------- | -------- | ------------------ | -------- | ------------------------ |
| shipped   | 5     | 1    | 0/358/0/930       | 2, 0.43  | 0/359/0/944        | 2, 0.42  | +30, +60                 |
| shipped   | 5     | 2    | 139/550/0/588     | 3, 0.69  | 0/889/0/351        | 2, 0.43  | +105, +45                |
| shipped   | 10    | 1    | 0/664/0/584       | 2, 0.50  | 0/855/0/399        | 2, 0.45  | +30, +60                 |
| shipped   | 10    | 2    | 85/130/137/920    | 4, 0.64  | 13/153/44/1096     | 4, 0.40  | alive, alive             |
| retrained | 5     | 1    | 0/305/0/989       | 2, 0.39  | 0/333/0/954        | 2, 0.41  | +30, +15                 |
| retrained | 5     | 2    | 0/549/0/736       | 2, 0.49  | 0/385/0/871        | 2, 0.44  | +45, +30                 |
| retrained | 10    | 1    | 0/583/0/669       | 2, 0.50  | 0/441/0/834        | 2, 0.47  | +30, +30                 |
| retrained | 10    | 2    | 90/441/0/732      | 3, 0.63  | 0/276/0/996        | 2, 0.38  | +120, +30                |

Verdict: no. The recipe at 20 min does not raise held-out for founders already near their ceiling (only the Grazer gains, via sprint), and in Live the retrained Explorer and Oracle die as fast or faster (Oracle by +15 to +30 instead of +45 to +60). Grazer and Juggernaut coexist in every run, retrained or not; no run takes over by +120. Balance at +120 is 2 species and J 0.38 to 0.47 for both sets; only shipped at bonus 10 seed 2 kept all four.

## Log

- 2026-10-22. Setup. Start genomes are the shipped set (origin/main `public/live-founders.json`): Explorer, Juggernaut, Oracle from the founders file, Grazer = grazer-vj.
  Recipe: ES 10 pairs x 5 episodes, sigma 0.08, lr 0.02, one env per step drawn from the mix (`--sample 1 --rotate 1`), 20 min wall on 2 threads, final genome kept, 2 training seeds per founder, rivals from `lib-t.json` (the current founders).
  Forager mix (Explorer, Grazer, Oracle): nibble, far-food, corridor, patch, minefield plus Live-like inland-00 to 05 (kill bonus 5).
  Juggernaut mix: agg-00 to 09 and duel-hit, duel-chase from `lean-aggr.json` (bonus 5) plus inland-00 to 05.
  Held-out battery, 64 paired seeds, envs not in the T9 mix. Foragers: rooms, islands, ring-road, fence, sprint, duel, inland-20 to 23. Juggernaut: held-00 to 07 (`envs-held.json` at bonus 5), inland-20 to 23.
  Gain = mean over envs of reward / start genome's mean on that env, paired per seed. Caveat: grazer-vj was trained on inland-00 to 23, so its inland held-out envs are not unseen to it.
  Balance: species alive at each check and Pielou evenness J = Shannon entropy of the four species' shares / ln 4.
- 2026-10-22. Shipped set at bonus 5 reuses r5 (same founderEval flags, seeds 1 and 2, engine unchanged since). Explorer/Juggernaut/Oracle/Grazer: seed 1 +60 0/358/0/930 (alive 2, J 0.43), +120 0/359/0/944 (2, 0.42); seed 2 +60 139/550/0/588 (3, 0.69), +120 0/889/0/351 (2, 0.43).
- 2026-10-22. 0.2.4 is live and the real Live world was reset with 200 copies each of Explorer, Juggernaut, Oracle and Grazer (grazer-vj) plus 50 Ancient Grazer copies, at kill bonus 5. The shipped-set screen at bonus 5 here is its lab counterpart, so the real world can be compared later (not accessed from this track).
- 2026-10-22. Training done (20 min each, 1100 to 1550 iterations, about 20x T2's 60). Held-out battery, 64 paired seeds, gain in units of each env's mean over start, s1 and s2 (a common reference, since grazer-vj scores 0.08 on sprint and a start-only ratio blows up), 95% CI:

  | founder    | s1             | s2             | pick |
  | ---------- | -------------- | -------------- | ---- |
  | Explorer   | -0.11 +- 0.08  | +0.02 +- 0.08  | s2   |
  | Grazer     | +0.17 +- 0.07  | +0.06 +- 0.10  | s1   |
  | Oracle     | -0.38 +- 0.07  | -0.19 +- 0.07  | s2   |
  | Juggernaut | -0.12 +- 0.08  | -0.08 +- 0.09  | s2   |

  Only the Grazer gains, and that is sprint (0.08 to 4.10) plus fence and ring-road, while its inland held-out envs fall (inland-22 16.3 to 9.2). Oracle loses its ring-road specialty (7.49 to 0.56 and 2.73). Explorer is level, Juggernaut slightly worse on held-00 to 07. Inland held-out envs fall for most picks. So on these founders, which start near their ceiling, 20 min of the mix trades specialties for breadth and does not raise held-out on unseen envs.
  The internal check (far-food, 16 seeds) fell in 6 of 8 runs, as T7's mix cost on far-food predicts.
- 2026-10-22. Screens (`t9s.sh`, 120 min, 2 seeds each; shipped at bonus 5 = r5): table above. Shipped bonus 10 seed 1 matches shipped bonus 5 seed 1 in extinction times; seed 2 at bonus 10 is the only run with four species at +120 (Explorer 13, Oracle 44). Retrained Grazer and Juggernaut behave like the shipped ones (Grazer 834 to 996 at +120, Juggernaut 276 to 441). The Juggernaut did not take over in any of the 6 new runs (at bonus 5 shipped seed 2 it leads 889/351 at +120 and took over by +180 in r5).
  Reading: Live survival of Explorer and Oracle is not limited by what the battery measures; on the shared forager battery their raw scores are close to the Grazer's (e.g. rooms 2.90 and 3.02 vs 2.33), yet they lose the scramble for food. Next would be training inside Live-like worlds with the actual rivals at full length (inland envs among Grazer and Juggernaut), judged by the Live screen, not by the battery.
