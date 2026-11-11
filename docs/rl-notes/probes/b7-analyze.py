# Usage: python3 b7-analyze.py RUNDIR  -- RUNDIR holds live-s<train seed>-w<world>.json (b7-live.ts). Per body and (seed, world) cell: life s, food/min, poison/min (ratio of sums over the copies).
# Prints levels (median over bodies of the cell mean) and set A minus set B: min/median/max over bodies, bodies with 95% CI above/below 0 (cells paired), bodies where all training seeds agree in sign.
import json, glob, re, statistics as st, sys
d = sys.argv[1]
cells = {}  # (set, body) -> {(s, w): (life, food/min, poison/min, children)}
for f in sorted(glob.glob(f"{d}/live-s*-w*.json")):
    s, w = map(int, re.search(r"live-s(\d+)-w(\d+)", f).groups())
    for st_, bodies in json.load(open(f))["rows"].items():
        for b, c in bodies.items():
            L = sum(c["life"])
            cells.setdefault((st_, b), {})[(s, w)] = (L / len(c["life"]), 60 * sum(c["food"]) / L, 60 * sum(c["poison"]) / L, sum(c["children"]) / len(c["life"]))
sets = sorted({k[0] for k in cells}); bodies = sorted({k[1] for k in cells})
M = ["life s", "food/min", "poison/min", "children"]
mean = lambda x: sum(x) / len(x)
print("| set | " + " | ".join(M) + " |\n|---|--:|--:|--:|--:|")
for a in sets:
    print(f"| {a} | " + " | ".join(f"{st.median([mean([v[i] for v in cells[(a, b)].values()]) for b in bodies]):.2f}" for i in range(4)) + " |")
def cmp(a, b):
    print(f"\n### {a} minus {b}\n| metric | min | median | max | up | down | seeds agree |\n|---|--:|--:|--:|--:|--:|--:|")
    for i, m in enumerate(M):
        mns, up, dn, ag = [], 0, 0, 0
        for bd in bodies:
            ca, cb = cells[(a, bd)], cells[(b, bd)]
            ks = sorted(set(ca) & set(cb)); x = [ca[k][i] - cb[k][i] for k in ks]
            mu = mean(x); h = 1.96 * st.stdev(x) / len(x) ** .5
            mns.append(mu); up += mu - h > 0; dn += mu + h < 0
            per = [mean([ca[k][i] - cb[k][i] for k in ks if k[0] == s]) for s in sorted({k[0] for k in ks})]
            ag += all(p > 0 for p in per) or all(p < 0 for p in per)
        print(f"| {m} | {min(mns):+.2f} | {st.median(mns):+.2f} | {max(mns):+.2f} | {up} | {dn} | {ag}/{len(bodies)} |")
for a, b in [("Smix1", "Smix"), ("Smix1", "untr"), ("Smix", "untr"), ("Smix1", "Scur"), ("Mmix", "Mmix1"), ("Mmix", "untr"), ("Mmix1", "untr")]:
    if (a, bodies[0]) in cells and (b, bodies[0]) in cells: cmp(a, b)
