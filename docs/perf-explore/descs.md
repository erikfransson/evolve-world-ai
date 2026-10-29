# descs (idea 65): run-ordered, 64-byte-aligned descriptor array

What: `forwardRun` would gather the run's 64-byte descriptors into a contiguous run-ordered region before `forward`, so each brain start reads a sequential line instead of a random one from the 212 KB table (4096 slots x 64 B). Pre-check only, nothing built: the kernel alone showed no gain.

## How measured
Scratch A/B `scratchpad/descs/dab.ts` (the brainorder `oab.ts` harness): one tick's real brain run on the live memory at tick 600 (3318 brains), same `brain.wat` plus a scratch `gather` export (four v128 copies per descriptor, slot list rewritten as 0..n-1 so `forward` is unchanged), user CPU, median of 81, cold (48 MB eviction) and hot, output vectors hashed (equal in every variant).
Variants: base (slot-indexed table), align64 (table copied to a fresh 64-aligned address), mis16 (copied to 64k+16, the straddling case), gatherF (gather untimed, `forward` timed), gatherT (gather plus `forward` timed), gatherOnly.
Note: at the 4096-slot size `descPtr` was already 64-aligned in this run (mod 64 = 0), so base is the aligned case; mis16 stands in for the straddling one.

## Results (ms, ratio to base)

| Case                | Run | base  | align64 | mis16 | gatherF | gatherT | gather alone |
|---------------------|-----|-------|---------|-------|---------|---------|--------------|
| mixed, cold         | 1   | 4.524 | 0.993x  |       | 0.992x  | 0.965x  | 0.172        |
| mixed, cold         | 2   | 5.005 | 1.009x  |       | 1.001x  | 0.970x  | 0.194        |
| mixed, cold         | 3   | 4.919 | 1.002x  | 1.000x | 1.003x | 0.970x  | 0.197        |
| mixed, cold         | 4   | 4.915 | 0.996x  | 0.991x | 1.002x | 0.963x  | 0.197        |
| mixed, hot          | 1-4 | 4.86-4.97 | 0.996-1.007x | 0.999-1.008x | 0.996-1.001x | 0.960-0.979x | 0.055-0.060 |
| juggernaut 4900, cold | 1 | 4.938 | 1.004x | | 1.001x | 0.951x | 0.281 |
| juggernaut 4900, cold | 2 | 4.853 | 1.000x | | 0.998x | 0.947x | 0.279 |
| juggernaut 4900, hot  | 1-2 | 4.92-4.87 | 0.989-0.997x | | 0.991-0.994x | 0.945-0.954x | 0.138-0.143 |

Hashes equal in all variants (mixed 59677ba7d3f4, juggernaut 0d220243ce88). Load average 12-16, runs pinned to cpus 2,3,6,7.

## Reading
- The descriptor stream is not exposed: a sequential, aligned copy leaves the kernel within +-1% of base, and a 16-byte misalignment (two lines per record) costs 0.0-0.9%, inside the spread. The prefetch-bound load of the next descriptor and the out-of-order window already hide the table misses, as compactio found for inputs and outputs.
- The gather itself costs 0.06 ms hot and 0.17-0.28 ms cold (3.5-5.7% of the kernel), more than any possible gain, so the kernel plus gather is 3-5% slower.
- Aligning `descPtr` to 64 alone is also worth nothing (align64, mis16 above).

Verdict: reject at the pre-check (bar was more than 2% of the kernel). No code change, no tick bench, no fingerprint run needed (the kernel is untouched).
