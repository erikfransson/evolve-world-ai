# Usage: [B1_BASE=current] [B1_SEEDS=1,2,3,4,5,6] python3 b1-analyze.py RUNDIR TIER [PROTOCOL ...]  -- RUNDIR holds t-untrained.json and t-<tier>-<protocol>-s<seed>.json (b1-score.ts output, 10 bodies, 64 test seeds).
# Table 1: median over the 10 bodies of the mean over training seeds, per scope (bigger, held2, long, small) for survival, food/min, poison/min: untrained and each protocol.
# Table 2: each protocol minus `current` (and minus untrained): min / median / max over bodies of the seed-mean difference, bodies with the pooled 95% CI above (up) / below (down) 0, and bodies where both seeds agree in sign.
import json, sys, statistics as st, os
BASE = os.environ.get('B1_BASE', 'current')  # protocol the others are compared against
SEEDS = [int(x) for x in os.environ.get('B1_SEEDS', '1,2').split(',')]  # training seeds to pool
d, tier = sys.argv[1], sys.argv[2]
M = {"survival": "surv", "foodPerMin": "food/min", "poisonPerMin": "poison/min"}
SC = {"small": lambda i, g: g[i] == "small", "bigger": lambda i, g: g[i] == "bigger", "held2": lambda i, g: i in ("live-poison", "live-commons"), "long": lambda i, g: g[i] == "long"}
def load(fn):
    j = json.load(open(fn)); grp = {e["id"]: e["group"] for e in j["envs"]}; out = {}
    for g in j["genomes"]:
        out[g["name"]] = {sc: {m: [sum(g["envs"][i][m][k] for i in ids) / len(ids) for k in range(len(g["envs"][ids[0]][m]))] for m in M}
                          for sc, f in SC.items() for ids in [[i for i in g["envs"] if f(i, grp)]]}
    return out
def ci(x):
    n = len(x); m = sum(x) / n; sd = (sum((v - m) ** 2 for v in x) / (n - 1)) ** .5; h = 1.96 * sd / n ** .5
    return m, m - h, m + h
mean = lambda x: sum(x) / len(x)
untr = load(f"{d}/t-untrained.json")
protos = sys.argv[3:] or sorted({f.split(f"t-{tier}-")[1].rsplit("-s", 1)[0] for f in os.listdir(d) if f.startswith(f"t-{tier}-") and f.endswith(".json")})
runs = {p: {s: load(f"{d}/t-{tier}-{p}-s{s}.json") for s in SEEDS if os.path.exists(f"{d}/t-{tier}-{p}-s{s}.json")} for p in protos}
runs = {p: r for p, r in runs.items() if r}
names = list(untr)
def lvl(get, sc, m): return st.median([mean(get(n)[sc][m]) for n in names])
print(f"## {tier}: median over {len(names)} bodies of the seed-mean")
print("| protocol | " + " | ".join(f"{sc} {M[m]}" for sc in ("bigger", "held2", "long", "small") for m in M) + " |")
print("|" + "---|" * (1 + 12))
print("| untrained | " + " | ".join(f"{lvl(lambda n: untr[n], sc, m):.2f}" for sc in ("bigger", "held2", "long", "small") for m in M) + " |")
for p, r in runs.items():
    print(f"| {p} | " + " | ".join(f"{st.median([mean([mean(r[s][n][sc][m]) for s in r]) for n in names]):.2f}" for sc in ("bigger", "held2", "long", "small") for m in M) + " |")
def cmp(a, b, label):
    ra, rb = runs[a], (runs[b] if b in runs else None)
    print(f"\n### {label}")
    print("| scope | metric | min | median | max | up | down | seed agree |")
    print("|---|---|--:|--:|--:|--:|--:|--:|")
    for sc in ("bigger", "held2", "long", "small"):
        for m, lab in M.items():
            pooled, agree, means = [], 0, []
            for n in names:
                seeds = [s for s in ra if rb is None or s in rb]
                per = {s: [x - y for x, y in zip(ra[s][n][sc][m], (rb[s][n][sc][m] if rb else untr[n][sc][m]))] for s in seeds}
                sm = [mean(per[s]) for s in seeds]
                agree += all((x > 0) == (sm[0] > 0) for x in sm)
                pooled.append(ci([v for s in seeds for v in per[s]])); means.append(mean(sm))
            print(f"| {sc} | {lab} | {min(means):+.2f} | {st.median(means):+.2f} | {max(means):+.2f} | {sum(p[1] > 0 for p in pooled)} | {sum(p[2] < 0 for p in pooled)} | {agree}/{len(names)} |")
for p in runs:
    cmp(p, None, f"{p} minus untrained")
    if p != BASE and BASE in runs: cmp(p, BASE, f"{p} minus {BASE}")
