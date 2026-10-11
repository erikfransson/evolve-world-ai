# Backprop RL (PPO) vs ES: notes

Prototype: `src/sim/rl/ppo.ts`, CLI `src/rlGrad.ts`.
PPO trains the creature's own brain (same genome layout, so a result saves and loads like any ES result).

- Policy: Gaussian on the pre-tanh turn and thrust outputs, state-free learned log-std (init -0.5, std 0.6). Held-out and the Ecosystem use the mean (the brain as is).
- Memory units: inputs are observed, targets stay deterministic from the same weights, no backprop through time.
- Critic: separate MLP (brain input + time left, 32 tanh units, linear out). GAE gamma 0.995 per tick, lambda 0.95, clip 0.2, Adam, grad norm 0.5.
- Rewards: food and kills per tick, the rest of the episode reward (fast bonus, end energy) on the last step, so steps sum to `runEpisode`'s reward.
- Hook: `runEpisode(..., act)` lets the policy overwrite the learner's outputs after its brain ran; without `act` the path is unchanged (test).
- Settings used: 16 episodes per update, action held 3 ticks (`--repeat 3`), 2 epochs, minibatch 256, lr 0.003. With repeat 1 and lr 0.001 nibble learned far slower (0.22 after 240 episodes, then 2 s per update before the sparse first layer).

## Results

From random:1, held-out = 32 seeds HELD_BASE + k, deterministic. ES: rlTrain, pairs 100, 1 episode, 60 iterations, 2 threads (12000 episodes), time includes its held-out checks (~3%).
PPO: 1 thread, 25 s of training (held-out checks excluded). Cells: held-out at 5 s / 10 s / 20 s / end. Laptop shared and loaded, ES seed 2 ran ~2x slower than seed 1.

| env       | start | method | seed | 5 s  | 10 s | 20 s | end  | end at        | episodes |
|-----------|-------|--------|------|------|------|------|------|---------------|----------|
| nibble    | 0.09  | ES     | 1    | 1.42 | 1.62 | 1.87 | 1.97 | 23 s          | 12000    |
| nibble    | 0.09  | ES     | 2    | 0.59 | 0.88 | 2.31 | 2.64 | 41 s          | 12000    |
| nibble    | 0.09  | PPO    | 1    | 2.35 | 2.75 | 2.94 | 2.83 | 25 s          | 2272     |
| nibble    | 0.09  | PPO    | 2    | 1.78 | 2.90 | 2.82 | 2.99 | 25 s          | 2576     |
| corridor  | 0.06  | ES     | 1    | 0.22 | 0.53 | 0.62 | 0.69 | 23 s          | 12000    |
| corridor  | 0.06  | ES     | 2    | 0.06 | 0.31 | 0.47 | 0.84 | 46 s          | 12000    |
| corridor  | 0.06  | PPO    | 1    | 0.41 | 0.97 | 0.98 | 1.07 | 25 s          | 1696     |
| corridor  | 0.06  | PPO    | 2    | 0.66 | 1.17 | 1.63 | 1.63 | 25 s          | 2368     |
| minefield | 0.16  | ES     | 1    | 0.31 | 0.59 | 0.59 | 0.94 | 25 s          | 12000    |
| minefield | 0.16  | ES     | 2    | 0.41 | 0.47 | 0.44 | 0.59 | 27 s          | 12000    |
| minefield | 0.16  | PPO    | 1    | 0.66 | 0.69 | 0.97 | 1.01 | 25 s          | 2736     |
| minefield | 0.16  | PPO    | 2    | 0.56 | 1.07 | 1.68 | 1.36 | 25 s          | 3024     |

Peak RSS: ES 245-280 MB, PPO 190-200 MB.

## Findings

- PPO beats ES on all three envs at equal wall time, on half the threads, and with ~5x fewer episodes. It ends higher too (nibble 2.9 vs 2.3, corridor 1.35 vs 0.77, minefield 1.19 vs 0.77, means of 2 seeds).
- Cost per episode is ~10 ms for PPO (rollout 5 ms, update 5 ms) against ~4 ms per thread for ES. The first layer skips zero inputs (mostly one-hot ray flags) and only turn and thrust rows of the output layer are computed, which cut the update ~2x.
- Holding each sampled action for 3 ticks matters: per-tick noise at 30 Hz averages out in the body's inertia and explores little.
- Not tried: pool:0 starts, the advanced and rival envs, 2-thread rollouts.

## Arena

- Start message `method: "es" | "backprop"`, `options.backprop` (lr, episodes per update). `ArenaRun` drives either trainer through `RlTrainer` (trainer.ts): `Trainer` (ES) or `BackpropTrainer` (ppo.ts).
- Backprop updates run on the Arena worker thread itself; held-out checks and tile recordings still use the helpers. Self-play rivals are the current policy.
- Form: "Training method" choice in Run; Population, Episodes per candidate, Mutation size and ES learning rate grey out for backprop; Backprop learning rate and Episodes per update under More settings.
- Tiles under backprop show the current policy, "policy at update N". The stat card and graph line read "Best episode": the update's best training episode.
- Headless check (1400x1000, nibble, design start): held-out 0.0 -> 3.5 in 20 s of browser time.
- Next: rollouts on the helpers (trajectory jobs) would use all threads.
