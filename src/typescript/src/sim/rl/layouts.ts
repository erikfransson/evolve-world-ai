import type { ItemSpot } from "../ecosystem.ts";
import { createRng, deriveSeed } from "../rng.ts";
import type { Rng } from "../types.ts";
import { HIT_FOOD, HIT_POISON } from "../types.ts";

// Item layouts of RL envs: plain data, drawn per seed. Poison walls are built from poison items close enough that a creature
// cannot pass between two without touching one, so they work as obstacles with gaps.

export type Layout =
  | { kind: "fence"; gap: number; near?: number } // one poison wall across the middle with a gap; the learner starts below, the food lies above (near of it below, as a first step)
  | { kind: "maze"; gap: number; near?: number } // two poison walls with gaps at opposite ends; learner at the bottom, food at the top (near of it in the bottom room)
  | { kind: "patch"; radius: number } // all food in one patch away from the learner, the poison scattered
  | { kind: "rooms"; gap: number; near?: number } // a cross of poison walls makes four rooms with a door in each wall; the learner starts in one, the food lies in the others (near of it in the start room)
  | { kind: "islands"; radius: number } // the food split over three islands, the poison scattered in the water between them
  | { kind: "ring"; lane: number } // a circular lane of this width between two poison rings, the food spaced along it, the first just ahead of the start
  | { kind: "cuedoor" } // a T-maze: a cue bite beside the start (left or right), a walled corridor up, then two doors to separate rooms, the food in the cued one
  | { kind: "stops"; count?: number } // food in count (3) small clusters round a central start, dealt evenly (pair with foodVisibleFor): visit one, then recall where the others were
  | { kind: "flash" } // food at a middle distance around a central start, in all directions (pair with foodVisibleFor)
  | { kind: "sprint"; near?: number }; // a strip with the learner at one end and the food at the other (near of it halfway, as a first step)

export const LAYOUT_KINDS = ["fence", "maze", "patch", "rooms", "islands", "sprint", "ring", "cuedoor", "flash", "stops"] as const;

export interface Placed {
  items: ItemSpot[];
  start: { x: number; y: number; heading?: number }; // the learner's start, and its heading when the layout fixes it
  walls: number[]; // heights of the poison walls between the start and the food, nearest first
}

const WALL_STEP = 18; // centre distance of wall items: a creature (radius 12) touches poison (radius 4) within 16, so any gap of 18 blocks it
const MARGIN = 20; // free border for food and the start

// A horizontal poison wall at height y with a gap of width gap whose centre is at gx.
function wall(items: ItemSpot[], width: number, y: number, gx: number, gap: number): void {
  for (let x = WALL_STEP / 2; x < width; x += WALL_STEP) if (Math.abs(x - gx) > gap / 2) items.push({ x, y, kind: HIT_POISON });
}

// A vertical poison wall at x from y0 to y1, with a door of width gap centred at gy.
function vwall(items: ItemSpot[], x: number, y0: number, y1: number, gy: number, gap: number): void {
  for (let y = y0 + WALL_STEP / 2; y < y1; y += WALL_STEP) if (Math.abs(y - gy) > gap / 2) items.push({ x, y, kind: HIT_POISON });
}

// A horizontal poison wall at y from x0 to x1, with a door of width gap centred at gx.
function hwall(items: ItemSpot[], y: number, x0: number, x1: number, gx: number, gap: number): void {
  for (let x = x0 + WALL_STEP / 2; x < x1; x += WALL_STEP) if (Math.abs(x - gx) > gap / 2) items.push({ x, y, kind: HIT_POISON });
}

const spot = (rng: Rng, x0: number, x1: number, y0: number, y1: number): { x: number; y: number } => ({ x: rng.range(x0, x1), y: rng.range(y0, y1) });

