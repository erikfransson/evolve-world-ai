# T8: share of runEpisode CPU per part (setup, sensing, brains, motion, crowd grid, member scans, eat and contacts, episode loop)
# from a node --cpu-prof profile, by the nearest TypeScript frame of each sample. Usage: python3 t8-cpuprof-split.py file.cpuprofile
import json, sys, collections
p = json.load(open(sys.argv[1])); nodes = {n["id"]: n for n in p["nodes"]}
par = {c: n["id"] for n in p["nodes"] for c in n.get("children", [])}
SETUP = {"Ecosystem", "castFor", "placeLayout", "episodeConfig", "variantFor", "create"}
FILES = {"senser.ts": "sense", "fillKernel.ts": "sense", "residentStep.ts": "sense", "senseKernels.ts": "sense", "sensors.ts": "sense",
         "brainKernel.ts": "brain", "brain.ts": "brain", "stepKernel.ts": "motion", "crowd.ts": "crowd grid", "crowdKernel.ts": "crowd grid",
         "membersKernel.ts": "member scans", "contacts.ts": "eat, contacts", "world.ts": "eat, contacts", "itemEconomy.ts": "eat, contacts", "env.ts": "episode loop"}
cat = collections.Counter(); tot = 0
for sid, dt in zip(p["samples"], p["timeDeltas"]):
    chain = []; x = sid
    while x is not None: chain.append(nodes[x]["callFrame"]); x = par.get(x)
    names = [c["functionName"] for c in chain]
    if "runEpisode" not in names: continue
    tot += dt
    upto = chain[: names.index("runEpisode") + 1]
    if any(c["functionName"] in SETUP for c in upto): cat["setup"] += dt; continue
    for c in upto:
        f = c["url"].split("/")[-1]
        if f.endswith(".ts"):
            cat[FILES.get(f, "other " + f if f != "ecosystem.ts" else "eat, contacts")] += dt; break
print(f"runEpisode {tot/1000:.0f} ms: " + ", ".join(f"{k} {100*v/tot:.0f}%" for k, v in cat.most_common()))
