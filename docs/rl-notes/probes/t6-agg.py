# T6 aggregation: groups t6-train outputs by name without the trailing -sN / -iN, and compares groups against a reference.
# Usage: python3 t6-agg.py DIR [REF_GROUP]
# A run's score is its mean over the fixed test seeds. Gain = difference of group means; 95% CI by Welch t over runs, so it holds the
# training-seed spread. "paired" is the per-test-seed difference of group means, its CI only covers the test-seed noise.
import glob, json, math, re, sys
from collections import defaultdict

T95 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 10: 2.23, 15: 2.13, 20: 2.09, 30: 2.04}
def t95(df):
    return T95[min(T95, key=lambda k: abs(k - df))] if df < 30 else 1.96
def mean(a): return sum(a) / len(a)
def var(a): return sum((x - mean(a)) ** 2 for x in a) / (len(a) - 1) if len(a) > 1 else float("nan")

groups = defaultdict(list)
for f in sorted(glob.glob(sys.argv[1] + "/*.json")):
    name = f.split("/")[-1][:-5]
    groups[re.sub(r"-[si]\d+$", "", name)].append(json.load(open(f)))
ref = sys.argv[2] if len(sys.argv) > 2 else None
print(f"{'group':28} {'n':>2} {'mean':>6} {'sd':>5} {'runs':24} {'cpu':>4}" + ("  gain vs ref [95% CI], paired seed CI" if ref else ""))
for g, runs in groups.items():
    s = [r["testMean"] for r in runs]
    line = f"{g:28} {len(s):2} {mean(s):6.3f} {math.sqrt(var(s)) if len(s) > 1 else 0:5.2f} {' '.join(f'{x:.2f}' for x in s):24} {mean([r['cpu'] for r in runs]):4.0f}"
    if ref and g != ref and ref in groups:
        r0 = [r["testMean"] for r in groups[ref]]
        d = mean(s) - mean(r0)
        va, vb = var(s) / len(s), var(r0) / len(r0)
        se = math.sqrt(va + vb)
        df = (va + vb) ** 2 / ((va ** 2 / (len(s) - 1)) + (vb ** 2 / (len(r0) - 1))) if va + vb > 0 else 30
        ps = [mean([r["test"][k] for r in runs]) - mean([r["test"][k] for r in groups[ref]]) for k in range(len(runs[0]["test"]))]
        pse = math.sqrt(var(ps) / len(ps))
        line += f"  {d:+.3f} [{d - t95(df) * se:+.2f}, {d + t95(df) * se:+.2f}], +-{1.96 * pse:.2f}"
    print(line)
