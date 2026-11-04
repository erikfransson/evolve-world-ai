# Usage: python3 d2-analyze.py DIR   (DIR has t-<variant>-s<seed>.json from rlTransfer.ts, one per variant and training seed)
# Per design, the paired difference variant - base (a) over test seeds and training seeds, per scope; then min/median/max over designs
# and the number of designs whose 95% CI is above / below 0.
import json, sys, glob, re, statistics as st
d = sys.argv[1]
M = {"foodPerMin": "food/min", "poisonPerMin": "poison/min", "firstFood": "first food s", "survival": "survival"}
def load(v, s):
    j = json.load(open(f"{d}/t-{v}-s{s}.json"))
    groups = {e["id"]: e["group"] for e in j["envs"]}
    out = {}
    for g in j["genomes"]:
        sc = {}
        for scope in ("small", "bigger"):
            ids = [i for i in g["envs"] if groups[i] == scope]
            sc[scope] = {m: [sum(g["envs"][i][m][k] for i in ids) / len(ids) for k in range(len(g["envs"][ids[0]][m]))] for m in M}
        out[g["name"]] = sc
    return out
seeds = sorted({int(re.search(r"-s(\d+)", f).group(1)) for f in glob.glob(f"{d}/t-a-s*.json")})
base = {s: load("a", s) for s in seeds}
def ci(x):
    n = len(x); m = sum(x) / n; sd = (sum((v - m) ** 2 for v in x) / (n - 1)) ** .5 if n > 1 else 0
    h = 1.96 * sd / n ** .5; return m, m - h, m + h
for v in "bcde":
    if not all(glob.glob(f"{d}/t-{v}-s{s}.json") for s in seeds): continue
    var = {s: load(v, s) for s in seeds}
    print(f"\n== variant {v} vs a (training seeds {seeds})")
    for scope in ("small", "bigger"):
        for m, label in M.items():
            per = []
            for name in base[seeds[0]]:
                diffs = [x - y for s in seeds for x, y in zip(var[s][name][scope][m], base[s][name][scope][m])]
                per.append(ci(diffs))
            means = [p[0] for p in per]
            print(f"{scope:6s} {label:13s} min {min(means):7.2f} med {st.median(means):7.2f} max {max(means):7.2f}  up {sum(p[1] > 0 for p in per)} down {sum(p[2] < 0 for p in per)} of {len(per)}")
