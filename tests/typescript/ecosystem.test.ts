import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import type { CreatureState } from "../../src/typescript/src/sim/types.ts";
import { Crowd } from "../../src/typescript/src/sim/crowd.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { DEFAULT_ECO_CONFIG, seasonFactor, seasonName } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { trialsSizes } from "../../src/typescript/src/sim/seedPool.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { FEAT_CREATURE, FEAT_SEEN_ENERGY, energySignal, inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_CREATURE, HIT_FOOD, HIT_NONE, HIT_POISON } from "../../src/typescript/src/sim/types.ts";
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
    eco: { ...d.eco, initialPopulation: 40, foundersVary: false, planDrift: 0, structuralRate: 0, ...over.eco },
    mutation: { ...d.mutation, ...over.mutation },
  };
}

// No food and no energy costs: only births change energy.
const still = (eco: Partial<EcoConfig["eco"]>, startEnergy: number): EcoConfig =>
  ecoCfg({
    world: { foodDensity: 0, poisonDensity: 0 },
    creature: { startEnergy, livingCost: 0, thrustCost: 0, turnCost: 0, rayCost: 0, neuronCost: 0 },
    eco: { foodRegrow: 0, poisonRegrow: 0, collisions: false, ...eco },
  });

const countKind = (eco: Ecosystem, kind: number) => eco.world.kinds.filter((k) => k === kind).length;

