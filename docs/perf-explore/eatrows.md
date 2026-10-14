| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Eat loop over the touched list only (hits scan, rotated to the random start) + rebuildRows without the species copy + cell index inlined with hoisted locals | 36.07 ms/tick cpu (eat 3.88 phase) | 34.81 (eat 2.87) | 1.036x | yes, all fingerprints equal | +1 MB (noise) | +31 net | Merge |
| Crowd rebuild straight from rows without the gather arrays | not tried | | | | | | Rows are 192 B apart, the gather keeps the sort reads in 80 KB; likely slower |

Medians of 3 alternating pairs, nice 19, load 5 to 7, `inland-sea --pop 10000 --seconds 15`.

- The eat loop walked all 10k members but only creatures touching an item can eat. It now lists them (`touched[at] >= 0`) and walks the list from the random start, same order. Loop cost dropped to about 0.07 ms.
- The remaining "eat" phase is the crowd rebuild (about 1.7 ms) and `touchedBatch` item lookups (about 1.1 ms, measured with temporary laps).
- Checks: Inland 830514026, 739359978, 877945501 (wasm=false), 410981010 (--predators --seconds 40), bench.ts 727564408. vitest 814 passed (live* files fail only for missing server/node_modules).
