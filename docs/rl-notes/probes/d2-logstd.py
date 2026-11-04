# Usage: python3 d2-logstd.py runs/d2 -- mean over designs and seeds, per variant, of log-std (turn, thrust), KL, grad norm and held-out at 500, 1000, 2000 updates
import sys, glob, re
import pandas as pd
d = sys.argv[1]
rows = []
for f in sorted(glob.glob(f"{d}/*-s*/*.csv")):
    v, s = re.search(r"/([a-e])-s(\d+)/", f).groups()
    df = pd.read_csv(f)
    for it in (500, 1000, 2000):
        w = df[(df.iter > it - 20) & (df.iter <= it)]
        h = df[(df.iter > it - 100) & (df.iter <= it)].dropna(subset=["held"])
        rows.append(dict(v=v, seed=s, design=f.split("/")[-1][:2], it=it, logStd0=w.logStd0.mean(), logStd1=w.logStd1.mean(), kl=w.kl.mean(), grad=w.gradNorm.mean(), held=h.held.mean()))
t = pd.DataFrame(rows)
print(t.groupby(["v", "it"])[["logStd0", "logStd1", "kl", "grad", "held"]].mean().round(2).unstack("it").to_string())
