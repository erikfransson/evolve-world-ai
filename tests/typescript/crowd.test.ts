import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { Crowd, MAX_GRID_CREATURES } from "../../src/typescript/src/sim/crowd.ts";
import { HIT_CREATURE, HIT_NONE } from "../../src/typescript/src/sim/types.ts";
import type { CreatureState, RayHit } from "../../src/typescript/src/sim/types.ts";

const at = (x: number, y: number, energy = 1): CreatureState => ({ x, y, heading: 0, vx: 0, vy: 0, turnRate: 0, energy, alive: true, ticksAlive: 0 });
const c = DEFAULT_CONFIG;

describe("Crowd", () => {
  it("anyWithin finds a creature in the next grid cell when the query reach crosses the cell border", () => {
    const crowd = new Crowd(c);
    const x = crowd.cell - 50; // the reach below ends in the next cell, half of it would not
    crowd.rebuild([at(crowd.cell + 20, 75)], 1);
    expect(crowd.anyWithin(x, 75, 80)).toBe(true);
    expect(crowd.anyWithin(x, 75, 60)).toBe(false);
  });

  it("a ray sees the nearest of more creatures than the first candidate buffer holds", () => {
    const crowd = new Crowd(c);
    const L = c.creature.rayLength;
    const states = Array.from({ length: 100 }, (_, i) => at(100 + L - 10 - (i === 64 ? 50 : i * 0.1), 500, i)); // the nearest is the first one past the 64 the buffer starts with
    crowd.rebuild(states, states.length);
    const ray: RayHit = { closeness: 0, kind: HIT_NONE, energy: 0, species: 0 };
    crowd.castRays(100, 500, Float64Array.of(1), Float64Array.of(0), [ray], -1, L);
    expect(ray.kind).toBe(HIT_CREATURE);
    expect(ray.energy).toBe(64);
    expect(ray.closeness).toBeCloseTo(1 - (L - 10 - 50 - c.creature.radius) / L, 6);
  });

  it("cellStart holds slots as u16: the largest grid keeps its counts and one more creature is refused", () => {
    const crowd = new Crowd(c);
    const n = MAX_GRID_CREATURES;
    const x = new Float64Array(n + 1).fill(10);
    const e = new Float64Array(n + 1).fill(1);
    crowd.rebuildFrom(x, x, e, n);
    expect(crowd.cellStart[crowd.cols * crowd.rows]).toBe(n);
    expect(crowd.cellStart[0]).toBe(0);
    expect(crowd.cellStart[1]).toBe(n);
    expect(() => crowd.rebuildFrom(x, x, e, n + 1)).toThrow(RangeError);
  });
});
