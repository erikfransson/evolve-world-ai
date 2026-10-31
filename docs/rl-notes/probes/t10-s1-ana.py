# T10 S1: per-design table from the battery rows (t10-s1-battery.ts --out). Names are "<design>:start", "<design>:<mode>:s<seed>".
# Usage: python3 -I t10-s1-ana.py battery.json
import json, sys, math, collections
rows = json.load(open(sys.argv[1]))
CROWD = ("live-now", "live-patch", "live-famine", "live-poison")
SOLO = tuple("solo-" + e for e in CROWD if e != "live-patch")
M = {  # metric: (envs, per-row value)
    "survival s (crowd)": (CROWD, lambda r: r["seconds"]),
    "food/min (crowd)": (CROWD, lambda r: r["food"] / max(r["seconds"], 1 / 30) * 60),
    "food/min (solo)": (SOLO, lambda r: r["food"] / max(r["seconds"], 1 / 30) * 60),
    "poison bites (solo)": (SOLO, lambda r: r["poison"]),
    "first food s (solo)": (SOLO, lambda r: r["first"]),
    "survival s (solo)": (SOLO, lambda r: r["seconds"]),
}
cell = collections.defaultdict(list)  # (name, metric) -> {(env, seed): value}
by = collections.defaultdict(dict)
for r in rows:
    for m, (envs, f) in M.items():
        if r["env"] in envs: by[(r["name"], m)][(r["env"], r["seed"])] = f(r)
def mean(x): return sum(x) / len(x)
def ci(d):
    n = len(d); mu = mean(d); sd = math.sqrt(sum((v - mu) ** 2 for v in d) / (n - 1)); return mu, 1.96 * sd / math.sqrt(n)
designs = sorted({r["name"].split(":")[0] for r in rows})
def arm(design, mode, m):  # mean over training seeds, per (env, seed)
    names = [n for (n, mm) in by if mm == m and n.startswith(f"{design}:{mode}:")]
    keys = by[(names[0], m)].keys()
    return {k: mean([by[(n, m)][k] for n in names]) for k in keys}
for m in M:
    print(f"\n{m}: mean over training seeds; delta = self-play minus fixed, paired over (world, seed), 95% CI")
    print(f"{'design':16} {'start':>8} {'fixed':>8} {'selfplay':>9} {'delta':>16}")
    deltas = []
    for d in designs:
        st = mean(list(by[(f"{d}:start", m)].values()))
        a, b = arm(d, "fixed", m), arm(d, "selfplay", m)
        mu, h = ci([b[k] - a[k] for k in a])
        deltas.append(mu)
        print(f"{d:16} {st:8.2f} {mean(list(a.values())):8.2f} {mean(list(b.values())):9.2f} {mu:+9.2f} +-{h:.2f}")
    s = sorted(deltas); print(f"spread of delta over designs: min {s[0]:+.2f}, median {s[len(s)//2]:+.2f}, max {s[-1]:+.2f}")
