// B2: trained starts for the probes (rlTiers.ts --from, docs/rl-notes/probes/b2-*.ts). SPEC is a comma list of "founders" (every founder
// of public/live-founders.json, named by its lineage, as the Live add panel offers them) and NAME=FILE (a saved learner, as an upload).
import { readFileSync } from "node:fs";
import { parseFounders } from "./live/founders.ts";
import { checkLearner } from "./sim/rl/library.ts";
import type { Learner } from "./sim/rl/env.ts";

export interface NamedStart { name: string; learner: Learner }

export function loadStarts(spec: string, founders = "public/live-founders.json"): NamedStart[] {
  return spec.split(",").filter(Boolean).flatMap((item): NamedStart[] => {
    if (item === "founders") {
      const list = parseFounders(JSON.parse(readFileSync(founders, "utf8")), true);
      if (typeof list === "string") throw new Error(`founders: ${list}`);
      return list.map((f) => ({ name: f.lineage, learner: { plan: f.plan, genome: Float32Array.from(f.genome) } }));
    }
    const [name, file] = item.split("=");
    if (!name || !file) throw new Error(`start "${item}" must be founders or NAME=FILE`);
    const l = checkLearner(JSON.parse(readFileSync(file, "utf8")), "ecosystem");
    if (typeof l === "string") throw new Error(`${name}: ${l}`);
    return [{ name, learner: l }];
  });
}
