# Idea 12: node/V8 flags, liveBench --seconds 60 --copies 800 (all with --max-old-space-size=768, nice 19, load 11-28)
Raw: /tmp/claude-1000/-home-erik-progs-evolve-world-ai/955cd588-515f-4098-9019-fd8b6ae2ff1c/scratchpad/flagrun/results.txt
Baseline 9 interleaved runs: 15.707 15.666 15.492 15.734 15.656 14.861 15.229 15.461 14.740, median 15.49, peakRSS 207-211. All fingerprints 708687555.

| flag                               | runs (ms/tick)  | median | ratio | peakRSS | win? |
|------------------------------------|-----------------|--------|-------|---------|------|
| baseline                           | 9 runs          | 15.49  | 1.000 | 207-211 | -    |
| --max-semi-space-size=32           | 15.462 15.952   | 15.71  | 1.014 | 212     | no   |
| --max-semi-space-size=64           | 15.647 15.164   | 15.41  | 0.994 | 209-211 | no   |
| --no-liftoff                       | 15.614 14.092   | 14.85  | 0.959 | 207     | no (1st run 0.997 vs adjacent base; 2nd ran at load 11 vs 13-14 base, noise) |
| --no-wasm-lazy-compilation         | 15.404 15.042   | 15.22  | 0.983 | 221-222 | no, +12 MB RSS |
| --no-wasm-dynamic-tiering          | 15.584 15.048   | 15.32  | 0.989 | 209-214 | no   |
| --experimental-wasm-branch-hinting | 15.725 15.339   | 15.53  | 1.003 | 211-212 | no   |
| --single-threaded-gc               | 15.650 15.632   | 15.64  | 1.010 | 213-218 | no   |
| --max-lazy                         | 15.609 15.086   | 15.35  | 0.991 | 210-212 | no   |
| --jitless                          | -                | -      | -     | -       | refused: ERR_WEBASSEMBLY_NOT_SUPPORTED (WASM kernels cannot run), so no number |

Not listed in this V8 (24.18): no --wasm-tier-up variants beyond --wasm-tier-up (needs liftoff, default on) and --wasm-dynamic-tiering (default on, tested negation).
--trace-gc (one run, whole process incl. 6 s build): 160 scavenges (~0.64 ms main-thread each, 429 ms total) + 9 mark-compacts (185 ms total) = ~0.6 s of ~27 s CPU = ~2%. Heap stays ~22-38 MB, so semi-space size is irrelevant.
Semi-space flags do not change peakRSS (209-212 vs 207-211).
Verdict: no flag beats baseline in every pair by >3%; spread between baseline runs is itself 14.7-15.7 (6%). Keep command line as is.