const poolEntry = (): PoolEntry => {
  const plan = { rayCount: 4, raySpread: 1.2, rayLength: 90, hiddenLayers: [8], memoryShort: 1, memoryLong: 1 };
  return { plan, genome: randomGenome(trialsSizes(plan), createRng(9)), fitness: 60, world: { food: 0.7, poison: 0.1 } };
};

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

  it("no founder spawns on poison, with varied founders and moved poison", () => {
    // Dense poison and many founders: poison moved off one founder often lands on a founder placed before it.
    for (const seed of [1, 2, 3]) {
      const eco = new Ecosystem(ecoCfg({ seed, world: { foodDensity: 0, poisonDensity: 3 }, eco: { initialPopulation: 300, foundersVary: true } }));
      const reach = eco.config.creature.radius + eco.config.world.itemRadius;
      const w = eco.world;
      expect(countKind(eco, HIT_POISON)).toBe(300);
      for (const m of eco.members) {
        for (let i = 0; i < w.count; i++) {
          if (w.kinds[i] === HIT_POISON) expect(Math.hypot(w.xs[i] - m.creature.state.x, w.ys[i] - m.creature.state.y)).toBeGreaterThanOrEqual(reach);
        }
      }
    }
  });

  it("places founders and poison promptly when founders crowd a small world", () => {
    // Guard only: placement drops other-founder rejection after 256 tries, so it cannot loop forever.
    const eco = new Ecosystem(ecoCfg({ world: { width: 500, height: 500, foodDensity: 0, poisonDensity: 3 }, eco: { initialPopulation: 5000, maxPopulation: 5000, foundersVary: true } }));
    const reach = eco.config.creature.radius + eco.config.world.itemRadius;
    const w = eco.world;
    const last = eco.members.at(-1)!.creature.state; // the last founder cleared its own disc
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] === HIT_POISON) expect(Math.hypot(w.xs[i] - last.x, w.ys[i] - last.y)).toBeGreaterThanOrEqual(reach);
    }
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

  it("scales food regrowth by the season multiplier, summer at the start and winter half a year later", () => {
    const eco = DEFAULT_ECO_CONFIG.eco;
    const year = eco.yearMinutes * 60;
    expect(seasonFactor(eco, 0)).toBe(1);
    expect(seasonFactor(eco, year / 2)).toBeCloseTo(eco.winterFood, 12);
    expect(seasonFactor(eco, year)).toBeCloseTo(1, 12);
    expect(seasonFactor(eco, year / 4)).toBeCloseTo((1 + eco.winterFood) / 2, 12);
    expect(["Summer", "Autumn", "Winter", "Spring"].map((_, i) => seasonName(eco, (i * year) / 4))).toEqual(["Summer", "Autumn", "Winter", "Spring"]);
    // 5 s of ticks; 0.01 regrow is 1 item/s on this world, so summer gives about 5 items and a 0.3 winter about 1.5.
    const grown = (seasons: boolean, startMinutes: number) => {
      const e = new Ecosystem(still({ initialPopulation: 1, foodRegrow: 0.01, foodMaxDensity: 0.5, seasons, yearMinutes: 2 }, 100));
      e.tick = Math.round((startMinutes * 60) / e.config.dt);
      for (let t = 0; t < 5 / e.config.dt; t++) e.step();
      return e.food;
    };
    expect(grown(false, 1)).toBeGreaterThanOrEqual(4);
    expect(grown(true, 0)).toBeGreaterThanOrEqual(4);
    expect(grown(true, 1)).toBeLessThanOrEqual(2);
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

  it("clamps founders to maxPopulation and never lets a birth cost the parent all its energy", () => {
    expect(new Ecosystem(still({ initialPopulation: 50, maxPopulation: 10 }, 100)).population).toBe(10);
    const eco = new Ecosystem(still({ initialPopulation: 1, birthEnergy: 60, birthCost: 300 }, 200));
    for (let t = 0; t < 5; t++) eco.step();
    expect(eco.births).toBe(0);
    expect(eco.members[0].creature.state.energy).toBe(200);
  });

  it("flags extinction when everyone has died and then stops", () => {
    const eco = new Ecosystem(ecoCfg({ creature: { startEnergy: 0.01 }, world: { foodDensity: 0 } }));
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

  it("counts eaten food but not poison", () => {
    const place = (kind: typeof HIT_FOOD | typeof HIT_POISON) => {
      const eco = new Ecosystem(still({ initialPopulation: 1, maxPopulation: 1 }, 100));
      const m = eco.members[0]!;
      const { x, y } = m.creature.state;
      (eco.world as World).addItem(x, y, kind);
      if (kind === HIT_FOOD) eco.food++;
      else eco.poison++;
      eco.step();
      return { eco, m };
    };
    const food = place(HIT_FOOD);
    expect(food.eco.food).toBe(0);
    expect(food.m.eaten).toBe(1);
    const poison = place(HIT_POISON);
    expect(poison.eco.poison).toBe(0);
    expect(poison.eco.deaths).toBe(1);
    expect(poison.m.eaten).toBe(0);
  });

  it("non-lethal poison drains energy and is removed like food", () => {
    const cfg = still({ initialPopulation: 1, maxPopulation: 1 }, 100);
    cfg.world.poisonDamage = 30;
    const eco = new Ecosystem(cfg);
    const m = eco.members[0]!;
    const { x, y } = m.creature.state;
    (eco.world as World).addItem(x, y, HIT_POISON);
    eco.poison++;
    eco.step();
    expect(eco.poison).toBe(0);
    expect(countKind(eco, HIT_POISON)).toBe(0);
    expect(eco.deaths).toBe(0);
    expect(m.creature.state.energy).toBeCloseTo(70, 6);
    expect(m.eaten).toBe(0);
  });

  it("varied founders and mutating plans run deterministically, with every creature sized by its own plan", () => {
    const varied = ecoCfg({
      creature: { startEnergy: 140 },
      brain: { memory: 1 },
      eco: { initialPopulation: 60, foodRegrow: 0.3, foodMaxDensity: 2, foundersVary: true, planDrift: 0.05, structuralRate: 0.5 },
    });
    const run = () => {
      const eco = new Ecosystem(varied);
      for (let t = 0; t < 900 && !eco.extinct; t++) eco.step();
      return eco;
    };
    const eco = run();
    expect(eco.fingerprint()).toBe(run().fingerprint());
    expect(eco.births).toBeGreaterThan(0);
    expect(eco.deaths).toBeGreaterThan(0);
    const shapes = new Set<string>();
    for (const m of eco.members) {
      const { plan, brain, rays, memory } = m.creature;
      expect(brain.sizes).toEqual(layerSizes(varied, plan));
      expect(brain.genome.length).toBe(genomeLength(brain.sizes));
      expect([rays.length, memory.length]).toEqual([plan.rayCount, plan.memoryShort + plan.memoryLong]);
      expect(Array.from(brain.layerActivations().at(-1)!).every(Number.isFinite)).toBe(true);
      shapes.add(brain.sizes.join());
    }
    expect(shapes.size).toBeGreaterThan(1);
  });
});

describe("Ecosystem collision damage", () => {
  // Two creatures that touch head-on at the given speeds along x; collideAll runs alone, so nothing else moves energy.
  const pair = (eco: Partial<EcoConfig["eco"]>, ea: number, eb: number, va = 40, vb = -40) => {
    const e = new Ecosystem(still({ initialPopulation: 2, collisions: true, collisionDamage: true, damagePerSpeed: 0.5, birthEnergy: 1e9, ...eco }, 100), null, { journal: true });
    const [a, b] = e.members.map((m) => m.creature.state) as [CreatureState, CreatureState];
    Object.assign(a, { x: 500, y: 500, vx: va, vy: 0, energy: ea });
    Object.assign(b, { x: 520, y: 500, vx: vb, vy: 0, energy: eb });
    const bump = () => (e as unknown as { collideAll(): void }).collideAll();
    return { e, a, b, bump };
  };

  it("costs both 0.5 x the approach speed, in proportion to it", () => {
    for (const v of [10, 40]) {
      const { a, b, bump } = pair({}, 100, 100, v, -v);
      bump();
      expect([a.energy, b.energy]).toEqual([100 - v, 100 - v]); // approach speed 2v
    }
  });

  it("applies once per contact, not every tick of overlap", () => {
    const { a, b, bump } = pair({}, 100, 100);
    bump();
    expect(a.energy).toBe(60);
    bump(); // overlapping or touching, now moving apart
    bump();
    expect([a.energy, b.energy]).toEqual([60, 60]);
  });

  it("gives the survivor the dead one's energy from before the hit", () => {
    const { a, b, bump } = pair({}, 30, 100); // damage 40
    bump();
    expect([a.energy, b.energy]).toEqual([0, 60 + 30]);
  });

  it("gives nothing when both die", () => {
    const { a, b, bump } = pair({}, 30, 35);
    bump();
    expect([a.energy, b.energy]).toEqual([0, 0]);
  });

  it("is off by default and then changes no energy", () => {
    expect(DEFAULT_ECO_CONFIG.eco.collisionDamage).toBe(false);
    const { a, b, bump } = pair({ collisionDamage: false }, 100, 100);
    bump();
    expect([a.energy, b.energy]).toEqual([100, 100]);
  });

  it("removes a creature killed by a bounce through the normal path", () => {
    const { e, a, b } = pair({}, 30, 100, 45, -45);
    const [idA, idB] = e.members.map((m) => m.id) as [number, number];
    e.step();
    expect([e.population, e.deaths]).toEqual([1, 1]);
    expect(e.journal!.died).toEqual([idA]);
    expect([e.lineageSize(idA), e.lineageSize(idB)]).toEqual([0, 1]);
    expect(b.energy).toBeGreaterThan(30);
    expect(a).toBeDefined();
  });

  it("with damage off the run is unchanged (fingerprint recorded before the feature)", () => {
    const eco = new Ecosystem(ecoCfg({ seed: 7, world: { width: 600, height: 600 }, creature: { startEnergy: 100 }, eco: { initialPopulation: 80, birthEnergy: 120, collisions: true, wasm: false } })); // JS path, as when recorded
    for (let t = 0; t < 300; t++) eco.step();
    expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([787898088, 0, 1]); // recorded before collision damage existed
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
    expect(layout.size).toBe(3 * 6 + 4 + 4); // rays x features, extras, memory (0.25: 2 + 2 units)
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

describe("Ecosystem lineages and aging", () => {
  describe("lineages", () => {
    const busy = (extra: Partial<EcoConfig["eco"]> = {}) =>
      new Ecosystem(ecoCfg({ creature: { startEnergy: 140 }, eco: { initialPopulation: 30, foodRegrow: 0.3, foodMaxDensity: 2, ...extra } }));
    const recount = (eco: Ecosystem) => {
      const counts = new Map<number, number>();
      for (const m of eco.members) counts.set(m.founderId, (counts.get(m.founderId) ?? 0) + 1);
      return counts;
    };

    it("founders are their own founder, children inherit it", () => {
      const eco = busy();
      for (const m of eco.members) expect(m.founderId).toBe(m.id);
      expect(eco.founders).toBe(30);
      let descendants = 0;
      for (let t = 0; t < 1500 && !eco.extinct; t++) {
        eco.step();
        if (t % 50 !== 0) continue;
        for (const m of eco.members) {
          expect(m.founderId).toBeLessThan(30);
          if (m.depth === 0) expect(m.founderId).toBe(m.id);
          else descendants++;
          const parent = eco.get(m.parentId);
          if (parent) expect(parent.founderId).toBe(m.founderId);
        }
      }
      expect(eco.births).toBeGreaterThan(0);
      expect(descendants).toBeGreaterThan(0);
    });

    it("live counts match a brute-force recount after births and deaths", () => {
      const eco = busy();
      for (let t = 0; t < 1500 && !eco.extinct; t++) {
        eco.step();
        if (t % 100 !== 0) continue;
        const counts = recount(eco);
        for (let f = 0; f < eco.founders; f++) expect(eco.lineageSize(f)).toBe(counts.get(f) ?? 0);
      }
      expect(eco.births).toBeGreaterThan(0);
      expect(eco.deaths).toBeGreaterThan(0);
      const counts = recount(eco);
      let total = 0;
      for (let f = 0; f < eco.founders; f++) {
        expect(eco.lineageSize(f)).toBe(counts.get(f) ?? 0);
        total += eco.lineageSize(f);
      }
      expect(total).toBe(eco.population);
    });

    it("topLineages lists the biggest living lineages, biggest first, with colour and origin", () => {
      const eco = busy();
      for (let t = 0; t < 1200 && !eco.extinct; t++) eco.step();
      const counts = [...recount(eco)].map(([founder, count]) => ({ founder, count }));
      counts.sort((a, b) => b.count - a.count || a.founder - b.founder);
      const top = eco.topLineages(5);
      expect(top.length).toBe(Math.min(5, counts.length));
      expect(top.map((l) => [l.founder, l.count])).toEqual(counts.slice(0, top.length).map((c) => [c.founder, c.count]));
      for (const l of top) {
        expect(l.hue).toBe(eco.founderColour(l.founder));
        expect(l.pool).toBe(false);
        expect(l.count).toBeGreaterThan(0);
      }
      expect(eco.topLineages(1000).length).toBe(counts.length);
    });

    it("marks pool founders", () => {
      const eco = new Ecosystem(ecoCfg({ eco: { initialPopulation: 10, poolFraction: 0.5 } }), [poolEntry()]);
      expect(eco.poolFounders).toBe(5);
      expect(eco.topLineages(10).map((l) => l.pool)).toEqual([true, true, true, true, true, false, false, false, false, false]);
    });

    it("the frame carries each creature's founder", () => {
      const eco = busy();
      for (let t = 0; t < 600; t++) eco.step();
      const frame = eco.readCreatures();
      for (let i = 0; i < frame.count; i++) expect(frame.founder[i]).toBe(eco.get(frame.ids[i]!)!.founderId);
    });
  });

  describe("aging", () => {
    // One creature with only a flat living cost of 2 energy/s; the energy lost in a tick is that cost times dt times the aging factor.
    const lone = (eco: Partial<EcoConfig["eco"]>) =>
      new Ecosystem(ecoCfg({
        world: { foodDensity: 0, poisonDensity: 0 },
        creature: { startEnergy: 1e6, livingCost: 2, thrustCost: 0, turnCost: 0, rayCost: 0, neuronCost: 0 },
        eco: { initialPopulation: 1, foodRegrow: 0, poisonRegrow: 0, collisions: false, birthEnergy: 1e9, ...eco },
      }));
    const lossPerTick = (e: Ecosystem) => {
      const s = e.members[0]!.creature.state;
      const before = s.energy;
      e.step();
      return before - s.energy;
    };

    it("costs the plain upkeep with aging off, whatever the age", () => {
      const eco = lone({ aging: false, agingStart: 1, agingRate: 5 });
      const dt = eco.config.dt;
      for (let t = 0; t < 600; t++) expect(lossPerTick(eco)).toBeCloseTo(2 * dt, 3);
    });

    it("is zero before agingStart, then grows smoothly", () => {
      const eco = lone({ aging: true, agingStart: 5, agingRate: 0.6 });
      const dt = eco.config.dt;
      const startTicks = Math.round(5 / dt);
      for (let t = 0; t < startTicks; t++) expect(lossPerTick(eco)).toBeCloseTo(2 * dt, 3);
      const losses: number[] = [];
      for (let t = 0; t < 12 / dt; t++) losses.push(lossPerTick(eco));
      expect(losses[0]).toBeGreaterThan(2 * dt - 1e-3);
      for (let i = 1; i < losses.length; i++) expect(losses[i]!).toBeGreaterThanOrEqual(losses[i - 1]! - 1e-3);
      // 6 s past the start at 0.6 per minute: 1 + 0.6 * 6 / 60 = 1.06 times the upkeep.
      const at = Math.round(6 / dt) - 1;
      expect(losses[at]! / (2 * dt)).toBeCloseTo(1.06, 2);
      expect(losses.at(-1)!).toBeGreaterThan(losses[0]! + 1e-4);
    });
  });
});