// The layout's items (food food items, poison extra scattered poison besides the walls) and the learner's start for this seed.
export function placeLayout(layout: Layout, size: readonly [number, number], food: number, poison: number, seed: number): Placed {
  const rng = createRng(deriveSeed(seed, 0x1a70));
  const [w, h] = size;
  const items: ItemSpot[] = [];
  let start: { x: number; y: number; heading?: number };
  const walls: number[] = [];
  if (layout.kind === "fence") {
    const gx = rng.range(layout.gap, w - layout.gap);
    wall(items, w, h / 2, gx, layout.gap);
    walls.push(h / 2);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food - near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, MARGIN, h / 2 - 3 * MARGIN), kind: HIT_FOOD });
    for (let k = 0; k < near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, h / 2 + 2 * MARGIN, h - MARGIN), kind: HIT_FOOD });
    start = spot(rng, MARGIN, w - MARGIN, h / 2 + 3 * MARGIN, h - MARGIN);
  } else if (layout.kind === "maze") {
    const left = rng.next() < 0.5;
    const end = (atLeft: boolean): number => (atLeft ? layout.gap : w - layout.gap);
    wall(items, w, h / 3, end(left), layout.gap * 2);
    wall(items, w, (2 * h) / 3, end(!left), layout.gap * 2);
    walls.push((2 * h) / 3, h / 3);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food - near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, MARGIN, h / 3 - 2 * MARGIN), kind: HIT_FOOD });
    for (let k = 0; k < near; k++) items.push({ ...spot(rng, MARGIN, w - MARGIN, (2 * h) / 3 + MARGIN, h - MARGIN), kind: HIT_FOOD });
    start = spot(rng, MARGIN, w - MARGIN, (2 * h) / 3 + 2 * MARGIN, h - MARGIN);
  } else if (layout.kind === "rooms") {
    // Four rooms, a door in each of the four wall segments; the learner in one room, the food spread over the other three.
    const g = layout.gap;
    const door = (lo: number, hi: number): number => rng.range(lo + g / 2 + 10, hi - g / 2 - 10);
    vwall(items, w / 2, 0, h / 2, door(0, h / 2), g);
    vwall(items, w / 2, h / 2, h, door(h / 2, h), g);
    hwall(items, h / 2, 0, w / 2, door(0, w / 2), g);
    hwall(items, h / 2, w / 2, w, door(w / 2, w), g);
    const rooms = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    const home = rng.int(4);
    const inRoom = (r: readonly [number, number]): { x: number; y: number } => spot(rng, r[0] * (w / 2) + MARGIN, (r[0] + 1) * (w / 2) - MARGIN, r[1] * (h / 2) + MARGIN, (r[1] + 1) * (h / 2) - MARGIN);
    const others = rooms.filter((_, k) => k !== home);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food - near; k++) items.push({ ...inRoom(others[k % 3]!), kind: HIT_FOOD });
    for (let k = 0; k < near; k++) items.push({ ...inRoom(rooms[home]!), kind: HIT_FOOD });
    start = inRoom(rooms[home]!);
  } else if (layout.kind === "islands") {
    // Three islands kept apart, the food dealt round them; the learner starts in open water.
    const r = layout.radius;
    const centres: { x: number; y: number }[] = [];
    for (let tries = 0; centres.length < 3 && tries < 500; tries++) {
      const c = spot(rng, r + MARGIN, w - r - MARGIN, r + MARGIN, h - r - MARGIN);
      if (centres.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > 2.5 * r)) centres.push(c);
    }
    for (let k = 0; k < food; k++) {
      const c = centres[k % centres.length]!;
      const a = rng.next() * 2 * Math.PI;
      const d = r * Math.sqrt(rng.next());
      items.push({ x: c.x + d * Math.cos(a), y: c.y + d * Math.sin(a), kind: HIT_FOOD });
    }
    start = { x: w / 2, y: h / 2 };
    for (let tries = 0; centres.some((c) => Math.hypot(c.x - start.x, c.y - start.y) < r + 30) && tries < 100; tries++) start = spot(rng, MARGIN, w - MARGIN, MARGIN, h - MARGIN);
    // Extra poison stays off the islands, in the water between them.
    for (let k = 0, tries = 0; k < poison && tries < 2000; tries++) {
      const p = spot(rng, MARGIN, w - MARGIN, MARGIN, h - MARGIN);
      if (centres.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < r + 12) || Math.hypot(p.x - start.x, p.y - start.y) < 40) continue;
      items.push({ ...p, kind: HIT_POISON });
      k++;
    }
    return { items, start, walls };
  } else if (layout.kind === "cuedoor") {
    // A T-maze. The cue bite lies left or right just ahead of the start; a walled corridor above it straightens the way, so by the
    // doors only memory tells which side it was. The food waits deep in the cued room, out of sight from the doors.
    const wy = h / 2;
    const left = rng.next() < 0.5;
    hwall(items, wy, 0, w / 2, w / 5, 56);
    hwall(items, wy, w / 2, w, w - w / 5, 56);
    vwall(items, w / 2, 0, wy, -100, 0);
    for (const x of [w / 2 - 40, w / 2 + 40]) vwall(items, x, wy + 40, h - 110, -100, 0);
    start = { x: w / 2, y: h - 25, heading: -Math.PI / 2 };
    items.push({ x: w / 2 + (left ? -22 : 22), y: h - 75, kind: HIT_FOOD }); // the cue
    for (let k = 0; k < food; k++) items.push({ ...spot(rng, left ? MARGIN : w / 2 + MARGIN, left ? w / 2 - MARGIN : w - MARGIN, MARGIN, 70), kind: HIT_FOOD });
    return { items, start, walls };
  } else if (layout.kind === "flash") {
    // Food all round a central start, out of reach of a short look in one direction.
    start = { x: w / 2, y: h / 2 };
    const a0 = rng.next() * 2 * Math.PI;
    for (let k = 0; k < food; k++) {
      const a = a0 + (k * 2 * Math.PI) / food + rng.range(-0.3, 0.3);
      const d = rng.range(110, 150);
      items.push({ x: w / 2 + d * Math.cos(a), y: h / 2 + d * Math.sin(a), kind: HIT_FOOD });
    }
    return { items, start, walls };
  } else if (layout.kind === "stops") {
    // Clusters of food 150 to 190 from a central start, evenly spaced in angle: the nearest is a short walk, the others lie beyond sight.
    start = { x: w / 2, y: h / 2 };
    const n = layout.count ?? 3;
    const a0 = rng.next() * 2 * Math.PI;
    const centres = Array.from({ length: n }, (_, k) => {
      const a = a0 + (k * 2 * Math.PI) / n + rng.range(-0.2, 0.2);
      const d = rng.range(150, 190);
      return { x: w / 2 + d * Math.cos(a), y: h / 2 + d * Math.sin(a) };
    });
    for (let k = 0; k < food; k++) {
      const c = centres[k % n]!;
      const a = rng.next() * 2 * Math.PI;
      const d = 30 * Math.sqrt(rng.next());
      items.push({ x: c.x + d * Math.cos(a), y: c.y + d * Math.sin(a), kind: HIT_FOOD });
    }
    return { items, start, walls };
  } else if (layout.kind === "ring") {
    // Poison rings at the lane's inner and outer edge (spaced as walls), the food on the centre line at even angles after the start.
    const cx = w / 2;
    const cy = h / 2;
    const mid = Math.min(w, h) / 2 - layout.lane / 2 - MARGIN;
    const a0 = rng.next() * 2 * Math.PI;
    for (const rr of [mid - layout.lane / 2, mid + layout.lane / 2]) {
      const n = Math.max(6, Math.round((2 * Math.PI * rr) / WALL_STEP));
      for (let k = 0; k < n; k++) items.push({ x: cx + rr * Math.cos((2 * Math.PI * k) / n), y: cy + rr * Math.sin((2 * Math.PI * k) / n), kind: HIT_POISON });
    }
    const first = 50 / mid; // the first food a short way along the lane
    for (let k = 0; k < food; k++) {
      const a = a0 + first + (k * (2 * Math.PI - 2 * first)) / Math.max(1, food);
      items.push({ x: cx + mid * Math.cos(a), y: cy + mid * Math.sin(a), kind: HIT_FOOD });
    }
    start = { x: cx + mid * Math.cos(a0), y: cy + mid * Math.sin(a0) };
    return { items, start, walls };
  } else if (layout.kind === "sprint") {
    // Along the longer side: the learner near one end, every food in the last sixth at the other.
    const across = w >= h;
    const len = across ? w : h;
    const far = (t: number): number => len - MARGIN - t * (len / 6 - MARGIN);
    const near = Math.min(food, layout.near ?? 0);
    for (let k = 0; k < food; k++) {
      const along = k < near ? len * rng.range(0.4, 0.6) : far(rng.next());
      const side = rng.range(MARGIN, (across ? h : w) - MARGIN);
      items.push({ x: across ? along : side, y: across ? side : along, kind: HIT_FOOD });
    }
    start = across ? { x: MARGIN + 10, y: h / 2 } : { x: w / 2, y: MARGIN + 10 };
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
  return { items, start, walls };
}
