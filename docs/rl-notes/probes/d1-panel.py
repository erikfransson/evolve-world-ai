# Usage: python3 d1-panel.py runs/d1 tag [tag ...]  -- per design: start, peak, final held (mean of last 4 checks), final log-std, iterations; then min/median/max over designs
import sys, glob
import pandas as pd
d = sys.argv[1]
for tag in sys.argv[2:]:
    rows = []
    for p in range(1, 9):
        try: df = pd.read_csv(f"{d}/panel-{tag}-p{p}.csv")
        except FileNotFoundError: continue
        h = df.dropna(subset=["held"])
        rows.append(dict(design=f"p{p}", first=h.held.iloc[0], peak=h.held.max(), final=h.held.iloc[-4:].mean(), logStd0=df.logStd0.iloc[-50:].mean(), logStd1=df.logStd1.iloc[-50:].mean(), gradNorm=df.gradNorm.iloc[-50:].mean(), iters=int(df.iter.iloc[-1])))
    t = pd.DataFrame(rows)
    print(f"== {tag}"); print(t.round(2).to_string(index=False))
    if len(t): print("final min/median/max: %.2f %.2f %.2f   mean %.2f" % (t.final.min(), t.final.median(), t.final.max(), t.final.mean()))
