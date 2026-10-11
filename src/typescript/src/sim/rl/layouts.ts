import type { ItemSpot } from "../ecosystem.ts";
import { createRng, deriveSeed } from "../rng.ts";
import type { Rng } from "../types.ts";
import { HIT_FOOD, HIT_POISON } from "../types.ts";

// Item layouts of RL envs: plain data, drawn per seed. Poison walls are built from poison items close enough that a creature
// cannot pass between two without touching one, so they work as obstacles with gaps.

export type Layout =
  | { kind: "fence"; gap: number; near?: number } // one poison wall across the middle with a gap; the learner starts below, the food lies above (near of it below, as a first step)
  | { kind: "maze"; gap: number; near?: number } // two poison walls with gaps at opposite ends; learner at the bottom, food at the top (near of it in the bottom room)
  | { kind: "patch"; radius: number }; // all food in one patch away from the learner, the poison scattered

export const LAYOUT_KINDS = ["fence", "maze", "patch"] as const;

export interface Placed {
  items: ItemSpot[];
  start: { x: number; y: number }; // the learner's start
}

const WALL_STEP = 18; // centre distance of wall items: a creature (radius 12) touches poison (radius 4) within 16, so any gap of 18 blocks it
const MARGIN = 20; // free border for food and the start

// A horizontal poison wall at height y with a gap of width gap whose centre is at gx.
function wall(items: ItemSpot[], width: number, y: number, gx: number, gap: number): void {
  for (let x = WALL_STEP / 2; x < width; x += WALL_STEP) if (Math.abs(x - gx) > gap / 2) items.push({ x, y, kind: HIT_POISON });
}

const spot = (rng: Rng, x0: number, x1: number, y0: number, y1: number): { x: number; y: number } => ({ x: rng.range(x0, x1), y: rng.range(y0, y1) });

// The layout's items (food food items, poison extra scattered poison besides the walls) and the learner's start for this seed.
export function placeLayout(layout: Layout, size: readonly [number, number], food: number, poison: number, seed: number): Placed {
  const rng = createRng(deriveSeed(seed, 0x1a70));
  const [w, h] = size;
  const items: ItemSpot[] = [];
  let start: { x: number; y: number };
  if (layout.kind === "fence") {
    const gx = rng.range(layout.gap, w - layout.gap);
    wall(items, w, h / 2, gx, layout.gap);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food - near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, MARGIN, h / 2 - 3 * MARGIN), kind: HIT_FOOD });
    for (let k = 0; k < near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, h / 2 + 2 * MARGIN, h - MARGIN), kind: HIT_FOOD });
    start = spot(rng, MARGIN, w - MARGIN, h / 2 + 3 * MARGIN, h - MARGIN);
  } else if (layout.kind === "maze") {
    const left = rng.next() < 0.5;
    const end = (atLeft: boolean): number => (atLeft ? layout.gap : w - layout.gap);
    wall(items, w, h / 3, end(left), layout.gap * 2);
    wall(items, w, (2 * h) / 3, end(!left), layout.gap * 2);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food - near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, MARGIN, h / 3 - 2 * MARGIN), kind: HIT_FOOD });
    for (let k = 0; k < near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, (2 * h) / 3 + MARGIN, h - MARGIN), kind: HIT_FOOD });
    start = spot(rng, MARGIN, w - MARGIN, (2 * h) / 3 + 2 * MARGIN, h - MARGIN);
  } else {
    // The patch sits in a random corner region.
    const right = rng.next() < 0.5;
    const down = rng.next() < 0.5;
    const r = layout.radius;
    const cx = right ? w - r - MARGIN : r + MARGIN;
    const cy = down ? h - r - MARGIN : r + MARGIN;
    for (let k = 0; k < food; k++) {
      const a = rng.next() * 2 * Math.PI;
      const d = r * Math.sqrt(rng.next());
      items.push({ x: cx + d * Math.cos(a), y: cy + d * Math.sin(a), kind: HIT_FOOD });
    }
    start = { x: w / 2, y: h / 2 }; // the middle: the patch is a short search away in an unknown direction
  }
  // Extra poison scattered over the world, kept off the start and the food.
  for (let k = 0, tries = 0; k < poison && tries < 1000; tries++) {
    const p = spot(rng, MARGIN, w - MARGIN, MARGIN, h - MARGIN);
    if (Math.hypot(p.x - start.x, p.y - start.y) < 40 || items.some((it) => it.kind === HIT_FOOD && Math.hypot(it.x - p.x, it.y - p.y) < 28)) continue;
    items.push({ ...p, kind: HIT_POISON });
    k++;
  }
  return { items, start };
}
