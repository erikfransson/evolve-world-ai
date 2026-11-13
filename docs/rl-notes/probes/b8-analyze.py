# Usage: python3 b8-analyze.py TRAINDIR LIVEDIR
#   TRAINDIR holds {light,medium,strong}-s<seed>/<start>.meta.json (rlTiers.ts), LIVEDIR holds live-s<seed>-w<world>.json (b8-live.ts, sets orig/light/medium/strong).
# Per start, tier, training seed and world: trained minus original brain in Live (life s, food/min, poison/min, children), and the re-score's pick.
import json, glob, re, statistics as st, sys, itertools
T, D = sys.argv[1], sys.argv[2]
pick, score = {}, {}  # (tier, seed, start) -> bool, (start score, kept score)
for f in glob.glob(f"{T}/*-s*/*.meta.json"):
    tier, s = re.search(r"/(light|medium|strong)-s(\d+)/", f).groups(); start = f.split("/")[-1][:-10]
    m = json.load(open(f)); r = m["rescore"]
    pick[(tier, int(s), start)] = bool(m["phases"][0]["kept"]) and r["kept"] > r["start"]
    score[(tier, int(s), start)] = (r["start"], r["kept"])
starts = sorted({k[2] for k in pick}); tiers = ["light", "medium", "strong"]
M = ["life s", "food/min", "poison/min", "children"]
mean = lambda x: sum(x) / len(x)
cell = {}  # (set, start, seed, world) -> metrics
for f in sorted(glob.glob(f"{D}/live-s*-w*.json")):
    s, w = map(int, re.search(r"live-s(\d+)-w(\d+)", f).groups())
    for sett, bodies in json.load(open(f))["rows"].items():
        for b, c in bodies.items():
            L = sum(c["life"]); cell[(sett, b, s, w)] = (L / len(c["life"]), 60 * sum(c["food"]) / L, 60 * sum(c["poison"]) / L, sum(c["children"]) / len(c["life"]))
seeds = sorted({k[2] for k in cell}); worlds = sorted({k[3] for k in cell})
def ci(x):
    if len(x) < 2: return (mean(x), 0.0)
    return (mean(x), 1.96 * st.stdev(x) / len(x) ** .5)
print("## Re-score picks (trained brain kept over the start), training seeds 1 to 3\n")
print("| start | " + " | ".join(f"{t} picks | {t} start -> kept (mean)" for t in tiers) + " |\n|---|" + "--:|--:|" * 3)
tot = {t: [0, 0] for t in tiers}
for b in starts:
    row = []
    for t in tiers:
        ks = [(t, s, b) for s in (1, 2, 3) if (t, s, b) in pick]
        n = sum(pick[k] for k in ks); tot[t][0] += n; tot[t][1] += len(ks)
        row += [f"{n}/{len(ks)}", f"{mean([score[k][0] for k in ks]):.2f} -> {mean([score[k][1] for k in ks]):.2f}" if ks else "-"]
    print(f"| {b} | " + " | ".join(row) + " |")
print("| all | " + " | ".join(f"{tot[t][0]}/{tot[t][1]} | " for t in tiers) + " |")
def diffs(tier, start, sel=None):
    out = []
    for s in seeds:
        if sel is not None and pick.get((tier, s, start)) != sel: continue
        for w in worlds:
            a, b = cell.get((tier, start, s, w)), cell.get(("orig", start, s, w))
            if a and b: out.append((s, w, [a[i] - b[i] for i in range(4)]))
    return out
print("\n## Live: trained minus original, every case (ignores the re-score), mean over cells (seed x world) per start\n")
for t in tiers:
    print(f"### {t}\n| start | " + " | ".join(M) + " | cells |\n|---|--:|--:|--:|--:|--:|")
    for b in starts:
        d = diffs(t, b)
        if d: print(f"| {b} | " + " | ".join("%+.2f (±%.2f)" % ci([x[2][i] for x in d]) for i in range(4)) + f" | {len(d)} |")
print("\n## Live: kept brain (re-score's choice) minus original, per tier, over starts\n")
print("| tier | metric | median over starts | min | max | starts up | starts down |\n|---|---|--:|--:|--:|--:|--:|")
for t in tiers:
    per = {}
    for b in starts:
        d = diffs(t, b)
        if d: per[b] = [[x[2][i] if pick.get((t, x[0], b)) else 0.0 for x in d] for i in range(4)]
    for i, m in enumerate(M):
        mus = {b: ci(v[i]) for b, v in per.items()}
        print(f"| {t} | {m} | {st.median(x[0] for x in mus.values()):+.2f} | {min(x[0] for x in mus.values()):+.2f} | {max(x[0] for x in mus.values()):+.2f} | {sum(x[0]-x[1]>0 for x in mus.values())} | {sum(x[0]+x[1]<0 for x in mus.values())} |")
print("\n## Live: picked against not picked (trained minus original), pooled over starts, training seeds and worlds\n")
print("| tier | group | n cases | life s | food/min | poison/min | children | share life > 0 | share food > 0 |\n|---|---|--:|--:|--:|--:|--:|--:|--:|")
allrows = {True: [], False: []}
for t in tiers:
    for sel, name in [(True, "picked"), (False, "not picked")]:
        rows = [x for b in starts for x in diffs(t, b, sel)]; allrows[sel] += rows
        if rows: print(f"| {t} | {name} | {len(rows)} | " + " | ".join("%+.2f (±%.2f)" % ci([x[2][i] for x in rows]) for i in range(4)) + f" | {mean([x[2][0] > 0 for x in rows]):.2f} | {mean([x[2][1] > 0 for x in rows]):.2f} |")
for sel, name in [(True, "picked"), (False, "not picked")]:
    rows = allrows[sel]
    if rows: print(f"| all | {name} | {len(rows)} | " + " | ".join("%+.2f (±%.2f)" % ci([x[2][i] for x in rows]) for i in range(4)) + f" | {mean([x[2][0] > 0 for x in rows]):.2f} | {mean([x[2][1] > 0 for x in rows]):.2f} |")
print("\nCI is 1.96 standard errors over cases, cases share worlds and starts so it is optimistic.")
