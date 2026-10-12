import { Brain, genomeLength, layerSizes, randomGenome, upgradeGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { Episode } from "../../src/typescript/src/sim/episode.ts";
import { decaysFor, stepBody } from "../../src/typescript/src/sim/physics.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { MAX_DISCS_PER_PIECE, FAST_FACTOR, SLOW_FACTOR, TERRAIN_FAST, TERRAIN_SLOW, Terrain, terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { CreatureState, RayHit } from "../../src/typescript/src/sim/types.ts";
import { RayCache, World } from "../../src/typescript/src/sim/world.ts";

const withMap = (over: Partial<SimConfig["world"]> = {}): SimConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.world = { ...c.world, width: 3000, height: 2000, stoneDensity: 0.05, ridgeDensity: 0.04, slowDensity: 0.06, fastDensity: 0.05, ...over };
  return c;
};

const discs = (t: Terrain) => Array.from(t.rockX, (x, i) => [x, t.rockY[i]!, t.rockR[i]!]);

describe("terrainOf", () => {
  it("builds the same map for the same seed and settings, another for another seed", () => {
    const a = terrainOf(withMap());
    const b = terrainOf({ seed: 1, world: { ...withMap().world } });
    expect(a).toBe(b);
    expect(a.rockCount).toBeGreaterThan(0);
    expect(a.patchX.length).toBeGreaterThan(0);
    expect(discs(terrainOf({ ...withMap(), seed: 2 }))).not.toEqual(discs(a));
  });

  it("is empty at density 0 and changing one kind leaves the others where they were", () => {
    expect(terrainOf(withMap({ stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0 })).empty).toBe(true);
    const full = terrainOf(withMap());
    const noPatches = terrainOf(withMap({ slowDensity: 0, fastDensity: 0 }));
    expect(discs(noPatches)).toEqual(discs(full));
    expect(Array.from(terrainOf(withMap({ stoneDensity: 0.02 })).patchX)).toEqual(Array.from(full.patchX));
  });

  it("keeps rock and creatures-wide gaps inside the world, with boulders at least 500 across", () => {
    const t = terrainOf(withMap());
    for (const [x, y, r] of discs(t)) {
      expect(x - r).toBeGreaterThan(0);
      expect(y - r).toBeGreaterThan(0);
      expect(x + r).toBeLessThan(3000);
      expect(y + r).toBeLessThan(2000);
    }
    const stones = terrainOf(withMap({ ridgeDensity: 0, slowDensity: 0, fastDensity: 0 }));
    expect(Math.max(...stones.rockX.map((x, i) => x + stones.rockR[i]!)) - Math.min(...stones.rockX.map((x, i) => x - stones.rockR[i]!))).toBeGreaterThanOrEqual(500);
    let covered = 0; // sampled, since the discs of a piece overlap
    for (let y = 5; y < 2000; y += 10) for (let x = 5; x < 3000; x += 10) if (t.touchesRock(x, y, 0)) covered++;
    expect(covered / (300 * 200)).toBeLessThan(0.4);
  });

  it("makes boulders angular polygons and ridges slabs with loose pebbles, within the disc cap", () => {
    const t = terrainOf(withMap({ ridgeDensity: 0, slowDensity: 0, fastDensity: 0 }));
    expect(t.rockCount).toBeGreaterThan(40); // rows of discs along the edges, not one disc per stone
    const r = terrainOf(withMap({ stoneDensity: 0, slowDensity: 0, fastDensity: 0 }));
    expect(r.rockCount).toBeGreaterThan(60);
    expect(r.rockCount).toBeLessThanOrEqual(MAX_DISCS_PER_PIECE * 20);
    // a ridge is slabs of touching discs and a few small loose pebbles that touch nothing: every disc but a pebble touches another one
    const lonely = Array.from(r.rockX).filter((x, i) => !Array.from(r.rockX).some((x2, j) => j !== i && Math.hypot(x2 - x, r.rockY[j]! - r.rockY[i]!) < r.rockR[i]! + r.rockR[j]!));
    expect(lonely.length).toBeLessThanOrEqual(6 * 20);
    expect(lonely.length).toBeLessThan(r.rockCount / 2);
  });

  it("scales the patches with their size setting and keeps today's map at size 1", () => {
    const radius = (t: Terrain): number => Math.max(...t.patchR);
    const base = terrainOf(withMap());
    expect(Array.from(terrainOf(withMap({ slowSize: 1, fastSize: 1 })).patchR)).toEqual(Array.from(base.patchR));
    expect(radius(terrainOf(withMap({ slowSize: 2, fastSize: 2 })))).toBeGreaterThan(1.5 * radius(base));
    expect(radius(terrainOf(withMap({ slowSize: 0.5, fastSize: 0.5 })))).toBeLessThan(0.7 * radius(base));
    expect(discs(terrainOf(withMap({ slowSize: 2 })))).toEqual(discs(base)); // rock does not move
  });
});

