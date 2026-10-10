import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { Crowd } from "../../src/typescript/src/sim/crowd.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { FEAT_CREATURE, FEAT_SEEN_ENERGY, energySignal, inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_NONE } from "../../src/typescript/src/sim/types.ts";
import { World } from "../../src/typescript/src/sim/world.ts";

type Over = { [K in keyof EcoConfig]?: Partial<EcoConfig[K]> };

// A small world; parts override the defaults per branch.
function ecoCfg(over: Over = {}): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    ...(over.seed !== undefined ? { seed: over.seed as number } : {}),
    world: { ...d.world, width: 1000, height: 1000, ...over.world },
    creature: { ...d.creature, ...over.creature },
    brain: { ...d.brain, ...over.brain },
    eco: { ...d.eco, initialPopulation: 40, ...over.eco },
    mutation: { ...d.mutation, ...over.mutation },
  };
}

// No food and no energy costs: only births change energy.
const still = (eco: Partial<EcoConfig["eco"]>, startEnergy: number): EcoConfig =>
  ecoCfg({
    world: { foodDensity: 0, poisonDensity: 0 },
    creature: { startEnergy, livingCost: 0, thrustCost: 0 },
    eco: { foodRegrow: 0, poisonRegrow: 0, collisions: false, ...eco },
  });

const countKind = (eco: Ecosystem, kind: number) => eco.world.kinds.filter((k) => k === kind).length;

describe("Ecosystem", () => {
  it("is deterministic per seed", () => {
    const run = (seed: number) => {
      const eco = new Ecosystem(ecoCfg({ seed, creature: { startEnergy: 140 } }));
      for (let t = 0; t < 300; t++) eco.step();
      return [eco.fingerprint(), eco.births, eco.deaths];
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)[0]).not.toBe(run(4)[0]);
  });

  it("regrows fractional items over ticks and stops at the max density", () => {
    // 1000 x 1000 is 100 items per density unit: 0.01 regrows one item per second, cap 0.5 is 50 items.
    const eco = new Ecosystem(still({ initialPopulation: 1, foodRegrow: 0.01, foodMaxDensity: 0.5, poisonRegrow: 1, poisonMaxDensity: 0.05 }, 100));
    for (let t = 0; t < 15; t++) eco.step();
    expect(eco.food).toBe(0);
    for (let t = 0; t < 30; t++) eco.step();
    expect(eco.food).toBe(1);
    expect(eco.poison).toBe(5);
    expect(countKind(eco, HIT_FOOD)).toBe(eco.food);
  });

  it("caps food regrowth at foodMaxDensity", () => {
    const eco = new Ecosystem(still({ initialPopulation: 1, foodRegrow: 2, foodMaxDensity: 0.5 }, 100));
    for (let t = 0; t < 60; t++) eco.step();
    expect(eco.food).toBe(50);
    expect(countKind(eco, HIT_FOOD)).toBe(50);
  });

  it("a birth costs the parent birthCost and gives the child childEnergy, launched clear of the parent", () => {
    const c = still({ initialPopulation: 1 }, 160);
    const eco = new Ecosystem(c);
    const parent = eco.members[0];
    eco.step();
    expect(eco.population).toBe(2);
    expect(eco.births).toBe(1);
    const child = eco.members[1];
    expect(parent.creature.state.energy).toBe(160 - c.eco.birthCost);
    expect(child.creature.state.energy).toBe(c.eco.childEnergy);
    expect([child.parentId, child.depth, parent.children]).toEqual([parent.id, 1, 1]);
    const ps = parent.creature.state;
    const cs = child.creature.state;
    expect(Math.hypot(cs.x - ps.x, cs.y - ps.y)).toBeGreaterThan(2 * c.creature.radius);
    expect(Math.hypot(cs.vx, cs.vy)).toBeLessThanOrEqual(c.eco.birthSpeed + 1e-9);
    expect(eco.get(child.id)).toBe(child);
  });

  it("waits birthCooldown between births", () => {
    const eco = new Ecosystem(still({ initialPopulation: 1, birthCooldown: 1 }, 1000)); // 30 ticks
    for (let t = 0; t < 30; t++) eco.step();
    expect(eco.births).toBe(1);
    eco.step();
    expect(eco.births).toBe(2);
  });

  it("births wait at maxPopulation", () => {
    const eco = new Ecosystem(still({ initialPopulation: 2, maxPopulation: 3, birthCooldown: 0 }, 1000));
    for (let t = 0; t < 10; t++) eco.step();
    expect(eco.population).toBe(3);
    expect(eco.births).toBe(1);
  });

  it("flags extinction when everyone has died and then stops", () => {
    const eco = new Ecosystem(ecoCfg({ creature: { startEnergy: 0.01 } }));
    expect(eco.extinct).toBe(false);
    eco.step();
    expect(eco.extinct).toBe(true);
    expect(eco.deaths).toBe(40);
    eco.step();
    expect(eco.tick).toBe(1);
  });

  it("recycles dead creatures' storage under new ids and stays finite over a long run", () => {
    const eco = new Ecosystem(ecoCfg({ creature: { startEnergy: 140 }, eco: { initialPopulation: 60, foodRegrow: 0.3, foodMaxDensity: 2 } }));
    const ids = new Set<number>();
    for (const m of eco.members) ids.add(m.id);
    let frame = eco.readCreatures();
    let finite = true;
    for (let t = 0; t < 1500 && !eco.extinct; t++) {
      eco.step();
      frame = eco.readCreatures(frame);
      for (let i = 0; i < frame.count; i++) finite &&= Number.isFinite(frame.x[i] + frame.y[i] + frame.heading[i] + frame.energy[i]);
      for (const m of eco.members) ids.add(m.id);
    }
    expect(finite).toBe(true);
    expect(eco.births).toBeGreaterThan(0);
    expect(eco.deaths).toBeGreaterThan(0);
    expect(ids.size).toBe(60 + eco.births);
    for (const m of eco.members) expect(Array.from(m.creature.brain.layerActivations().at(-1)!).every(Number.isFinite)).toBe(true);
  });
});

