# Deadband thinking (idea 70)

Measurement only, nothing changes in the engine or any default.
A creature would skip its brain on a tick when its fresh brain input is within eps (max-abs over all inputs) of the input at its last think, and think at least every H ticks.
`liveBench --deadband` (hook in `server/src/deadbandHook.ts`) patches `WasmBrainBank.forwardRun`: the engine still thinks every tick, the hook keeps per sampled creature (every 8th brain slot, 452 and 737 creatures) a simulated gate state for each (eps, H) and records what the gate would have done and the error of holding the old output.
`liveBench --seconds 60 --copies 800 --deadband` and `--seconds 60 --only juggernaut --copies 4900 --deadband`, steady part (last 45 s), 557k and 827k creature-ticks.
Input = ray features, then 5 extras (energy, forward speed, lateral speed, turn rate, terrain), then the memory units. Output = turn, thrust (both -1..1, range 2), then one target per memory unit.
Error units: turn in rate = error x `maxTurnRate` (3 rad/s), thrust = error x `maxThrust` (200 before the species multiplier). 1% of the output range is 0.02.

## Why the gate cannot fire: change per tick

Share of creature-ticks whose input changed since the previous tick by more than the threshold, per input part (consecutive ticks, H = 1):

| Case    | Part         | exactly 0 | > 0.002 | > 0.005 | > 0.01 | > 0.02 | > 0.05 |
|---------|--------------|-----------|---------|---------|--------|--------|--------|
| mixed   | ray features | 0.465     | 0.520   | 0.498   | 0.448  | 0.331  | 0.299  |
| mixed   | extras       | 0         | 0.990   | 0.986   | 0.976  | 0.957  | 0.895  |
| mixed   | memory units | 0         | 0.998   | 0.986   | 0.973  | 0.952  | 0.913  |
| mixed   | any          | 0         | 0.998   | 0.998   | 0.997  | 0.996  | 0.992  |
| cap     | ray features | 0.563     | 0.428   | 0.412   | 0.369  | 0.270  | 0.232  |
| cap     | extras       | 0         | 0.995   | 0.990   | 0.970  | 0.941  | 0.863  |
| cap     | memory units | 0         | 0.998   | 0.980   | 0.961  | 0.919  | 0.849  |
| cap     | any          | 0         | 1.000   | 1.000   | 0.999  | 0.997  | 0.991  |

Ray features are unchanged in about half the ticks (empty sight lines), but the extras (own speed, turn rate, energy) are never exactly constant and the memory units move every tick toward their held targets (rate 0.3 and 0.01).
Even the loosest eps 0.05 leaves 99% of the ticks above it.

## Gate curves

Skip share, and the error of the held output on the skipped ticks (mean, 99th percentile over skipped ticks, max). Memory = max over the memory targets. H = 4, 8 and none differ little because the gate almost never holds more than a tick.

