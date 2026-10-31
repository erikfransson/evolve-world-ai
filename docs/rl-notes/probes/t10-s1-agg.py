# T10 S1: per design and scope, each arm's mean over its training seeds, and the paired difference (arm A minus arm B) over the 64 eval seeds.
# Usage: python3 -I t10-s1-agg.py A=file1,file2,file3 B=file1,file2,file3 [U=untrained.json]   (files: rlTransfer --out; the untrained file is the baseline)
import json, sys, math
M = ["survival", "foodPerMin", "poisonPerMin", "firstFood"]
def load(paths):
    out = {}  # (design, scope, metric) -> per-seed list averaged over files and envs of the scope
    for p in paths:
        d = json.load(open(p)); grp = {e["id"]: e["group"] for e in d["envs"]}
        for g in d["genomes"]:
            for sc in ("small", "bigger", "long"):
                envs = [e for e in g["envs"] if grp[e] == sc]
                for m in M:
                    v = [[x for x in g["envs"][e][m]] for e in envs]
                    per = [sum(c) / len(c) for c in zip(*v)]
                    out.setdefault((g["name"], sc, m), []).append(per)
    return {k: [sum(c) / len(c) for c in zip(*v)] for k, v in out.items()}
arms = {a.split("=")[0]: load(a.split("=")[1].split(",")) for a in sys.argv[1:]}
names = list(arms)
mean = lambda x: sum(x) / len(x)
def ci(d):
    mu = mean(d); sd = math.sqrt(sum((v - mu) ** 2 for v in d) / (len(d) - 1)); return mu, 1.96 * sd / math.sqrt(len(d))
designs = sorted({k[0] for k in arms[names[0]]})
for sc in ("long", "bigger", "small"):
    for m in M:
        print(f"\n{sc} {m}: " + ", ".join(names) + (f"; delta {names[1]} minus {names[0]} (95% CI)" if len(names) > 1 else ""))
        ds = []
        for d in designs:
            row = f"{d:16}" + "".join(f"{mean(arms[n][(d, sc, m)]):9.2f}" for n in names if (d, sc, m) in arms[n])
            if len(names) > 1 and all((d, sc, m) in arms[n] for n in names[:2]):
                a, b = arms[names[0]][(d, sc, m)], arms[names[1]][(d, sc, m)]
                mu, h = ci([y - x for x, y in zip(a, b)]); ds.append(mu); row += f"   {mu:+.2f} +-{h:.2f}"
            print(row)
        if ds: s = sorted(ds); print(f"  delta over designs: min {s[0]:+.2f}, median {s[len(s)//2]:+.2f}, max {s[-1]:+.2f}")
