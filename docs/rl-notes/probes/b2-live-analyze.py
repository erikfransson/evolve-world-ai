# Usage: python3 b2-live-analyze.py RUNDIR  -- RUNDIR holds live-s<seed>-w<world>.json (b2-live.ts, sets start, Lcur, Lppo, Mcur, Mppo, Scur, Sppo) and the rlTiers metas.
# Per set: median (min, max) over starts of the mean life (s, censored at the horizon) and children, starts with a longer mean life than the start set.
# X+r: per training seed and start, the ppo05 row when the kept brain's re-score beat the start's, else the start row of the same world.
import json, os, glob, statistics as st, sys
d = sys.argv[1]
TIER = {"L": "light", "M": "medium", "S": "strong"}
files = sorted(glob.glob(f"{d}/live-s*-w*.json"))
cells = {}  # set -> start -> {"life": [...], "children": [...]}
for fn in files:
    seed = int(os.path.basename(fn).split("-")[1][1:]); j = json.load(open(fn))["rows"]
    for st_, rows in list(j.items()) + [(k[0] + "ppo+r", None) for k in j if k.endswith("ppo")]:
        for n in j["start"]:
            if rows is None:
                m = json.load(open(f"{d}/{TIER[st_[0]]}/ppo05-s{seed}/{n}.meta.json"))["rescore"]
                r = j[st_[:-2]][n] if m["kept"] > m["start"] else j["start"][n]
            else: r = rows[n]
            c = cells.setdefault(st_, {}).setdefault(n, {"life": [], "children": []})
            c["life"] += r["life"]; c["children"] += r["children"]
mean = lambda x: sum(x) / len(x)
names = list(cells["start"])
base = {n: mean(cells["start"][n]["life"]) for n in names}
print(f"{len(files)} worlds; {len(cells['start'][names[0]]['life'])} inserted copies per set and start\n")
print("| set | life s | children | starts longer / shorter than start |")
print("|---|--:|--:|--:|")
for s, per in cells.items():
    life = [mean(per[n]["life"]) for n in names]; ch = [mean(per[n]["children"]) for n in names]
    up = sum(mean(per[n]["life"]) > base[n] + 1e-9 for n in names); dn = sum(mean(per[n]["life"]) < base[n] - 1e-9 for n in names)
    print(f"| {s} | {st.median(life):.1f} ({min(life):.0f}, {max(life):.0f}) | {st.median(ch):.2f} | {'-' if s == 'start' else f'{up}/{dn}'} |")
print("\nper start mean life: " + "; ".join(f"{n}: " + ", ".join(f"{s} {mean(cells[s][n]['life']):.0f}" for s in cells) for n in names))
