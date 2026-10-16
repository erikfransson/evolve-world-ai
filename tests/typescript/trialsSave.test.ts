import { Brain } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { lineageName } from "../../src/typescript/src/live/founders.ts";
import { validName } from "../../src/typescript/src/live/add.ts";
import { KINDS, genomeLengthFor, parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { ecoSizes, trialsSizes } from "../../src/typescript/src/sim/seedPool.ts";
import { CREATURE_RAY_FEATURE_LABELS, RAY_FEATURES, planOf } from "../../src/typescript/src/sim/sensors.ts";
import { trialsCreatureFile, trialsFileName } from "../../src/typescript/src/ui/trialsSave.ts";
import type { GenerationMessage } from "../../src/typescript/src/worker/protocol.ts";
import { testRng } from "./helpers.ts";

// A real (small) Trials run, two generations, and the message the page would hold for the second one.
const config = withOverrides(DEFAULT_CONFIG, { seed: 7, population: { size: 12 }, world: { width: 600, height: 400 }, brain: { hiddenLayers: [6, 5], memory: 0.25 }, creature: { rayCount: 5, startEnergy: 20 } });

async function run(): Promise<GenerationMessage> {
  const evo = new Evolution(config);
  let last: Awaited<ReturnType<Evolution["runGeneration"]>> | null = null;
  for (let g = 0; g < 2; g++) last = await evo.runGeneration();
  const { result, population } = last!;
  return { type: "generation", result, bestEver: evo.bestEver, genomes: population.data, genomeLength: population.genomeLength, populationSize: population.size, trajectories: [] } as unknown as GenerationMessage;
}

describe("Trials best creature file", () => {
  it("is a creature file the Arena and Live parsers accept, with Trials in its metadata", async () => {
    const m = await run();
    const file = trialsCreatureFile(config, m, "2026-10-16");
    const parsed = parseCreatureFile(JSON.stringify(file));
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed).toEqual(file);
    // Live "Add your creature" takes foragers whose name is a lineage name and whose rays fan out (readFile in live/addPanel.ts).
    expect(parsed.kind).toBe("forager");
    expect(validName(lineageName(parsed.name))).toBe(true);
    expect(parsed.plan.raySpread).toBeGreaterThan(0);
    expect(parsed.genome).toHaveLength(genomeLengthFor("forager", parsed.plan));
    expect(parsed.plan).toEqual(planOf(config));
    expect(parsed.training).toEqual({ envs: ["trials"], iterations: m.result.generation, from: expect.stringContaining(`Trials gen ${m.result.generation}, `), heldStart: null, heldEnd: null, date: "2026-10-16" });
    expect(parsed.training.from).toMatch(/seed 7, pop 12, food 0\.7, poison 0\.1$/);
    expect(trialsFileName(m)).toBe(`trials-gen${m.result.generation}-fitness${Math.round(m.result.bestFitness)}.json`);
    expect(KINDS[parsed.kind].world).toBe("ecosystem");
  });

  it("decides like the Trials creature for the same inputs, whatever the creature features hold", async () => {
    const m = await run();
    const file = trialsCreatureFile(config, m);
    const parsed = parseCreatureFile(JSON.stringify(file));
    if (typeof parsed === "string") throw new Error(parsed);
    const plan = planOf(config);
    const original = m.genomes.slice(m.result.bestIndex * m.genomeLength, (m.result.bestIndex + 1) * m.genomeLength);
    const rounded = original.map((v) => Math.round(v * 1000) / 1000); // the file keeps 3 decimals
    const nIn = trialsSizes(plan)[0]!;
    const F = CREATURE_RAY_FEATURE_LABELS.length;
    const rng = testRng(3);
    const trials = new Brain(trialsSizes(plan), rounded);
    const trialsRaw = new Brain(trialsSizes(plan), original);
    const loaded = new Brain(ecoSizes(plan), Float32Array.from(parsed.genome));
    for (let trial = 0; trial < 20; trial++) {
      const tIn = Float32Array.from({ length: nIn }, () => (rng.next() < 0.3 ? 0 : rng.next() * 2 - 1));
      const eIn = new Float32Array(ecoSizes(plan)[0]!);
      for (let i = 0; i < nIn; i++) eIn[i < plan.rayCount * RAY_FEATURES ? Math.floor(i / RAY_FEATURES) * F + (i % RAY_FEATURES) : i + plan.rayCount * (F - RAY_FEATURES)] = tIn[i]!;
      for (let r = 0; r < plan.rayCount; r++) eIn[r * F + RAY_FEATURES] = eIn[r * F + RAY_FEATURES + 1] = rng.next();
      const [a, b, c] = [0, 1, 2].map(() => new Float32Array(2 + plan.memoryShort + plan.memoryLong));
      trials.forward(tIn, a!);
      loaded.forward(eIn, b!);
      trialsRaw.forward(tIn, c!);
      expect(Array.from(b!)).toEqual(Array.from(a!)); // exact against the rounded genome
      b!.forEach((v, k) => expect(Math.abs(v - c![k]!)).toBeLessThan(0.05)); // and the rounding itself changes little
    }
  });
});
