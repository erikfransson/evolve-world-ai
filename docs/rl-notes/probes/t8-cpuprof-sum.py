# T8: self time per function (and per file) from a node --cpu-prof profile.
# Usage: python3 t8-cpuprof-sum.py file.cpuprofile [top]
import json, sys, collections
prof = json.load(open(sys.argv[1]))
top = int(sys.argv[2]) if len(sys.argv) > 2 else 30
nodes = {n["id"]: n for n in prof["nodes"]}
dts = prof["timeDeltas"]
self_t = collections.Counter()
for sid, dt in zip(prof["samples"], dts):
    self_t[sid] += dt
by_fn = collections.Counter(); by_file = collections.Counter()
for nid, t in self_t.items():
    cf = nodes[nid]["callFrame"]
    f = cf["url"].split("/")[-1] or "(native)"
    by_fn[f"{cf['functionName'] or '(anon)'} {f}:{cf['lineNumber']+1}"] += t
    by_file[f] += t
tot = sum(self_t.values())
print(f"total {tot/1000:.0f} ms")
for k, v in by_file.most_common(15): print(f"{100*v/tot:5.1f}%  {k}")
print()
for k, v in by_fn.most_common(top): print(f"{100*v/tot:5.1f}%  {k}")
