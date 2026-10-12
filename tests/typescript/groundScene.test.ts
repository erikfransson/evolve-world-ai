import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { decaysFor, stepBody } from "../../src/typescript/src/sim/physics.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { EXTRA_TERRAIN, inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { buildGroundField, GROUND_HALF } from "../../src/typescript/src/sim/groundField.ts";
import { FAST_FACTOR, SLOW_FACTOR, TERRAIN_FAST, TERRAIN_SLOW, Terrain, terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { FEATHER_BANDS, FEATHER_UNITS } from "../../src/typescript/src/ui/groundScene.ts";
import { fineOf, groundBodies, traceSmooth } from "../../src/typescript/src/ui/groundOutline.ts";
import type { PathSink } from "../../src/typescript/src/ui/rockOutline.ts";

const LIMITS = { maxBlobs: 300, tries: 40 };
const config = structuredClone(DEFAULT_ECO_CONFIG);
config.world = { ...config.world, width: 4000, height: 2600, stoneDensity: 0.04, ridgeDensity: 0.03, slowDensity: 0.1, fastDensity: 0.08 };
const terrain = terrainOf(config);

// Flattens the closed curve traceSmooth draws (quadratic pieces) into a polygon.
function curve(loop: readonly number[]): [number, number][] {
  const pts: [number, number][] = [];
  let cx = 0;
  let cy = 0;
  const sink: PathSink = {
    moveTo: (x, y) => {
      cx = x;
      cy = y;
      pts.push([x, y]);
    },
    lineTo: (x, y) => pts.push([(cx = x), (cy = y)]),
    quadraticCurveTo: (qx, qy, x, y) => {
      for (let s = 1; s <= 6; s++) {
        const u = s / 6;
        pts.push([(1 - u) ** 2 * cx + 2 * u * (1 - u) * qx + u * u * x, (1 - u) ** 2 * cy + 2 * u * (1 - u) * qy + u * u * y]);
      }
      cx = x;
      cy = y;
    },
    closePath: () => undefined,
  };
  traceSmooth(sink, loop);
  return pts;
}

// What the renderer paints as ground of each kind: the even-odd fill of the smooth outlines of the ground bodies.
const level = fineOf(terrain);
const drawn = groundBodies(terrain, level).map((b) => ({ box: b, kind: b.kind, polys: b.loops.map(curve) }));
function drawnKindAt(x: number, y: number): number {
  for (const { box, kind, polys } of drawn) {
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
    let inside = false;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]!;
        const [xj, yj] = poly[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return kind;
  }
  return 0;
}

const field = terrain.ground!;
// Distance in world units from (x, y) to the edge of the ground field, from the blend and its local slope; inside is positive for the kind of the nearer layer.
function depth(x: number, y: number): number {
  let best = Infinity;
  for (const layer of [0, 1]) {
    const v = field.blend(layer, x, y) - GROUND_HALF;
    const slope = Math.max(1e-6, Math.hypot(field.blend(layer, x + 1, y) - field.blend(layer, x - 1, y), field.blend(layer, x, y + 1) - field.blend(layer, x, y - 1)) / 2);
    if (Math.abs(v) / slope < Math.abs(best)) best = v / slope;
  }
  return best;
}
// A random point within about 8 units of the drawn outline.
function nearEdge(rng: ReturnType<typeof createRng>): [number, number] {
  const loops = drawn[rng.int(drawn.length)]!.polys;
  const loop = loops[rng.int(loops.length)]!;
  const [x, y] = loop[rng.int(loop.length)]!;
  const a = rng.range(0, 2 * Math.PI);
  const r = rng.range(0, 8);
  return [x + r * Math.cos(a), y + r * Math.sin(a)];
}

describe("drawn ground and sensed ground", () => {
  const SLACK = 2; // world units between the drawn outline and the exact union edge

  it("draws every patch kind and the same body list for the same map", () => {
    expect(new Set(drawn.map((d) => d.kind))).toEqual(new Set([TERRAIN_SLOW, TERRAIN_FAST]));
    expect(groundBodies(terrain, level)).toBe(groundBodies(terrain, level));
  });

  it("senses what is drawn: inside a drawn patch the value is its kind, outside it is 0, right up to the edge", () => {
    const rng = createRng(5);
    let near = 0;
    let checked = 0;
    const check = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x > terrain.width || y > terrain.height || Math.abs(depth(x, y)) < SLACK) return; // within the slack of the edge the smoothed outline may differ from the exact contour by a unit or two
      checked++;
      expect(terrain.valueAt(x, y)).toBe(drawnKindAt(x, y));
    };
    for (let k = 0; k < 8000; k++) check(rng.range(0, terrain.width), rng.range(0, terrain.height));
    // and many points a few units either side of the drawn edge
    for (let k = 0; k < 8000; k++) {
      const [x, y] = nearEdge(rng);
      if (Math.abs(depth(x, y)) < 8) near++;
      check(x, y);
    }
    expect(near).toBeGreaterThan(800);
    expect(checked).toBeGreaterThan(8000);
  });

  it("draws the exact 0.5 contour of the field: every outline vertex sits on it and chords between them stay within a unit", () => {
    let worst = 0;
    let vertices = 0;
    for (const body of groundBodies(terrain, level)) {
      const layer = body.kind === TERRAIN_SLOW ? 0 : 1;
      for (const loop of body.loops) {
        for (let i = 0; i < loop.length; i += 2) {
          const j = (i + 2) % loop.length;
          const slope = (x: number, y: number): number => Math.hypot(field.blend(layer, x + 1, y) - field.blend(layer, x - 1, y), field.blend(layer, x, y + 1) - field.blend(layer, x, y - 1)) / 2;
          expect(Math.abs(field.blend(layer, loop[i]!, loop[i + 1]!) - GROUND_HALF)).toBeLessThan(0.05); // a crossing on a fine grid line is exact
          const mx = (loop[i]! + loop[j]!) / 2;
          const my = (loop[i + 1]! + loop[j + 1]!) / 2;
          if (mx > 0 && my > 0 && mx < terrain.width && my < terrain.height) worst = Math.max(worst, Math.abs(field.blend(layer, mx, my) - GROUND_HALF) / Math.max(slope(mx, my), 1e-6));
          vertices++;
        }
      }
    }
    expect(vertices).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1);
  });

  it("senses exactly the field: valueAt is the 0.5 threshold of the blend, mud and firm never together", () => {
    const rng = createRng(21);
    for (let k = 0; k < 20000; k++) {
      const x = rng.range(0, terrain.width);
      const y = rng.range(0, terrain.height);
      const mud = field.blend(0, x, y) >= GROUND_HALF;
      const firm = field.blend(1, x, y) >= GROUND_HALF;
      expect(mud && firm).toBe(false);
      expect(terrain.valueAt(x, y)).toBe(mud ? TERRAIN_SLOW : firm ? TERRAIN_FAST : 0);
    }
    for (let k = 0; k < field.data.length; k += 2) expect(field.data[k]! + field.data[k + 1]!).toBeLessThanOrEqual(255);
  });

  it("builds the same raster from the same inputs, within the memory bound, and closes every outline inside the raster", () => {
    const specs = (): { density: number; size: number; rng: ReturnType<typeof createRng> }[] => [{ density: 0.1, size: 1, rng: createRng(3) }, { density: 0.08, size: 1.5, rng: createRng(4) }];
    const a = buildGroundField(6000, 4000, specs(), 7, LIMITS)!;
    const b = buildGroundField(6000, 4000, specs(), 7, LIMITS)!;
    expect(b.data).toEqual(a.data);
    expect(buildGroundField(6000, 4000, specs(), 8, LIMITS)!.data).not.toEqual(a.data);
    expect(buildGroundField(50_000, 50_000, [{ density: 0.3, size: 1, rng: createRng(1) }, { density: 0.3, size: 1, rng: createRng(2) }], 1, LIMITS)!.bytes).toBeLessThanOrEqual(520_000);
    for (let i = 0; i < 2 * a.cols; i++) expect([a.data[i], a.data[2 * (a.rows - 1) * a.cols + i]]).toEqual([0, 0]); // top and bottom rows of nodes are outside the world
  });

  it("gives every kind with a density at least one patch, even in a tiny world with the smallest patches", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const t = terrainOf({ seed, world: { width: 500, height: 500, stoneDensity: 0, ridgeDensity: 0, slowDensity: 0.01, fastDensity: 0.3, slowSize: 0.4, fastSize: 2.5 } });
      const has = (layer: number): boolean => t.ground!.data.some((v, k) => k % 2 === layer && v >= 128);
      expect([has(0), has(1)], `seed ${seed}`).toEqual([true, true]);
    }
  });

  it("keeps the feathering a few units wide and inside the edge", () => {
    expect(FEATHER_UNITS).toBeLessThanOrEqual(8);
    for (const band of FEATHER_BANDS) expect(band.width).toBeLessThanOrEqual(FEATHER_UNITS);
  });

  it("feeds the brain the value at a point drawn inside mud as -1, firm as 1 and outside as 0, on the JS and WASM input paths", () => {
    const layout = inputLayout(config);
    const sizes = layerSizes(config);
    const creature = new Creature(config, randomGenome(sizes, createRng(2)), 100, 100, 0);
    const wasm = new Float32Array(sizes[0]!);
    const sense = (x: number, y: number): [number, number] => {
      creature.state.x = x;
      creature.state.y = y;
      creature.writeBodyInputs(wasm, layout.terrainAt - EXTRA_TERRAIN);
      return [creature.encode()[layout.terrainAt]!, wasm[layout.terrainAt]!];
    };
    const rng = createRng(9);
    const seen = new Set<number>();
    for (let k = 0; k < 400; k++) {
      const [x, y] = nearEdge(rng);
      if (Math.abs(depth(x, y)) < SLACK || x < 0 || y < 0 || x > terrain.width || y > terrain.height) continue;
      const want = drawnKindAt(x, y);
      seen.add(want);
      expect(sense(x, y)).toEqual([want, want]);
    }
    expect(seen).toEqual(new Set([TERRAIN_SLOW, TERRAIN_FAST, 0]));
  });

  it("moves a body at the speed of the ground it is drawn on", () => {
    const rng = createRng(13);
    const c = structuredClone(DEFAULT_ECO_CONFIG);
    const plain = { x: 500, y: 500, vx: 100, vy: 0, turnRate: 0, energy: 50, alive: true, ticksAlive: 0, heading: 0 };
    stepBody(plain, 0, 0, c, decaysFor(c), { cos: 1, sin: 0 }, 2, new Terrain([], null, 1000, 1000));
    const step = plain.x - 500;
    let tested = 0;
    for (let k = 0; k < 600 && tested < 60; k++) {
      const x = rng.range(0, terrain.width);
      const y = rng.range(0, terrain.height);
      if (Math.abs(depth(x, y)) < SLACK || terrain.touchesRock(x, y, 20)) continue;
      const s = { x, y, vx: 100, vy: 0, turnRate: 0, energy: 50, alive: true, ticksAlive: 0, heading: 0 };
      stepBody(s, 0, 0, c, decaysFor(c), { cos: 1, sin: 0 }, 2, terrain);
      const want = { [TERRAIN_SLOW]: SLOW_FACTOR, [TERRAIN_FAST]: FAST_FACTOR, 0: 1 }[drawnKindAt(x, y)]!;
      expect(s.x - x).toBeCloseTo(want * step, 9);
      tested++;
    }
    expect(tested).toBe(60);
  });
});
