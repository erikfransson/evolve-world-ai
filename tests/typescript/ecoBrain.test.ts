import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { inputLayout, planOf, planUpkeep } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { buildSelectedBrain } from "../../src/typescript/src/ui/ecoBrain.ts";
import { formatPlan } from "../../src/typescript/src/ui/ecoPage.ts";
import type { SelectedDetails } from "../../src/typescript/src/worker/ecoProtocol.ts";

const config = DEFAULT_ECO_CONFIG;

function details(plan: BodyPlan): SelectedDetails {
  const genome = randomGenome(layerSizes(config, plan), createRng(5));
  return {
    id: 1, alive: true, x: 0, y: 0, heading: 0, energy: 50, age: 0, children: 0, eaten: 0, depth: 0, parentId: -1, hue: 0, plan, upkeep: planUpkeep(plan, config),
    rayKinds: new Uint8Array(plan.rayCount), rayCloseness: new Float32Array(plan.rayCount), rayEnergy: new Float32Array(plan.rayCount), rayOffsets: new Float32Array(plan.rayCount),
    inputs: new Float32Array(inputLayout(config, plan).size), genome,
  };
}

describe("buildSelectedBrain", () => {
  const plans: BodyPlan[] = [
    { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [5], memoryShort: 0, memoryLong: 0 },
    { rayCount: 11, raySpread: 4, rayLength: 220, hiddenLayers: [20, 7], memoryShort: 3, memoryLong: 1 },
  ];

  it.each(plans)("sizes brain, layout and output buffer by the creature's plan", (plan) => {
    const d = details(plan);
    const b = buildSelectedBrain(config, d);
    const layout = inputLayout(config, plan);
    expect(b.brain.sizes).toEqual([layout.size, ...plan.hiddenLayers, layout.outputs]);
    expect(b.brain.genome.length).toBe(genomeLength(b.brain.sizes));
    expect(b.layout).toEqual(layout);
    expect(b.out.length).toBe(2 + plan.memoryShort + plan.memoryLong);
    expect(b.out.length).toBe(b.brain.sizes.at(-1)); // memory targets included, the panel draws them
    b.brain.forward(d.inputs, b.out); // must not throw or write out of range
    expect(Array.from(b.out).every(Number.isFinite)).toBe(true);
  });

  it("differs from the config plan's brain, which the old page would have built", () => {
    const b = buildSelectedBrain(config, details(plans[1]!));
    expect(b.brain.sizes).not.toEqual(layerSizes(config, planOf(config)));
  });
});

describe("formatPlan", () => {
  it("lists rays, angle, range, layers, memory and upkeep", () => {
    const plan: BodyPlan = { rayCount: 8, raySpread: (75 * Math.PI) / 180, rayLength: 100, hiddenLayers: [16], memoryShort: 2, memoryLong: 2 };
    expect(formatPlan(plan, 0.451)).toBe("8 rays · 75° · 100 range · 16 hidden · mem 2+2 · upkeep 0.45/s");
    expect(formatPlan({ ...plan, rayCount: 1, hiddenLayers: [12, 6], memoryShort: 0, memoryLong: 0 }, 1)).toBe("1 ray · 75° · 100 range · 12+6 hidden · no mem · upkeep 1.00/s");
  });
});
