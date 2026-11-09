# Usage: [B2_SEEDS=1,2] python3 b2-analyze.py RUNDIR TIER [PROTOCOL ...]  -- RUNDIR holds t-start.json, t-<tier>-<protocol>-s<seed>.json (b2-score.ts) and <tier>/<protocol>-s<seed>/<start>.meta.json (rlTiers --from).
# PROTOCOL+rb (its own runs, rlTiers trained it on the budget less the re-score) gets the same choice. PROTOCOL+r is protocol (d): per start and seed the kept brain only when its re-score on the held seeds of the mix beats the start's, else the start.
# Table 1: median (min, max) over starts of the seed-mean, per scope. Table 2 per protocol: minus the start (a), min / median / max over starts, starts with the pooled 95% CI above / below 0, starts where all seeds agree in sign.
import json, sys, statistics as st, os
SEEDS = [int(x) for x in os.environ.get('B2_SEEDS', '1,2').split(',')]
d, tier = sys.argv[1], sys.argv[2]
M = {"survival": "surv", "foodPerMin": "food", "poisonPerMin": "poison"}
SCOPES = ("bigger", "held2", "long", "small")
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
start = load(f"{d}/t-start.json")
names = list(start)
def meta(p, s, n): return json.load(open(f"{d}/{tier}/{p}-s{s}/{n}.meta.json"))
protos = sys.argv[3:] or sorted({f.split(f"t-{tier}-")[1].rsplit("-s", 1)[0] for f in os.listdir(d) if f.startswith(f"t-{tier}-") and f.endswith(".json")})
runs, keepinfo = {}, {}
for p in protos:
    base = p[:-2] if p.endswith("+r") else p
    r = {s: load(f"{d}/t-{tier}-{base}-s{s}.json") for s in SEEDS if os.path.exists(f"{d}/t-{tier}-{base}-s{s}.json")}
    if not r: continue
    if p.endswith("+r") or p.endswith("+rb"):
        keep = {s: {n: (lambda m: m["rescore"]["kept"] > m["rescore"]["start"])(meta(base, s, n)) for n in names} for s in r}
        r = {s: {n: (r[s][n] if keep[s][n] else start[n]) for n in names} for s in r}
        keepinfo[p] = sum(v for s in keep for v in keep[s].values()), sum(len(keep[s]) for s in keep)
    runs[p] = r
def cell(vals): return f"{st.median(vals):.2f} ({min(vals):.2f}, {max(vals):.2f})"
print(f"## {tier}: median (min, max) over {len(names)} starts of the seed-mean, seeds {SEEDS}")
print("| protocol | " + " | ".join(f"{sc} {M[m]}" for sc in SCOPES for m in M) + " |")
print("|---" * (1 + 12) + "|")
print("| start | " + " | ".join(cell([mean(start[n][sc][m]) for n in names]) for sc in SCOPES for m in M) + " |")
for p, r in runs.items():
    print(f"| {p} | " + " | ".join(cell([mean([mean(r[s][n][sc][m]) for s in r]) for n in names]) for sc in SCOPES for m in M) + " |")
for p, (k, t) in keepinfo.items(): print(f"\n{p}: kept brain chosen in {k} of {t} start-seed cells")
for p, r in runs.items():
    print(f"\n### {tier} {p} minus start ({len(r)} seeds)")
    print("| scope | metric | min | median | max | up | down | seed agree |")
    print("|---|---|--:|--:|--:|--:|--:|--:|")
    for sc in SCOPES:
        for m, lab in M.items():
            pooled, agree, means = [], 0, []
            for n in names:
                per = {s: [x - y for x, y in zip(r[s][n][sc][m], start[n][sc][m])] for s in r}
                sm = [mean(per[s]) for s in r]
                agree += all((x > 0) == (sm[0] > 0) for x in sm) and any(x != 0 for x in sm)
                pooled.append(ci([v for s in r for v in per[s]])); means.append(mean(sm))
            print(f"| {sc} | {lab} | {min(means):+.2f} | {st.median(means):+.2f} | {max(means):+.2f} | {sum(q[1] > 0 for q in pooled)} | {sum(q[2] < 0 for q in pooled)} | {agree}/{len(names)} |")
    print("\nper start, long food / long surv / bigger surv (seed-mean minus start): " + ", ".join(f"{n} {mean([mean(r[s][n]['long']['foodPerMin']) for s in r]) - mean(start[n]['long']['foodPerMin']):+.1f}/{mean([mean(r[s][n]['long']['survival']) for s in r]) - mean(start[n]['long']['survival']):+.2f}/{mean([mean(r[s][n]['bigger']['survival']) for s in r]) - mean(start[n]['bigger']['survival']):+.2f}" for n in names))
