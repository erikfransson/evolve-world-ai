// Scores creatures on a held-out transfer battery: Live-like "bigger" envs, a few small forager envs and one long Live-like episode,
// on seeds that never met training, reporting survival, food and poison per minute alive and end energy (not the training reward).
// Usage: node src/rlTransfer.ts --from panel [--from panel:DIR | founders | founder:Grazer | random:1 | pool:N | file:creature.json | learner:PATH] [--seeds 64]
//        [--threads 2] [--label NAME] [--out transfer.json] [--baseline transfer-base.json [--baseline-name NAME]]
// panel is the 8 untrained designs of designPanel.ts; panel:DIR the same designs with weights read from DIR/<design id>.json (rlPanelTrain.ts output).
// --baseline pairs every genome with the baseline genome of the same name (else the first, or --baseline-name): paired t over seeds,
// mean over envs, per design, then min, median and max over designs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner } from "./sim/rl/env.ts";
import type { Learner, Library } from "./sim/rl/env.ts";
import { fileLearner, parseCreatureFile } from "./sim/rl/creatureFile.ts";
import { DESIGN_PANEL, designLearner } from "./sim/rl/designPanel.ts";
import { checkLearner, parseLibrary } from "./sim/rl/library.ts";
import { METRICS, TRANSFER_BASE, batteryEnvs, median, pairedDifference, summarise, transferEpisode, transferSeeds } from "./sim/rl/transfer.ts";
import type { Ci, GenomeResult, Metric, PerSeed } from "./sim/rl/transfer.ts";

interface Job {
  learners: Learner[];
  seeds: number[];
  tasks: [number, number, number][]; // genome, env, seed index
  poolPath: string;
  libraryPath: string;
}
type Row = Record<Metric, number>;

