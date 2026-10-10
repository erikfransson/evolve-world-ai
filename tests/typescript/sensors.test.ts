import { layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, memoryUnits } from "../../src/typescript/src/sim/config.ts";
import { CREATURE_RAY_FEATURE_LABELS, EXTRA_INPUTS, INPUT_EXTRA_LABELS, OUTPUT_LABELS, OUTPUT_SIZE, RAY_FEATURES, encodeInputs, energySignal, inputLayout, inputSize, planOf, planUpkeep, thrustCommand } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { CreatureState, RayHit } from "../../src/typescript/src/sim/types.ts";

const cfg = { ...DEFAULT_CONFIG, creature: { ...DEFAULT_CONFIG.creature, rayCount: 4 } };
const c = cfg.creature;

describe("sensors", () => {
  it("thrustCommand brakes only below the threshold and coasts between it and 0", () => {
    expect([-1, -0.51].map((o) => thrustCommand(o, -0.5))).toEqual([-1, -1]);
    expect([-0.5, -0.2, 0].map((o) => thrustCommand(o, -0.5))).toEqual([0, 0, 0]);
    expect(thrustCommand(0.7, -0.5)).toBe(0.7);
  });

  it("sizes follow the layout constants and the plan", () => {
    expect(inputSize({ ...cfg, brain: { ...cfg.brain, memory: 0 } })).toBe(4 * RAY_FEATURES + EXTRA_INPUTS);
    expect(INPUT_EXTRA_LABELS.length).toBe(EXTRA_INPUTS);
    expect(OUTPUT_LABELS.length).toBe(OUTPUT_SIZE);
    const layout = inputLayout({ ...cfg, brain: { ...cfg.brain, memory: 0.5 } }); // 4 + 4 units
    expect([layout.memoryShort, layout.memoryLong, layout.memoryAt]).toEqual([4, 4, 4 * RAY_FEATURES + EXTRA_INPUTS]);
    expect([layout.size, layout.outputs]).toEqual([layout.memoryAt + 8, OUTPUT_SIZE + 8]);
    expect(layout.memoryLabels).toEqual(["s1", "s2", "s3", "s4", "l1", "l2", "l3", "l4"]);
    const plan = { ...planOf(cfg), rayCount: 7, hiddenLayers: [5, 6], memoryShort: 1, memoryLong: 3 };
    expect(layerSizes(cfg, plan)).toEqual([7 * RAY_FEATURES + EXTRA_INPUTS + 4, 5, 6, OUTPUT_SIZE + 4]);
    const eco = { ...cfg, creature: { ...cfg.creature, seesCreatures: true } };
    expect(inputLayout(eco, plan).size).toBe(7 * CREATURE_RAY_FEATURE_LABELS.length + EXTRA_INPUTS + 4);
  });

  it("memoryUnits maps the 0-1 setting to units, the odd one short-term", () => {
    expect([0, 0.25, 0.3125, 0.5, 1, 2].map(memoryUnits)).toEqual([
      { short: 0, long: 0 }, { short: 2, long: 2 }, { short: 3, long: 2 }, { short: 4, long: 4 }, { short: 8, long: 8 }, { short: 8, long: 8 },
    ]);
  });

  it("planUpkeep is the living cost when the other costs are 0, and sensing is linear in ray length", () => {
    const free = { ...cfg, creature: { ...cfg.creature, rayCost: 0, neuronCost: 0 } };
    expect(planUpkeep(planOf(free), free)).toBe(free.creature.livingCost);
    const sensing = { ...cfg, creature: { ...cfg.creature, rayCost: 0.1, neuronCost: 0 } };
    const at = (rayLength: number) => planUpkeep({ ...planOf(sensing), rayLength }, sensing) - c.livingCost;
    expect(at(100)).toBeCloseTo(4 * 0.1, 12);
    expect(at(300)).toBeCloseTo(3 * at(100), 12);
    const brainy = { ...cfg, brain: { ...cfg.brain, memory: 0.5 }, creature: { ...cfg.creature, rayCost: 0, neuronCost: 0.01 } };
    expect(planUpkeep(planOf(brainy), brainy) - c.livingCost).toBeCloseTo(0.01 * (16 + 8), 12);
  });

  it("energySignal squashes into [0, 1)", () => {
    expect(energySignal(0, 50)).toBe(0);
    expect(energySignal(50, 50)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(energySignal(1e6, 50)).toBeLessThan(1.0000001);
  });

  it("encodeInputs one-hot encodes ray kinds and appends the extras", () => {
    const state: CreatureState = { x: 0, y: 0, heading: 0, vx: 30, vy: 7, turnRate: 1.5, energy: 25, alive: true, ticksAlive: 0 };
    const kinds = [HIT_NONE, HIT_FOOD, HIT_POISON, HIT_WALL] as const;
    const rays: RayHit[] = kinds.map((kind, i) => ({ closeness: kind === HIT_NONE ? 0 : 0.25 * i, kind, energy: 0 }));
    const out = new Float32Array(inputSize(cfg));
    encodeInputs(state, rays, cfg, out, Math.cos(state.heading), Math.sin(state.heading));
    expect(Array.from(out.subarray(0, 16))).toEqual([0, 0, 0, 0, 0.25, 1, 0, 0, 0.5, 0, 1, 0, 0.75, 0, 0, 1]);
    expect(out[16]).toBeCloseTo(energySignal(25, c.startEnergy), 6);
    expect(out[17]).toBeCloseTo((30 * c.drag) / c.maxThrust, 6);
    expect(out[18]).toBeCloseTo((7 * c.drag) / c.maxThrust, 6);
    expect(out[19]).toBeCloseTo(1.5 / c.maxTurnRate, 6);
  });
});
