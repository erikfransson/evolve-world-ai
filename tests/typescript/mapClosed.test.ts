import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { builtMap } from "../../src/typescript/src/sim/maps/index.ts";

// The cliff massif is a closed edge: a body of creature radius that starts in the open can reach no deep inside point, however narrow the gap it tries.
it("a creature cannot get into the massifs of The Inland Sea", () => {
  const sea = terrainOf(withEcoPreset(structuredClone(DEFAULT_ECO_CONFIG), "inland-sea"));
  const { rock } = builtMap("inland-sea");
  const step = 24;
  const r = 12;
  const cols = Math.ceil(sea.width / step);
  const rows = Math.ceil(sea.height / step);
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  const start = Math.floor(12000 / step) * cols + Math.floor(20000 / step);
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++]!;
    const x = c % cols;
    const y = (c - x) / cols;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (seen[n] || sea.touchesRock(nx * step, ny * step, r)) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  const deep = rock.filter((d) => d.r >= 200);
  expect(deep.length).toBeGreaterThan(100);
  for (const d of deep) expect(seen[Math.floor(d.y / step) * cols + Math.floor(d.x / step)]).toBe(0);
  expect(tail).toBeGreaterThan(cols * rows * 0.5); // the open ground is one big region, so the search did cross the world
}, 120000);
