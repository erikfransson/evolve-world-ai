import { readFileSync } from "node:fs";
import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { CREATURE_FORMAT, CREATURE_VERSION, KINDS, parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { CreatureKind } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { layoutConfig, poolLearner, randomLearner } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { parseLibrary } from "../../src/typescript/src/sim/rl/library.ts";
import { parsePool } from "../../src/typescript/src/sim/seedPool.ts";
import { inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { FAVOURITES_KEY, loadFavourites } from "../../src/typescript/src/ui/arenaStore.ts";

const json = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../src/typescript/public/${path}`, import.meta.url), "utf8"));

// A creature file as made before the terrain input: the current genome without the input's weight column in every first-layer row.
function oldFile(kind: CreatureKind): { file: Record<string, unknown>; current: number[] } {
  const learner = randomLearner(envById(kind === "forager" ? "minefield" : "hunt-wanderers")!, 5);
  const config = layoutConfig(KINDS[kind].world);
  const sizes = layerSizes(config, learner.plan);
  const at = inputLayout(config, learner.plan).terrainAt;
  const old: number[] = [];
  for (let row = 0; row < sizes[1]!; row++) for (let i = 0; i < sizes[0]!; i++) if (i !== at) old.push(Math.round(learner.genome[row * sizes[0]! + i]! * 1000) / 1000);
  old.push(...Array.from(learner.genome.subarray(sizes[0]! * sizes[1]!), (v) => Math.round(v * 1000) / 1000));
  const file = { format: CREATURE_FORMAT, version: CREATURE_VERSION, kind, name: "old", plan: learner.plan, genome: old, training: {} };
  return { file, current: Array.from(learner.genome, (v) => Math.round(v * 1000) / 1000) };
}

describe("genomes made before the terrain input", () => {
  it.each(["forager", "prey", "predator"] as const)("a %s creature file loads with zero weights for the new input", (kind) => {
    const { file, current } = oldFile(kind);
    const parsed = parseCreatureFile(file);
    expect(typeof parsed).toBe("object");
    if (typeof parsed === "string") return;
    const sizes = layerSizes(layoutConfig(KINDS[kind].world), parsed.plan);
    const at = inputLayout(layoutConfig(KINDS[kind].world), parsed.plan).terrainAt;
    expect(parsed.genome).toHaveLength(genomeLength(sizes));
    for (let row = 0; row < sizes[1]!; row++) expect(parsed.genome[row * sizes[0]! + at]).toBe(0);
    expect(parsed.genome.length).toBe(current.length);
  });

  it("a genome that fits neither layout, or holds non-numbers, is still refused", () => {
    const { file } = oldFile("forager");
    expect(typeof parseCreatureFile({ ...file, genome: (file.genome as number[]).slice(1) })).toBe("string");
    expect(typeof parseCreatureFile({ ...file, genome: [...(file.genome as number[])].map((v, i) => (i === 3 ? "1" : v)) })).toBe("string");
    expect(typeof parseCreatureFile({ ...file, genome: (file.genome as number[]).map((v, i) => (i === 3 ? 1e9 : v)) })).toBe("string");
  });

  it("an old Arena favourite loads from the browser store", () => {
    const { file } = oldFile("forager");
    const store = { getItem: (k: string) => (k === FAVOURITES_KEY ? JSON.stringify([file]) : null), setItem: () => undefined };
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["old"]);
  });

  it("the shipped library keeps every entry", () => {
    const raw = json("rl/library.json") as { envs: Record<string, unknown[]> };
    const lib = parseLibrary(raw);
    for (const [id, list] of Object.entries(raw.envs)) expect(lib[id]).toHaveLength(list.length);
    expect(Object.keys(raw.envs).length).toBeGreaterThan(0);
  });

  it("pool founders become learners in the env's layout", () => {
    const { entries } = parsePool(json("pool.json"));
    expect(entries.length).toBeGreaterThan(0);
    for (const world of ["minefield", "hunt-wanderers"] as const) {
      const env = envById(world)!;
      for (const e of entries.slice(0, 5)) expect(poolLearner(env, e).genome).toHaveLength(genomeLength(layerSizes(layoutConfig(env.world), e.plan)));
    }
  });
});