| Case  | eps   | H    | Skip share | Turn mean | Turn p99 | Thrust mean | Thrust p99 | Memory mean | Memory p99 | Projected tick gain |
|-------|-------|------|------------|-----------|----------|-------------|------------|-------------|------------|---------------------|
| mixed | 0.002 | 4    | 0.13%      | 0         | 0.0005   | 0           | 0.0005     | 0.0003      | 0.004      | 0.04%               |
| mixed | 0.005 | 4    | 0.18%      | 0.0003    | 0.008    | 0           | 0.0005     | 0.0015      | 0.033      | 0.06%               |
| mixed | 0.01  | 4    | 0.21%      | 0.0026    | 0.065    | 0           | 0.0005     | 0.0048      | 0.106      | 0.07%               |
| mixed | 0.02  | 4    | 0.28%      | 0.015     | 0.300    | 0.00003     | 0.0005     | 0.023       | 0.414      | 0.09%               |
| mixed | 0.05  | 4    | 0.63%      | 0.086     | 0.957    | 0.0015      | 0.0185     | 0.096       | 1.357      | 0.21%               |
| mixed | 0.002 | 8    | 0.13%      | 0         | 0.0005   | 0           | 0.0005     | 0.0003      | 0.004      | 0.04%               |
| mixed | 0.005 | 8    | 0.20%      | 0.0003    | 0.007    | 0           | 0.0005     | 0.0015      | 0.032      | 0.07%               |
| mixed | 0.01  | 8    | 0.24%      | 0.0023    | 0.051    | 0           | 0.0005     | 0.0047      | 0.081      | 0.08%               |
| mixed | 0.02  | 8    | 0.32%      | 0.014     | 0.295    | 0.00003     | 0.0005     | 0.022       | 0.383      | 0.11%               |
| mixed | 0.05  | 8    | 0.67%      | 0.083     | 0.922    | 0.0014      | 0.016      | 0.093       | 1.331      | 0.22%               |
| mixed | 0.002 | none | 0.13%      | 0         | 0.0005   | 0           | 0.0005     | 0.0003      | 0.004      | 0.04%               |
| mixed | 0.005 | none | 0.20%      | 0.0003    | 0.007    | 0           | 0.0005     | 0.0015      | 0.029      | 0.07%               |
| mixed | 0.01  | none | 0.25%      | 0.0022    | 0.051    | 0           | 0.0005     | 0.0047      | 0.081      | 0.08%               |
| mixed | 0.02  | none | 0.34%      | 0.013     | 0.287    | 0.00003     | 0.0005     | 0.022       | 0.383      | 0.11%               |
| mixed | 0.05  | none | 0.70%      | 0.080     | 0.919    | 0.0013      | 0.016      | 0.092       | 1.323      | 0.23%               |
| cap   | 0.002 | 4    | 0.01%      | 0.0019    | 0.021    | 0           | 0.0005     | 0.0048      | 0.033      | 0.00%               |
| cap   | 0.005 | 4    | 0.03%      | 0.0032    | 0.026    | 0.00001     | 0.0005     | 0.013       | 0.068      | 0.01%               |
| cap   | 0.01  | 4    | 0.08%      | 0.0097    | 0.119    | 0.00004     | 0.0005     | 0.026       | 0.238      | 0.03%               |
| cap   | 0.02  | 4    | 0.21%      | 0.026     | 0.310    | 0.0006      | 0.0115     | 0.046       | 0.547      | 0.07%               |
| cap   | 0.05  | 4    | 0.74%      | 0.089     | 0.807    | 0.0008      | 0.005      | 0.111       | 1.261      | 0.24%               |
| cap   | 0.05  | 8    | 0.76%      | 0.088     | 0.799    | 0.0008      | 0.005      | 0.111       | 1.254      | 0.25%               |
| cap   | 0.05  | none | 0.77%      | 0.088     | 0.799    | 0.0008      | 0.0055     | 0.113       | 1.254      | 0.25%               |

The remaining cap rows (eps 0.01 to 0.02, H 8 and none) match the H = 4 rows within 0.1 percentage points of skip share.
Projected tick gain = skip share x 0.33 (brain forward 5.23 of 15.24 ms per tick; the senser still runs).
Output range 2, so 1% is 0.02. Turn p99 stays under 0.02 only for eps up to 0.005 (mixed) and 0.002 (cap), where the skip share is 0.2% or less.
Share of threshold thinks caused by each part (mixed, eps 0.01): rays 45%, extras 98%, memory 98% (overlapping).

## Verdict suggestion

Reject, and do not run the full ecology protocol (600 s x 3 seeds).
No eps gives a useful skip share: 0.7% at eps 0.05 (the turn error p99 there is 0.92, almost the whole output range), and 0.1 to 0.3% at eps where the error is small.
The projected gain is under 0.3% of the tick, and the extras (own speed, turn rate, energy) and the memory units move by more than 0.05 on 85 to 90% of the ticks, so a looser eps would be needed that already breaks the output bound.
Unlike thinkEvery 2 (think2.md), a deadband cannot be used with the current input design because the self-feedback inputs and memory units change continuously.
A gate on rays alone (about half the ticks unchanged) would skip the senser as well, but then holds across changing body inputs, which is the thinkEvery failure mode (turn +26%).
Hook left as a scratch switch (`--deadband`); remove with this branch if the idea is closed.