const fileHash = (path: string): string | null => (existsSync(path) ? createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 12) : null);
const loadPool = (path: string): PoolEntry[] | null => (existsSync(path) ? parsePool(JSON.parse(readFileSync(path, "utf8"))).entries : null);
const loadLibrary = (path: string): Library => parseLibrary(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

if (!isMainThread) {
  // Worker: plays its share of the episodes.
  const job = workerData as Job;
  const pool = loadPool(job.poolPath);
  const library = loadLibrary(job.libraryPath);
  const envs = batteryEnvs();
  parentPort!.postMessage(job.tasks.map(([g, e, s]) => transferEpisode(envs[e]!.env, job.learners[g]!, job.seeds[s]!, pool, library)));
} else {
  await main();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: "string", multiple: true },
      seeds: { type: "string", default: "64" },
      threads: { type: "string", default: "2" },
      pool: { type: "string", default: "public/pool.json" },
      library: { type: "string", default: "public/rl/library.json" },
      founders: { type: "string", default: "public/live-founders.json" },
      out: { type: "string" },
      label: { type: "string", default: "" },
      baseline: { type: "string" },
      "baseline-name": { type: "string" },
    },
  });
  const fail = (msg: string): never => {
    console.error(`error: ${msg}`);
    process.exit(1);
  };
  const count = Number(values.seeds), threads = Number(values.threads);
  if (!Number.isInteger(count) || count < 2) fail("--seeds must be an integer of at least 2");
  if (!Number.isInteger(threads) || threads < 1) fail("--threads must be a positive integer");
  const specs = values.from?.length ? values.from : fail("give at least one --from (founders, founder:NAME, random:SEED, pool:N, file:PATH)");
  const pool = loadPool(values.pool!);

  const foundersFile = (): { name: string; entry: unknown }[] => {
    const d = JSON.parse(readFileSync(values.founders!, "utf8")) as { founders?: { name?: string }[] };
    return (d.founders ?? []).map((f) => ({ name: String(f.name), entry: f }));
  };
  const named: { name: string; source: string; learner: Learner }[] = [];
  const checked = (name: string, entry: unknown): Learner => {
    const l = checkLearner(entry, "ecosystem");
    return typeof l === "string" ? fail(`${name}: ${l}`) : l;
  };
  for (const spec of specs) {
    const [kind, arg = ""] = spec.split(/:(.*)/);
    if (kind === "panel") {
      for (const design of DESIGN_PANEL) {
        if (!arg) named.push({ name: design.id, source: "panel (untrained)", learner: designLearner(design) });
        else {
          const file = resolve(arg, `${design.id}.json`);
          named.push({ name: design.id, source: `panel:${arg}`, learner: checked(design.id, JSON.parse(readFileSync(file, "utf8"))) });
        }
      }
    } else if (kind === "learner") {
      const name = arg.replace(/^.*\//, "").replace(/\.json$/, "");
      named.push({ name, source: arg, learner: checked(name, JSON.parse(readFileSync(resolve(arg), "utf8"))) });
    } else if (kind === "founders") for (const f of foundersFile()) named.push({ name: f.name, source: `${values.founders}`, learner: checked(f.name, f.entry) });
    else if (kind === "founder") {
      const f = foundersFile().find((x) => x.name === arg) ?? fail(`no founder "${arg}"`);
      named.push({ name: f.name, source: `${values.founders}`, learner: checked(f.name, f.entry) });
    } else if (kind === "random") named.push({ name: spec, source: spec, learner: randomLearner({ world: "ecosystem", role: 0 }, Number(arg)) });
    else if (kind === "pool") {
      const entry = pool?.[Number(arg)] ?? fail(`no pool entry ${arg}`);
      named.push({ name: spec, source: spec, learner: poolLearner({ world: "ecosystem" }, entry) });
    } else if (kind === "file") {
      const f = parseCreatureFile(readFileSync(resolve(arg), "utf8"));
      if (typeof f === "string") fail(`${arg}: ${f}`);
      else named.push({ name: f.name, source: arg, learner: fileLearner(f) });
    } else fail(`unknown --from "${spec}"`);
  }

  const envs = batteryEnvs();
  const groups = Object.fromEntries(envs.map((e) => [e.env.id, e.group]));
  const seeds = transferSeeds(count);
  const tasks: [number, number, number][] = [];
  for (let g = 0; g < named.length; g++) for (let e = 0; e < envs.length; e++) for (let s = 0; s < count; s++) tasks.push([g, e, s]);
  const t0 = performance.now();
  const rows = new Array<Row>(tasks.length);
  const share = (w: number): number[] => tasks.map((_, i) => i).filter((i) => i % threads === w);
  const parts = await Promise.all(
    Array.from({ length: threads }, (_, w) => {
      const mine = share(w);
      const job: Job = { learners: named.map((n) => n.learner), seeds, tasks: mine.map((i) => tasks[i]!), poolPath: values.pool!, libraryPath: values.library! };
      return new Promise<Row[]>((ok, bad) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: job });
        worker.on("message", ok);
        worker.on("error", bad);
      }).then((out) => ({ mine, out }));
    }),
  );
  for (const { mine, out } of parts) mine.forEach((i, k) => (rows[i] = out[k]!));
  const wall = (performance.now() - t0) / 1000;

  const results: GenomeResult[] = named.map((n, g) => ({
    name: n.name,
    source: n.source,
    envs: Object.fromEntries(
      envs.map((e, ei) => {
        const per = Object.fromEntries(METRICS.map((m) => [m, Array.from({ length: count }, (_, s) => rows[(g * envs.length + ei) * count + s]![m])])) as PerSeed;
        return [e.env.id, per];
      }),
    ),
  }));
  const f = (x: number, d = 2): string => x.toFixed(d);
  const sum = results.map((r) => ({ name: r.name, ...summarise(r, groups) }));
  console.log(`transfer battery${values.label ? ` [${values.label}]` : ""}: ${named.length} genomes x ${envs.length} envs x ${count} seeds (base ${TRANSFER_BASE}), ${threads} threads, ${f(wall, 1)} s wall`);
  console.log("scope small = competence (food, poison, time to first food); bigger and long = Live-like survival. Means over envs and seeds.");
  const cols: [string, Metric, number][] = [["survival", "survival", 2], ["died", "died", 2], ["food/min", "foodPerMin", 2], ["poison/min", "poisonPerMin", 2], ["first s", "firstFood", 1], ["clear s", "clearTime", 1], ["poisonE", "poisonEnergy", 1], ["endE", "energy", 1]];
  const line = (a: string[]): string => a.map((x, i) => (i < 2 ? x.padEnd(i ? 8 : 16) : x.padStart(10))).join(" ");
  console.log(line(["genome", "scope", ...cols.map((c) => c[0])]));
  const scopes = (s: (typeof sum)[number]): [string, Row][] => [["all", s.all], ...Object.entries(s.byGroup)] as [string, Row][];
  const rowOf = (name: string, scope: string, m: Row): string => line([name, scope, ...cols.map(([, k, d]) => f(m[k], d))]);
  for (const s of sum) for (const [scope, m] of scopes(s)) console.log(rowOf(s.name, scope, m));
  if (sum.length >= 3) {
    console.log("spread over genomes:");
    for (const scope of ["all", ...Object.keys(sum[0]!.byGroup)]) {
      const at = (s: (typeof sum)[number]): Row => (scope === "all" ? s.all : s.byGroup[scope]!);
      for (const [label, agg] of [["min", Math.min], ["median", median], ["max", Math.max]] as const) {
        console.log(rowOf(label, scope, Object.fromEntries(METRICS.map((k) => [k, agg(...sum.map((s) => at(s)[k]))])) as Row));
      }
    }
  }

  let paired: { genome: string; baseline: string; diff: ReturnType<typeof pairedDifference> }[] | undefined;
  if (values.baseline) {
    const base = JSON.parse(readFileSync(resolve(values.baseline), "utf8")) as { seedBase: number; seedCount: number; genomes: GenomeResult[] };
    if (base.seedBase !== TRANSFER_BASE) fail("baseline used other seeds");
    const fallback = (values["baseline-name"] ? base.genomes.find((x) => x.name === values["baseline-name"]) : base.genomes[0]) ?? fail("baseline genome not found");
    paired = results.map((r) => {
      const b = base.genomes.find((x) => x.name === r.name) ?? fallback;
      return { genome: r.name, baseline: b.name, diff: pairedDifference(r, b, groups) };
    });
    const ci = (c: Ci, d: number): string => `${c.mean >= 0 ? "+" : ""}${f(c.mean, d)} [${f(c.lo, d)}, ${f(c.hi, d)}]`;
    console.log(`\npaired difference to baseline ${values.baseline} (paired over ${Math.min(count, base.seedCount)} seeds, mean over envs, 95% CI)`);
    const pcols = cols.slice(0, 6).filter((c) => c[1] !== "died");
    for (const scope of ["all", "small", "bigger", "long"]) {
      console.log(`scope ${scope}: ${pcols.map((c) => c[0]).join(" | ")}`);
      for (const p of paired) {
        const d = scope === "all" ? p.diff.all : p.diff.byGroup[scope];
        if (d) console.log(`  ${p.genome.padEnd(16)} ${pcols.map(([, k, dd]) => ci(d[k], dd === 1 ? 1 : 2)).join(" | ")}`);
      }
      if (paired.length >= 3) {
        for (const [, k] of pcols) {
          const ms = paired.map((p) => (scope === "all" ? p.diff.all : p.diff.byGroup[scope]!)[k].mean);
          const up = paired.filter((p) => (scope === "all" ? p.diff.all : p.diff.byGroup[scope]!)[k].lo > 0).length;
          const down = paired.filter((p) => (scope === "all" ? p.diff.all : p.diff.byGroup[scope]!)[k].hi < 0).length;
          console.log(`  ${k.padEnd(13)} over designs: min ${f(Math.min(...ms), 3)}, median ${f(median(...ms), 3)}, max ${f(Math.max(...ms), 3)}; CI above 0 in ${up}, below 0 in ${down} of ${paired.length}`);
        }
      }
    }
  }
  if (values.out) {
    const out = { format: "evolve-transfer-battery", version: 1, label: values.label, assets: { pool: fileHash(values.pool!), library: fileHash(values.library!) }, seedBase: TRANSFER_BASE, seedCount: count, wallSeconds: wall, threads, envs: envs.map((e) => ({ id: e.env.id, group: e.group })), metrics: METRICS, genomes: results, summary: sum, paired };
    writeFileSync(resolve(values.out), JSON.stringify(out, (_, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)) + "\n"); // 4 decimals keep the file small
  }
}
