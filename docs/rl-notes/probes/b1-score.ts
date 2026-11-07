// Usage (in src/typescript): node ../../docs/rl-notes/probes/b1-score.ts DIR|untrained OUT.json [SEEDS=64] -- the transfer battery (rlTransfer's envs and seeds) on the 10 B1 bodies
// (the 8 panel designs and p9, p10) from DIR/<design id>.json; "untrained" scores the random starts. Same file layout as rlTransfer.ts, one thread.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { DESIGN_PANEL, designLearner } from "../../../src/typescript/src/sim/rl/designPanel.ts";
import { EXTRA_DESIGNS } from "../../../src/typescript/src/sim/rl/b1Bodies.ts";
import { checkLearner, parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { METRICS, batteryEnvs, transferEpisode, transferSeeds } from "../../../src/typescript/src/sim/rl/transfer.ts";

const [dir, out, n = "64"] = process.argv.slice(2);
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const library = parseLibrary(existsSync("public/rl/library.json") ? JSON.parse(readFileSync("public/rl/library.json", "utf8")) : null);
const seeds = transferSeeds(Number(n));
const envs = batteryEnvs();
const genomes = [...DESIGN_PANEL, ...EXTRA_DESIGNS].map((d) => {
  let l;
  if (dir === "untrained") l = designLearner(d);
  else { const c = checkLearner(JSON.parse(readFileSync(resolve(dir!, `${d.id}.json`), "utf8")), "ecosystem"); if (typeof c === "string") throw new Error(`${d.id}: ${c}`); l = c; }
  const per = Object.fromEntries(envs.map((e) => {
    const rows = seeds.map((s) => transferEpisode(e.env, l, s, pool, library));
    return [e.env.id, Object.fromEntries(METRICS.map((m) => [m, rows.map((r) => r[m])]))];
  }));
  return { name: d.id, envs: per };
});
writeFileSync(out!, JSON.stringify({ envs: envs.map((e) => ({ id: e.env.id, group: e.group })), genomes }) + "\n");
