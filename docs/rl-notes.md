# RL training notes (C1)

How to train creatures in RL envs so they get better systematically.
Append-only: mark items done, do not rewrite. Track files in `docs/rl-notes/` are merged here.

## Results

| id | question | finding | evidence |
|----|----------|---------|----------|

## Questions

- C1a: Why does backprop seem to learn little?
- C1b: What makes an env well suited for training?
- C1c: A systematic recipe (ES vs backprop vs hybrid, curricula, held-out measure, feed to founders).

Tracks: T1 backprop diagnosis, T2 ES learner quality, T3 env trainability, T4 recipe and transfer.

## Log

- 2026-10-21. Started from development 7df22c7. Prior work: docs/rl-grad-notes.md (PPO beats ES on nibble, corridor, minefield from random at equal wall time), docs/rl-algo-notes.md, docs/rl-envs.md. bp-investigate: no bug, gradient check passes; from a founder PPO starts near the ceiling and training scores look lower due to exploration noise.
