# dt 1/20 switch, ready as a branch (dtswitch, idea 80)

Branch `pl-dtswitch`. Makes the decision of `dt20.md` a one-merge change. Erik decides whether to merge it.

## What changes

- `server/src/config.ts`: `LIVE_DT = 1 / 20`, `liveConfig.dt = LIVE_DT`. `thinkEvery`, the memory rates and every other default stay.
- Save guard: a save already stores `config.dt` as a plain number (the whole config is saved), so no format change and the released server reads these saves. `otherWorldReason` (`saveParse.ts`) now compares it with the running dt, exactly (a save without dt counts as the engine default 1/30). A mismatch is an `OtherWorld` refusal like another map size: startup logs `cannot restore <name>: it was saved at 0.0333... s per tick, this server runs 0.05 s per tick; the save is kept` and, when no save of the right dt exists, starts a fresh world. An admin load of such a save fails with the same text and keeps the running world. The old saves stay on disk (rotation deletes them after 4 days as usual, as the newest six are kept regardless).
- `MAX_RECORDED_FRAMES` is not changed: it belongs to the trajectory recorder of the training evaluator (`sim/evaluator.ts`), which runs at `DEFAULT_CONFIG.dt` (1/30). The live server and `liveConfig` never record trajectories, so the 450 s concern in `dt20.md` does not apply.
- Tests: `liveSaves` gets a test that a save carries a plain-number dt, loads at the running dt, and is refused at another (direct restore, startup with an older good save behind it, startup with only the old save, admin load); it fails red with the guard removed. `liveV2` "100 viewers following" counted ticks (60 warm-up, 24 per frame) and the world thinned out at 1/20; its counts are now scaled to the same simulated time at any dt.

## Fingerprints (`liveBench --seconds 60 --copies 800`, taskset 2,3,6,7 idle priority)

| Case                         | dt                    | Fingerprint | cpuMsPerTick |
|------------------------------|-----------------------|-------------|--------------|
| mixed, 4 founders x 800      | branch default 1/20   | 606739999   | 8.99         |
| mixed                        | `--dt 0.03333333333333333` (1/30) | 708687555 (old pin holds) | 9.00 |
| juggernaut x 4900 (`--only juggernaut --copies 4900`) | branch default 1/20 | 453750406 | 10.93 |
| juggernaut x 4900            | `--dt 0.03333333333333333` | 10334191 (old pin holds) | 11.00 |

New pins at dt 1/20: 606739999 (mixed) and 453750406 (juggernaut).
The old pins need the exact double of 1/30 (`0.03333333333333333`, 17 digits). `--dt 0.0333333333333333` (16 digits) is another double and gives 412636644 on the mixed case.
cpuMsPerTick is the same per tick at both dt (a tick does the same work), the gain is 1.5x fewer ticks per simulated second (see `dt20.md`).
Tests: `npx vitest run liveSaves live --maxWorkers=1 --testTimeout=180000` 18 files, 306 tests, exit 0; `tsc --noEmit` in `server/` exit 0.

## What Erik does on the switch

1. Merge the branch (release as usual, the push gate for `server/` applies).
2. The first start after the deploy finds only 1/30 saves, logs the refusal for each tried save and starts a fresh world (founders seed, as after a reset). No admin action. The old saves stay in the state directory; the admin page cannot load them (it reports the refusal). To go back to 1/30, revert the branch and the old saves restore.
3. The fresh world's saves are at 1/20. A rollback to the previous release then also finds only 1/20 saves of the same world size and refuses them with the same logic only if the old release has the guard (it does not: it would restore them and run ticks as 1/30). So roll back with the state directory moved aside, or restore a pre-switch save directory.
4. The pages follow `dt` from the hello; the scene default 1/30 in `live/scene.ts` is overwritten there.