// Nearest wall, rock disc or item along a unit direction, by plain geometry.
function brute(w: World, config: SimConfig, x: number, y: number, a: number, hideFood = false): { closeness: number; kind: number } {
  const L = config.creature.rayLength;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let best = L;
  let kind: number = HIT_NONE;
  const wall = Math.min(dx > 0 ? (3000 - x) / dx : dx < 0 ? -x / dx : Infinity, dy > 0 ? (2000 - y) / dy : dy < 0 ? -y / dy : Infinity);
  if (wall < best) [best, kind] = [wall, HIT_WALL];
  const hit = (cx: number, cy: number, r: number, k: number): void => {
    const b = (cx - x) * dx + (cy - y) * dy;
    const c = (cx - x) ** 2 + (cy - y) ** 2 - r * r;
    if (c >= 0 && (b <= 0 || b * b - c < 0)) return;
    const t = c < 0 ? 0 : b - Math.sqrt(b * b - c); // starting inside an item touches it
    if (t < best) [best, kind] = [t, k];
  };
  for (const [cx, cy, r] of discs(w.terrain)) hit(cx!, cy!, r!, HIT_WALL);
  for (let i = 0; i < w.count; i++) if (w.kinds[i] !== HIT_NONE && !(hideFood && w.kinds[i] === HIT_FOOD)) hit(w.xs[i]!, w.ys[i]!, config.world.itemRadius, w.kinds[i]!);
  return { closeness: kind === HIT_NONE ? 0 : 1 - best / L, kind };
}

describe("rays and rock", () => {
  it("see rock as walls, at the exact distance of the nearest disc, with items hiding behind it", () => {
    const config = withMap({ foodDensity: 0.3, poisonDensity: 0.05 });
    const counts = itemCounts(config);
    const w = new World(config, counts.food + counts.poison);
    w.scatter(counts.food, counts.poison, createRng(4));
    const rng = createRng(9);
    let rockHits = 0;
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    for (let n = 0; n < 4000; n++) {
      // Start near rock, so many rays meet it.
      const i = rng.int(w.terrain.rockCount);
      const near = w.terrain.rockR[i]! + 60 + rng.next() * 150;
      const phi = rng.range(0, 2 * Math.PI);
      const x = Math.min(2990, Math.max(10, w.terrain.rockX[i]! + near * Math.cos(phi)));
      const y = Math.min(1990, Math.max(10, w.terrain.rockY[i]! + near * Math.sin(phi)));
      if (w.terrain.touchesRock(x, y, 0)) continue;
      const a = rng.range(0, 2 * Math.PI);
      w.castRays(x, y, Float64Array.of(Math.cos(a)), Float64Array.of(Math.sin(a)), [out], new RayCache(), config.creature.rayLength);
      const want = brute(w, config, x, y, a);
      expect(out.kind).toBe(want.kind);
      expect(out.closeness).toBeCloseTo(want.closeness, 9);
      if (out.kind === HIT_WALL && w.terrain.touchesRock(x + 150 * Math.cos(a), y + 150 * Math.sin(a), 1)) rockHits++;
    }
    expect(rockHits).toBeGreaterThan(50);
  });

  it("still hide food from rays beside rock, which they stop at", () => {
    const config = withMap({ foodDensity: 0.3, poisonDensity: 0.05 });
    const counts = itemCounts(config);
    const w = new World(config, counts.food + counts.poison);
    w.scatter(counts.food, counts.poison, createRng(4));
    w.foodHidden = true;
    const rng = createRng(11);
    const out: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    let walls = 0;
    for (let n = 0; n < 2000; n++) {
      const x = rng.range(10, 2990);
      const y = rng.range(10, 1990);
      if (w.terrain.touchesRock(x, y, 0)) continue;
      const a = rng.range(0, 2 * Math.PI);
      w.castRays(x, y, Float64Array.of(Math.cos(a)), Float64Array.of(Math.sin(a)), [out], new RayCache(), config.creature.rayLength);
      const want = brute(w, config, x, y, a, true);
      expect(out.kind).not.toBe(HIT_FOOD);
      expect(out.kind).toBe(want.kind);
      expect(out.closeness).toBeCloseTo(want.closeness, 9);
      if (out.kind === HIT_WALL) walls++;
    }
    expect(walls).toBeGreaterThan(100);
  });

  it("keep items out of rock when scattering and regrowing", () => {
    const config = withMap({ foodDensity: 1, poisonDensity: 0.2 });
    const counts = itemCounts(config);
    const w = new World(config, counts.food + counts.poison + 500);
    w.scatter(counts.food, counts.poison, createRng(2));
    const rng = createRng(3);
    for (let i = 0; i < 500; i++) w.addRandomly(i % 5 === 0 ? HIT_POISON : HIT_FOOD, rng);
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] === HIT_NONE) continue;
      expect(w.terrain.touchesRock(w.xs[i]!, w.ys[i]!, config.world.itemRadius)).toBe(false);
    }
  });
});

