# T7: compares t7-run.ts outputs. Per env the reward is divided by the Explorer founder's mean on the same held-out seeds, so 1.0 is
# founder level; a group score is the mean over its envs. A config difference is taken per training seed (same seed = same initial
# genome and the same held-out seeds), and its CI is over training seeds (t, n - 1), since training-seed spread dominates.
# Usage: python3 t7-agg.py DIR BASE CFG [CFG ...]   (DIR holds CFG-sN.json and ref-Explorer-s1.json)
import json, math, os, statistics as st, sys

# parameters
GROUPS = {
    "mix6": ["nibble", "far-food", "corridor", "patch", "minefield", "fading"],
    "unseen": ["rooms", "islands", "ring-road", "fence", "stings", "race", "duel", "sprint"],
    "unseen-no-sprint": ["rooms", "islands", "ring-road", "fence", "stings", "race", "duel"],  # sprint is all or nothing per run
}
T975 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26}

d, base, cfgs = sys.argv[1], sys.argv[2], sys.argv[3:]
ref = json.load(open(os.path.join(d, "ref-Explorer-s1.json")))["final"]
refm = {e: st.mean(v["reward"]) for e, v in ref.items()}

def runs(cfg):
    out = {}
    for f in os.listdir(d):
        if f.startswith(cfg + "-s") and f.endswith(".json") and f[len(cfg) + 2:-5].isdigit():
            out[int(f[len(cfg) + 2:-5])] = json.load(open(os.path.join(d, f)))["final"]
    return out

def score(final, envs):
    return st.mean(st.mean(final[e]["reward"]) / refm[e] for e in envs)

def ci(xs):
    n = len(xs)
    if n < 2: return float("nan")
    return T975.get(n - 1, 1.96) * st.stdev(xs) / math.sqrt(n)

allc = [base] + cfgs
R = {c: runs(c) for c in allc}
envs = list(dict.fromkeys(e for g in GROUPS.values() for e in g))
print("per env, mean over training seeds (raw reward); Explorer ref in the first column")
print(f"{'env':10s} {'ref':>6s} " + " ".join(f"{c:>10s}" for c in allc))
for e in envs:
    print(f"{e:10s} {refm[e]:6.2f} " + " ".join(f"{st.mean(st.mean(r[e]['reward']) for r in R[c].values()):10.2f}" for c in allc))
print()
for g, ge in GROUPS.items():
    print(f"group {g}: score (x founder) per config, mean +- CI over seeds [per seed]")
    for c in allc:
        xs = [score(R[c][s], ge) for s in sorted(R[c])]
        print(f"  {c:12s} {st.mean(xs):.3f} +- {ci(xs):.3f}  [{' '.join(f'{x:.2f}' for x in xs)}]")
    for c in cfgs:
        common = sorted(set(R[c]) & set(R[base]))
        ds = [score(R[c][s], ge) - score(R[base][s], ge) for s in common]
        if ds: print(f"  {c} - {base}: {st.mean(ds):+.3f} +- {ci(ds):.3f} (n {len(ds)}, wins {sum(x > 0 for x in ds)})")
    print()
