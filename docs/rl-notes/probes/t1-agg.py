import json,glob,re,statistics as st,collections
T='/tmp/claude-1000/-home-erik-progs-evolve-world-ai/9b5abbad-4dc2-4d80-9b43-9341a2efeec2/scratchpad/t1/'
g=collections.defaultdict(list)
for f in sorted(glob.glob(T+'F-*.txt')):
    m=re.match(r'F-(.*)-s(\d)\.txt',f.split('/')[-1]); key=m.group(1)
    lines=[json.loads(l) for l in open(f) if l.startswith('{')]
    end=[l for l in lines if l.get('end')]
    if not end: continue
    e=end[0]; g[key].append((e['start'],e['heldDet'],e['heldStoch'],e['iter'],max([l.get('kl',0) for l in lines]+[0])))
for k,v in g.items():
    d=[x[1]-x[0] for x in v]
    print(f"{k:28s} n={len(v)} start={v[0][0]:.2f} end={' '.join(f'{x[1]:.2f}' for x in v)} d_mean={st.mean(d):+.2f} stoch_end={st.mean(x[2] for x in v):.2f} iters={'/'.join(str(x[3]) for x in v)}")