describe("ground and rock under a body", () => {
  const body = (x: number, y: number): CreatureState => ({ x, y, heading: 0, vx: 100, vy: 0, turnRate: 0, energy: 50, alive: true, ticksAlive: 0 });
  const config = structuredClone(DEFAULT_CONFIG);
  const patches = new Terrain([], [{ x: 200, y: 200, r: 100, kind: TERRAIN_SLOW }, { x: 600, y: 200, r: 100, kind: TERRAIN_FAST }], 1000, 1000);

  it("scales the distance moved per tick by 50% on slow and 175% on fast ground, and not the energy cost", () => {
    const move = (x: number) => {
      const s = body(x, 200);
      stepBody(s, 0, 0, config, decaysFor(config), { cos: 1, sin: 0 }, 2, patches);
      return s;
    };
    const plain = body(400, 200);
    stepBody(plain, 0, 0, config, decaysFor(config), { cos: 1, sin: 0 }, 2, patches);
    const slow = move(200);
    const fast = move(600);
    expect(patches.valueAt(200, 200)).toBe(TERRAIN_SLOW);
    expect(patches.valueAt(600, 200)).toBe(TERRAIN_FAST);
    expect(slow.x - 200).toBeCloseTo(SLOW_FACTOR * (plain.x - 400), 9);
    expect(fast.x - 600).toBeCloseTo(FAST_FACTOR * (plain.x - 400), 9);
    expect(slow.energy).toBe(plain.energy);
    expect(slow.vx).toBe(plain.vx);
  });

  it("bounces a body off a disc like a wall and never leaves it inside", () => {
    const rock = new Terrain([{ x: 500, y: 500, r: 100 }, { x: 560, y: 500, r: 100 }], [], 1000, 1000);
    const s = body(386, 500);
    stepBody(s, 0, 0, { ...config, creature: { ...config.creature, radius: 12, wallBounce: 0.6 } }, decaysFor(config), { cos: 1, sin: 0 }, 0, rock);
    expect(s.x).toBeCloseTo(500 - 112, 6); // the contact normal points along x
    s.x = 390;
    s.vx = 90;
    rock.keepOut(s, 12, 0.6);
    expect(s.vx).toBeCloseTo(-0.6 * 90, 9);
    for (let k = 0; k < 200; k++) {
      const p = body(rock.rockX[0]! + 30 * Math.cos(k), 500 + 30 * Math.sin(k));
      rock.keepOut(p, 12, 0.6);
      expect(rock.touchesRock(p.x, p.y, 12 - 1e-6)).toBe(false);
    }
  });
});

