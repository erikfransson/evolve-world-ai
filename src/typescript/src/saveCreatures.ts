// Pulls evolved creatures out of a Live save (server/src/saveParse.ts format) for colonyScore: a sample of each home lineage's living members.
// Usage (in src/typescript/): node src/saveCreatures.ts --save run.m90.save.gz --lineages run.lineages.json --out creatures.json [--per 60] [--seed 1]
// --lineages maps founder id to home realm ({"12": "blight", ...}, as clockProbe seeds them). Lineage is by descent, not by where a creature stands.
// Output: {save, tick, minutes, groups: {realm: [{plan, genome, birth, mutationScale, x, y, energy, depth}]}}, at most --per per realm, drawn at random.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseSave } from "../../../server/src/saveParse.ts";
import { decodeState, SCALARS } from "./sim/ecoState.ts";

const { values } = parseArgs({
  options: {
    save: { type: "string" },
    lineages: { type: "string" },
    out: { type: "string" },
    per: { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
  },
  strict: true,
});
if (!values.save || !values.lineages || !values.out) throw new Error("--save, --lineages and --out are required");

const home = new Map<number, string>(Object.entries(JSON.parse(readFileSync(values.lineages, "utf8")) as Record<string, string>).map(([k, v]) => [Number(k), v]));
const state = await parseSave(new Uint8Array(readFileSync(values.save)), 2 ** 31 - 1);
const d = decodeState(state);
const K = SCALARS.length;
const at = (name: (typeof SCALARS)[number]): number => SCALARS.indexOf(name);

type Out = { plan: { rayCount: number; raySpread: number; rayLength: number; memoryShort: number; memoryLong: number; hiddenLayers: number[] }; genome: number[]; birth: { energy: number; cost: number; cooldown: number }; mutationScale: number; x: number; y: number; energy: number; depth: number };
const groups = new Map<string, Out[]>();
let g = 0;
for (let i = 0; i < d.plans.length; i++) {
  const p = d.plans[i]!;
  const v = (name: (typeof SCALARS)[number]): number => d.scalars[i * K + at(name)]!;
  const realm = home.get(v("founderId")) ?? "added";
  const genome = Array.from(d.genomes.subarray(g, g + p[5]!), (w) => Math.round(w * 1000) / 1000);
  g += p[5]!;
  const list = groups.get(realm) ?? [];
  groups.set(realm, list);
  list.push({
    plan: { rayCount: p[0]!, raySpread: p[1]!, rayLength: p[2]!, memoryShort: p[3]!, memoryLong: p[4]!, hiddenLayers: Array.from(p.slice(6)) },
    genome,
    birth: { energy: v("birthEnergy"), cost: v("birthCost"), cooldown: v("birthCooldown") },
    mutationScale: d.scales.get(i) ?? 1,
    x: v("x"), y: v("y"), energy: v("energy"), depth: v("depth"),
  });
}

// A seeded shuffle, so the same save and seed give the same sample.
let s = Number(values.seed) >>> 0;
const rand = (): number => ((s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0) / 4294967296);
const per = Number(values.per);
const out: Record<string, Out[]> = {};
for (const [realm, list] of groups) {
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j]!, list[i]!]; }
  out[realm] = list.slice(0, per);
  console.log(`${realm}: ${list.length} living, ${out[realm].length} kept`);
}
const tick = d.core.tick;
writeFileSync(values.out, JSON.stringify({ save: values.save, tick, minutes: (tick * d.config.dt) / 60, groups: out }));