describe("Crowd", () => {
  const c = ecoCfg({ creature: { rayCount: 3 } }); // middle ray straight ahead
  const genome = () => new Float32Array(genomeLength(layerSizes(c)));
  const world = () => new World(c, 4);

  it("rays see the nearest other creature with its energy, and not the viewer", () => {
    const viewer = new Creature(c, genome(), 500, 500, 0);
    const other = new Creature(c, genome(), 560, 500, 0);
    other.state.energy = 80;
    const crowd = new Crowd(c);
    crowd.rebuild([viewer.state, other.state], 2);
    viewer.sense(world(), crowd, 0);
    const ray = viewer.rays[1];
    expect(ray.kind).toBe(HIT_CREATURE);
    expect(ray.closeness).toBeCloseTo(1 - (60 - c.creature.radius) / c.creature.rayLength, 9);
    expect(ray.energy).toBe(80);
    expect(viewer.rays[0].kind).toBe(HIT_NONE);

    const layout = inputLayout(c);
    expect(layout.size).toBe(3 * 6 + 4);
    viewer.think();
    const input = viewer.brain.layerActivations()[0];
    expect(input[layout.rayFeatures + FEAT_CREATURE]).toBe(1);
    expect(input[layout.rayFeatures + FEAT_SEEN_ENERGY]).toBeCloseTo(energySignal(80, c.creature.startEnergy), 6);
  });

  it("a nearer item hides the creature behind it, a farther one does not", () => {
    const viewer = new Creature(c, genome(), 500, 500, 0);
    const other = new Creature(c, genome(), 560, 500, 0);
    const crowd = new Crowd(c);
    crowd.rebuild([viewer.state, other.state], 2);
    const near = world();
    near.addItem(530, 500, HIT_FOOD);
    viewer.sense(near, crowd, 0);
    expect(viewer.rays[1].kind).toBe(HIT_FOOD);
    const far = world();
    far.addItem(590, 500, HIT_FOOD);
    const fresh = new Creature(c, genome(), 500, 500, 0); // a ray cache serves one world
    fresh.sense(far, crowd, 0);
    expect(fresh.rays[1].kind).toBe(HIT_CREATURE);
  });

  it("matches brute force over random crowds", () => {
    const cfg = ecoCfg();
    const g = () => new Float32Array(genomeLength(layerSizes(cfg)));
    const rng = createRng(9);
    const states = Array.from({ length: 300 }, () => new Creature(cfg, g(), rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 7)).state);
    states.forEach((s) => (s.energy = rng.range(1, 200)));
    const crowd = new Crowd(cfg);
    crowd.rebuild(states, states.length);
    const L = cfg.creature.rayLength;
    const r = cfg.creature.radius;
    const empty = new World(cfg, 1);
    let hits = 0;
    for (let v = 0; v < 300; v += 7) {
      const s = states[v];
      const viewer = new Creature(cfg, g(), s.x, s.y, s.heading);
      viewer.sense(empty, crowd, v);
      viewer.rays.forEach((ray, i) => {
        const a = s.heading + viewer.rayOffsets[i];
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let best = Infinity;
        let energy = 0;
        states.forEach((o, k) => {
          if (k === v) return;
          const fx = o.x - s.x;
          const fy = o.y - s.y;
          const c = fx * fx + fy * fy - r * r;
          const b = fx * dx + fy * dy;
          const t = c < 0 ? 0 : b > 0 && b * b >= c ? b - Math.sqrt(b * b - c) : Infinity;
          if (t < best && t < L) {
            best = t;
            energy = o.energy;
          }
        });
        if (ray.kind === HIT_CREATURE) {
          hits++;
          expect(ray.closeness).toBeCloseTo(1 - best / L, 5);
          expect(ray.energy).toBe(energy);
        } else {
          expect(best === Infinity || 1 - best / L <= ray.closeness + 1e-6).toBe(true); // nothing, or a wall nearer
        }
      });
    }
    expect(hits).toBeGreaterThan(20);
  });
});
