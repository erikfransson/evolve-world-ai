# Node flags and helper threads for the live server

Measured on main before e955f09, `ecoBench --width 50000 --seconds 10` serial (9.7k creatures), nice 19, load 8 to 26. Driver and raw output: session scratchpad `opt3/topic-node`.

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| `--max-semi-space-size=32` / `64` | 80.3 / 79.2 ms CPU per tick | 83.9 / 83.5 | none (noise) | yes | none | 0 | not worth it |
| `--max-old-space-size=1024` | 81.98 | 85.2 | none | yes | none | 0 | not worth it |
| `--no-wasm-tier-up`, `--no-wasm-dynamic-tiering` | 82-83 | 81-84 | none | yes | none | 0 | not worth it |
| Helpers 1 / 2 / 3 at 50000 wide (one run each) | 18.9 s wall, 65 ms CPU per tick | 16.3 / 14.2 / 13.6 s wall | 1.16x / 1.33x / 1.39x wall | yes | 343 to 503 / 606 / 659 MB | 0 | Live session's call |

Medians of 3 alternating pairs for the flags. Thread rows are single runs taken when load dropped below 6; the other repeats were skipped by the load gate.
Helpers cost 1.3x to 1.75x more total CPU and about 160 MB per helper at this size, for at most 1.39x wall time.
