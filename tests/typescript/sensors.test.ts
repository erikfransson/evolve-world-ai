import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { EXTRA_INPUTS, INPUT_EXTRA_LABELS, OUTPUT_LABELS, OUTPUT_SIZE, RAY_FEATURES, encodeInputs, energySignal, inputSize, thrustCommand } from "../../src/typescript/src/sim/sensors.ts";
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

  it("sizes follow the layout constants", () => {
    expect(inputSize(cfg)).toBe(4 * RAY_FEATURES + EXTRA_INPUTS);
    expect(INPUT_EXTRA_LABELS.length).toBe(EXTRA_INPUTS);
    expect(OUTPUT_LABELS.length).toBe(OUTPUT_SIZE);
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
