import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Creature } from "../../src/typescript/src/sim/creature.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { decaysFor, stepBody } from "../../src/typescript/src/sim/physics.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { EXTRA_TERRAIN, inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { FAST_FACTOR, SLOW_FACTOR, TERRAIN_FAST, TERRAIN_SLOW, Terrain, terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { FEATHER_BANDS, FEATHER_UNITS } from "../../src/typescript/src/ui/groundScene.ts";
import { patchBodies, traceSmooth } from "../../src/typescript/src/ui/rockOutline.ts";
import type { PathSink } from "../../src/typescript/src/ui/rockOutline.ts";

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

// What the renderer paints as ground of each kind: the even-odd fill of the smooth outlines of the patch bodies.
const drawn = patchBodies(terrain).map((b) => ({ box: b, kind: b.kind, polys: b.loops.map(curve) }));
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

// Signed distance to the union of the patch discs, positive inside.
function depth(x: number, y: number): number {
  let d = -Infinity;
  for (let i = 0; i < terrain.patchX.length; i++) d = Math.max(d, terrain.patchR[i]! - Math.hypot(x - terrain.patchX[i]!, y - terrain.patchY[i]!));
  return d;
}

describe("drawn ground and sensed ground", () => {
  const SLACK = 2; // world units between the drawn outline and the exact union edge

  it("draws every patch kind and the same body list for the same map", () => {
    expect(new Set(drawn.map((d) => d.kind))).toEqual(new Set([TERRAIN_SLOW, TERRAIN_FAST]));
    expect(patchBodies(terrain)).toBe(patchBodies(terrain));
  });

  it("senses what is drawn: inside a drawn patch the value is its kind, outside it is 0, right up to the edge", () => {
    const rng = createRng(5);
    let near = 0;
    let checked = 0;
    const check = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x > terrain.width || y > terrain.height || Math.abs(depth(x, y)) < SLACK) return; // within the slack of the edge the outline may differ by a unit or two
      checked++;
      expect(terrain.valueAt(x, y)).toBe(drawnKindAt(x, y));
    };
    for (let k = 0; k < 8000; k++) check(rng.range(0, terrain.width), rng.range(0, terrain.height));
    // and many points a few units either side of the edge of random discs
    for (let k = 0; k < 8000; k++) {
      const i = rng.int(terrain.patchX.length);
      const a = rng.range(0, 2 * Math.PI);
      const r = terrain.patchR[i]! + rng.range(-8, 8);
      const x = terrain.patchX[i]! + r * Math.cos(a);
      const y = terrain.patchY[i]! + r * Math.sin(a);
      if (Math.abs(depth(x, y)) < 8) near++;
      check(x, y);
    }
    expect(near).toBeGreaterThan(800);
    expect(checked).toBeGreaterThan(8000);
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
      const i = rng.int(terrain.patchX.length);
      const a = rng.range(0, 2 * Math.PI);
      const r = terrain.patchR[i]! + rng.range(-8, 8);
      const x = terrain.patchX[i]! + r * Math.cos(a);
      const y = terrain.patchY[i]! + r * Math.sin(a);
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
    stepBody(plain, 0, 0, c, decaysFor(c), { cos: 1, sin: 0 }, 2, new Terrain([], [], 1000, 1000));
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
