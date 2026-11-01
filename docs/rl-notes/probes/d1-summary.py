# Usage: python3 d1-summary.py diag.csv [bins=6]  -- mean of each diagnostic over equal slices of the run
import sys
import pandas as pd
df = pd.read_csv(sys.argv[1])
bins = int(sys.argv[2]) if len(sys.argv) > 2 else 6
df["slice"] = pd.cut(df.index, bins, labels=False)
cols = [c for c in df.columns if c not in ("slice", "episodes", "seconds", "samples", "epochs") and not c.startswith("held_")]
out = df.groupby("slice")[cols].mean()
out["iter"] = df.groupby("slice")["iter"].last()
out["held"] = df.dropna(subset=["held"]).groupby(pd.cut(df.dropna(subset=["held"]).index, bins, labels=False))["held"].mean()
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
print(out.round(3).T.to_string())