describe("Episode and Ecosystem with rock", () => {
  it("starts the creature clear of rock, away from the centre when a stone sits there", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const config = withMap({ width: 2300, height: 1400, stoneDensity: 0.2 });
      config.seed = seed;
      const e = new Episode(config, randomGenome(layerSizes(config), createRng(1)), 1, 0);
      expect(e.world.terrain.touchesRock(e.state.x, e.state.y, config.creature.radius)).toBe(false);
    }
  });

  function ecoConfig(seed: number): EcoConfig {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    return {
      ...d,
      seed,
      world: { ...d.world, width: 2500, height: 1600, foodDensity: 0.5, poisonDensity: 0.05, stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0.08, fastDensity: 0.06 },
      creature: { ...d.creature, startEnergy: 60 },
      eco: { ...d.eco, initialPopulation: 150, structuralRate: 0.1, birthEnergyRange: [76, 76], birthCostRange: [60, 60], birthCooldownRange: [3, 3], foodRegrow: 0.05, wasm: false },
    };
  }

  it.each([1, 2])("never has a creature or an item inside rock (seed %i)", (seed) => {
    const eco = new Ecosystem(ecoConfig(seed));
    const t = terrainOf(eco.config);
    const r = eco.config.creature.radius;
    let births = 0;
    for (let tick = 0; tick < 250; tick++) {
      eco.step();
      births = eco.births;
      for (const m of eco.members) expect(t.touchesRock(m.creature.state.x, m.creature.state.y, r - 1e-6)).toBe(false);
    }
    expect(births).toBeGreaterThan(3);
    const w = eco.world;
    for (let i = 0; i < w.count; i++) if (w.kinds[i] !== HIT_NONE) expect(t.touchesRock(w.xs[i]!, w.ys[i]!, eco.config.world.itemRadius)).toBe(false);
  });

  it("rejects an inserted creature standing in rock", () => {
    const eco = new Ecosystem(ecoConfig(1));
    const t = terrainOf(eco.config);
    const plan = { rayCount: 4, raySpread: 1, rayLength: 100, hiddenLayers: [6], memoryShort: 1, memoryLong: 1 };
    const spec = { genome: randomGenome(layerSizes(eco.config, plan), createRng(1)), plan, x: t.rockX[0]!, y: t.rockY[0]!, hue: 10, name: "" };
    expect(eco.insertCreature(spec)).toEqual({ ok: false, reason: "position must be clear of rock" });
  });
});

describe("terrain input and genome upgrade", () => {
  const config = structuredClone(DEFAULT_ECO_CONFIG);
  const plan = { rayCount: 5, raySpread: 2, rayLength: 120, hiddenLayers: [7, 5], memoryShort: 2, memoryLong: 1 };
  const sizes = layerSizes(config, plan);
  const oldSizes = [sizes[0]! - 1, ...sizes.slice(1)];

  it("puts the terrain input last among the extras, before the memory", () => {
    const layout = inputLayout(config, plan);
    expect(layout.terrainAt).toBe(layout.memoryAt - 1);
    expect(layout.extras.at(-1)).toBe("terrain");
  });

  it("inserts a zero weight column so an old creature acts the same on any ground", () => {
    const old = randomGenome(oldSizes, createRng(5));
    const upgraded = upgradeGenome(old, config, plan)!;
    expect(upgraded.length).toBe(genomeLength(sizes));
    const input = Float32Array.from({ length: oldSizes[0]! }, (_, i) => Math.sin(i + 1));
    const was = new Float32Array(oldSizes.at(-1)!);
    new Brain(oldSizes, old).forward(input, was);
    const at = inputLayout(config, plan).terrainAt;
    for (const ground of [-1, 0, 1]) {
      const now = Float32Array.of(...input.slice(0, at), ground, ...input.slice(at));
      const out = new Float32Array(sizes.at(-1)!);
      new Brain(sizes, upgraded).forward(now, out);
      expect(Array.from(out)).toEqual(Array.from(was));
    }
  });

  it("leaves a current genome alone and refuses one that fits neither layout", () => {
    const current = randomGenome(sizes, createRng(1));
    expect(upgradeGenome(current, config, plan)).toBe(current);
    expect(upgradeGenome(new Float32Array(genomeLength(sizes) - 3), config, plan)).toBeNull();
    expect(upgradeGenome(new Float32Array(0), config, plan)).toBeNull();
  });
});
