# L1 tables: python3 l1-tables.py SCOREDIR  (rlTransfer outputs named untrained.json, <arm>-<checkpoint>.json)
import json, sys, glob, os, statistics as st
d = sys.argv[1]
SC = {"small": ["minefield", "stings", "patch", "far-food", "islands"], "held2": ["live-poison", "live-commons"], "long": ["live-long"]}
M = [("foodPerMin", "food"), ("poisonPerMin", "poison"), ("survival", "surv")]
def cell(g, scope):
    return [st.mean(st.mean(g["envs"][e][m]) for e in SC[scope]) for m, _ in M]
rows = {}
for f in sorted(glob.glob(f"{d}/*.json")):
    name = os.path.basename(f)[:-5]
    arm, _, n = name.rpartition("-") if name != "untrained" else ("untrained", "", "0")
    for g in json.load(open(f))["genomes"]:
        rows.setdefault(g["name"], []).append((arm, int(n), g))
order = {"untrained": 0, "es": 1, "bp-nofloor": 2, "bp-floor": 3}
for dn, lst in rows.items():
    if len(lst) < 2: continue  # untrained only: design not trained
    print(f"\n{dn}\n| arm | point | " + " | ".join(f"{s} {l}" for s in SC for _, l in M) + " |\n|-----|------:|" + "------:|" * 9)
    for arm, n, g in sorted(lst, key=lambda x: (order[x[0]], x[1])):
        print(f"| {arm} | {n} | " + " | ".join(f"{v:.2f}" for s in SC for v in cell(g, s)) + " |")
