// Usage (in src/typescript): node ../../docs/rl-notes/probes/b2-score.ts SPEC DIR|start OUT.json [SEEDS=64] -- the transfer battery (as b1-score.ts) on the B2 trained starts
// (SPEC as rlStarts.ts) from DIR/<start name>.json; "start" scores the starts themselves (protocol (a), no training). Same file layout as rlTransfer.ts, one thread.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { checkLearner, parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { loadStarts } from "../../../src/typescript/src/rlStarts.ts";
import { METRICS, batteryEnvs, transferEpisode, transferSeeds } from "../../../src/typescript/src/sim/rl/transfer.ts";

const [spec, dir, out, n = "64"] = process.argv.slice(2);
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const library = parseLibrary(existsSync("public/rl/library.json") ? JSON.parse(readFileSync("public/rl/library.json", "utf8")) : null);
const seeds = transferSeeds(Number(n));
const envs = batteryEnvs();
const genomes = loadStarts(spec!).map((s) => {
  let l = s.learner;
  if (dir !== "start") { const c = checkLearner(JSON.parse(readFileSync(resolve(dir!, `${s.name}.json`), "utf8")), "ecosystem"); if (typeof c === "string") throw new Error(`${s.name}: ${c}`); l = c; }
  const per = Object.fromEntries(envs.map((e) => {
    const rows = seeds.map((sd) => transferEpisode(e.env, l, sd, pool, library));
    return [e.env.id, Object.fromEntries(METRICS.map((m) => [m, rows.map((r) => r[m])]))];
  }));
  return { name: s.name, envs: per };
});
writeFileSync(out!, JSON.stringify({ envs: envs.map((e) => ({ id: e.env.id, group: e.group })), genomes }) + "\n");
