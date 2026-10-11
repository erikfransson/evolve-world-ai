import type { EngineConfig } from "./config.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { StatefulRng } from "./rng.ts";

// Static map features (#34), generated deterministically from the run seed and the world settings, so every thread that builds
// the world gets the same ones. Rock (stones and ridges) is a set of discs that creatures bounce off like walls and rays report
// as walls. Slow and fast patches are unions of discs under the creatures: they move at SLOW_FACTOR or FAST_FACTOR of their
// speed, and the brain senses which one it stands on. A density is the share of the world area covered, 0 for none.

export const TERRAIN_SLOW = -1;
export const TERRAIN_NORMAL = 0;
export const TERRAIN_FAST = 1;
export const SLOW_FACTOR = 0.5;
export const FAST_FACTOR = 1.75;
const FACTORS = [SLOW_FACTOR, 1, FAST_FACTOR] as const;

export const STONE_RADIUS = [250, 380] as const; // world units; capped at 20% of the shorter world side
const RIDGE_HALF_WIDTH = 56; // mean; the crest swells and narrows along its length
const RIDGE_STEP = 0.75; // disc spacing in radii; the edge scallops are about 3% of the width
const GAP = 80; // free passage kept between rock and the walls and between pieces of rock, wider than a creature
const TRIES = 40; // placements tried per piece before giving up on the rest of its kind
const MAX_ROCK_SHARE = 0.4; // rock never covers more of the world than this, however high the setting
export const ROCK_CELL = 300; // world units per cell of the rock grid

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

// The settings that make the map, which key the cache.
export type TerrainSettings = Pick<EngineConfig, "seed"> & { world: Pick<EngineConfig["world"], "width" | "height" | "stoneDensity" | "ridgeDensity" | "slowDensity" | "fastDensity"> };

export class Terrain {
  readonly width: number;
  readonly height: number;
  // Rock discs, then the grid: disc i sits in the cell of its centre; cell c holds discs rockOrder[rockStart[c] .. rockStart[c + 1] - 1] in index order.
  readonly rockX: Float64Array;
  readonly rockY: Float64Array;
  readonly rockR: Float64Array;
  readonly rockCount: number;
  readonly maxRockR: number;
  readonly cols: number;
  readonly rows: number;
  readonly rockStart: Int32Array;
  readonly rockOrder: Int32Array;
  // Patch discs of both kinds; patches of different kinds never overlap.
  readonly patchX: Float64Array;
  readonly patchY: Float64Array;
  readonly patchR: Float64Array;
  readonly patchKind: Int8Array;
  readonly empty: boolean; // no rock and no patches

  constructor(rock: readonly Circle[], patches: readonly (Circle & { kind: number })[], width: number, height: number) {
    this.width = width;
    this.height = height;
    this.rockCount = rock.length;
    this.rockX = Float64Array.from(rock, (d) => d.x);
    this.rockY = Float64Array.from(rock, (d) => d.y);
    this.rockR = Float64Array.from(rock, (d) => d.r);
    this.maxRockR = rock.reduce((m, d) => Math.max(m, d.r), 0);
    this.cols = Math.max(1, Math.ceil(width / ROCK_CELL));
    this.rows = Math.max(1, Math.ceil(height / ROCK_CELL));
    const cellOf = rock.map((d) => this.cellOf(d.x, d.y));
    this.rockStart = new Int32Array(this.cols * this.rows + 1);
    for (const c of cellOf) this.rockStart[c + 1]!++;
    for (let c = 0; c < this.cols * this.rows; c++) this.rockStart[c + 1]! += this.rockStart[c]!;
    const fill = this.rockStart.slice(0, -1);
    this.rockOrder = new Int32Array(rock.length);
    cellOf.forEach((c, i) => (this.rockOrder[fill[c]!++] = i));
    this.patchX = Float64Array.from(patches, (d) => d.x);
    this.patchY = Float64Array.from(patches, (d) => d.y);
    this.patchR = Float64Array.from(patches, (d) => d.r);
    this.patchKind = Int8Array.from(patches, (d) => d.kind);
    this.empty = rock.length === 0 && patches.length === 0;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / ROCK_CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / ROCK_CELL)));
    return cy * this.cols + cx;
  }

  // Grid cells that can hold a disc touching the square of half-width reach around (x, y), clamped: [cx0, cx1, cy0, cy1].
  cellRange(x: number, y: number, reach: number, out: Int32Array): void {
    const e = reach + this.maxRockR;
    const inv = 1 / ROCK_CELL;
    out[0] = Math.max(0, Math.floor((x - e) * inv));
    out[1] = Math.min(this.cols - 1, Math.floor((x + e) * inv));
    out[2] = Math.max(0, Math.floor((y - e) * inv));
    out[3] = Math.min(this.rows - 1, Math.floor((y + e) * inv));
  }

  private readonly range = new Int32Array(4);

  // -1 on slow ground, 1 on fast ground, 0 elsewhere.
  valueAt(x: number, y: number): number {
    for (let i = 0; i < this.patchX.length; i++) {
      const dx = x - this.patchX[i]!;
      const dy = y - this.patchY[i]!;
      if (dx * dx + dy * dy < this.patchR[i]! ** 2) return this.patchKind[i]!;
    }
    return 0;
  }

  // Speed multiplier of a terrain value from valueAt.
  static factor(value: number): number {
    return FACTORS[value + 1]!;
  }

  // True when a disc of this radius at (x, y) overlaps rock.
  touchesRock(x: number, y: number, radius: number): boolean {
    if (this.rockCount === 0) return false;
    const range = this.range;
    this.cellRange(x, y, radius, range);
    for (let cy = range[2]!; cy <= range[3]!; cy++) {
      for (let k = this.rockStart[cy * this.cols + range[0]!]!, end = this.rockStart[cy * this.cols + range[1]! + 1]!; k < end; k++) {
        const i = this.rockOrder[k]!;
        const reach = this.rockR[i]! + radius;
        if ((x - this.rockX[i]!) ** 2 + (y - this.rockY[i]!) ** 2 < reach * reach) return true;
      }
    }
    return false;
  }

  // Pushes a disc of this radius out of the rock along the contact normal and reflects the velocity pointing into it, scaled by
  // restitution like a wall. Repeats a few times, since leaving one disc of a ridge can enter the next.
  keepOut(s: Body, radius: number, restitution: number): void {
    if (this.rockCount === 0) return;
    const range = this.range;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      this.cellRange(s.x, s.y, radius, range);
      for (let cy = range[2]!; cy <= range[3]!; cy++) {
        for (let k = this.rockStart[cy * this.cols + range[0]!]!, end = this.rockStart[cy * this.cols + range[1]! + 1]!; k < end; k++) {
          const i = this.rockOrder[k]!;
          const reach = this.rockR[i]! + radius;
          let nx = s.x - this.rockX[i]!;
          let ny = s.y - this.rockY[i]!;
          const d2 = nx * nx + ny * ny;
          if (d2 >= reach * reach) continue;
          const d = Math.sqrt(d2);
          if (d > 0) {
            nx /= d;
            ny /= d;
          } else {
            nx = 1; // centre on centre: leave along +x
            ny = 0;
          }
          s.x = this.rockX[i]! + nx * reach;
          s.y = this.rockY[i]! + ny * reach;
          const into = s.vx * nx + s.vy * ny;
          if (into < 0) {
            s.vx -= (1 + restitution) * into * nx;
            s.vy -= (1 + restitution) * into * ny;
          }
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  // The free spot (clear of rock by radius) nearest to (x, y) on rings of growing size, (x, y) itself when it is free.
  nearestFree(x: number, y: number, radius: number): { x: number; y: number } {
    if (!this.touchesRock(x, y, radius)) return { x, y };
    for (let ring = 1; ring < 400; ring++) {
      const d = ring * radius;
      const points = ring * 8;
      for (let k = 0; k < points; k++) {
        const a = (2 * Math.PI * k) / points;
        const px = Math.min(this.width - radius, Math.max(radius, x + d * Math.cos(a)));
        const py = Math.min(this.height - radius, Math.max(radius, y + d * Math.sin(a)));
        if (!this.touchesRock(px, py, radius)) return { x: px, y: py };
      }
    }
    return { x, y };
  }
}

export const NO_TERRAIN = new Terrain([], [], 1, 1);

// Places pieces of one kind, each given by make and accepted by ok, until their area reaches the target, at least one, and appends
// their discs to placed (one array per piece). Stops early when a piece finds no room.
function place(target: number, make: () => { discs: Circle[]; area: number }, ok: (discs: Circle[]) => boolean, placed: Circle[][]): void {
  let covered = 0;
  for (let count = 0; covered < target || count === 0; count++) {
    let piece: { discs: Circle[]; area: number } | null = null;
    for (let t = 0; t < TRIES && !piece; t++) {
      const candidate = make();
      if (ok(candidate.discs)) piece = candidate;
    }
    if (!piece) return;
    placed.push(piece.discs);
    covered += piece.area;
  }
}

const bounds = (discs: readonly Circle[]): Circle => {
  const x = discs.reduce((s, d) => s + d.x, 0) / discs.length;
  const y = discs.reduce((s, d) => s + d.y, 0) / discs.length;
  return { x, y, r: discs.reduce((m, d) => Math.max(m, Math.hypot(d.x - x, d.y - y) + d.r), 0) };
};

const apart = (a: readonly Circle[], b: readonly Circle[], gap: number): boolean => a.every((p) => b.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r + gap));

// A stone: one big disc.
function stone(rng: StatefulRng, w: number, h: number): { discs: Circle[]; area: number } {
  const cap = 0.2 * Math.min(w, h);
  const r = rng.range(Math.min(STONE_RADIUS[0], cap), Math.min(STONE_RADIUS[1], cap));
  return { discs: [{ x: rng.range(r + GAP, w - r - GAP), y: rng.range(r + GAP, h - r - GAP), r }], area: Math.PI * r * r };
}

// A ridge: a gently bending chain of overlapping discs whose width swells and narrows along it.
function ridge(rng: StatefulRng, w: number, h: number): { discs: Circle[]; area: number } {
  const length = Math.min(2400, Math.max(500, 0.45 * Math.min(w, h))) * rng.range(0.7, 1.3);
  let x = rng.range(GAP, w - GAP);
  let y = rng.range(GAP, h - GAP);
  let heading = rng.range(0, 2 * Math.PI);
  const bend = (rng.range(0.6, 1.4) * (rng.next() < 0.5 ? -1 : 1)) / length; // radians per unit length, a total turn of about a radian
  const swell = [rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI)];
  const discs: Circle[] = [];
  for (let s = 0; s < length; ) {
    const r = RIDGE_HALF_WIDTH * (1 + 0.2 * Math.sin(s / 220 + swell[0]!) + 0.1 * Math.sin(s / 90 + swell[1]!));
    discs.push({ x, y, r });
    const step = RIDGE_STEP * r;
    x += step * Math.cos(heading);
    y += step * Math.sin(heading);
    heading += bend * step;
    s += step;
  }
  return { discs, area: 2 * RIDGE_HALF_WIDTH * length };
}

// A patch: a blob of three to five discs around a larger centre one.
function patch(rng: StatefulRng, w: number, h: number): { discs: Circle[]; area: number } {
  const r0 = Math.min(550, Math.max(150, 0.08 * Math.min(w, h))) * rng.range(0.8, 1.2);
  const cx = rng.range(0, w);
  const cy = rng.range(0, h);
  const discs: Circle[] = [{ x: cx, y: cy, r: r0 }];
  const extra = 2 + rng.int(3);
  for (let k = 0; k < extra; k++) {
    const a = rng.range(0, 2 * Math.PI);
    const d = r0 * rng.range(0.5, 0.9);
    discs.push({ x: cx + d * Math.cos(a), y: cy + d * Math.sin(a), r: r0 * rng.range(0.5, 0.85) });
  }
  return { discs, area: 0.7 * discs.reduce((s, d) => s + Math.PI * d.r * d.r, 0) };
}

const insideWorld = (discs: readonly Circle[], w: number, h: number): boolean => discs.every((d) => d.x >= d.r + GAP && d.x <= w - d.r - GAP && d.y >= d.r + GAP && d.y <= h - d.r - GAP);

function generate(config: TerrainSettings): Terrain {
  const { width: w, height: h, stoneDensity, ridgeDensity, slowDensity, fastDensity } = config.world;
  const area = w * h;
  const stream = (kind: number): StatefulRng => createRng(deriveSeed(config.seed, 0x0b57, kind)); // one stream per kind, so a density change leaves the other kinds alone
  const rock: Circle[] = [];
  const pieces: Circle[][] = [];
  const rockOk = (discs: Circle[]): boolean => insideWorld(discs, w, h) && pieces.every((p) => apart([bounds(discs)], [bounds(p)], GAP) || apart(discs, p, GAP));
  const addRock = (density: number, kind: number, make: typeof stone): void => {
    const share = Math.min(density, MAX_ROCK_SHARE - rock.reduce((s, d) => s + Math.PI * d.r * d.r, 0) / area);
    if (!(share > 0)) return;
    const rng = stream(kind);
    const before = pieces.length;
    place(share * area, () => make(rng, w, h), rockOk, pieces);
    for (const p of pieces.slice(before)) rock.push(...p);
  };
  addRock(stoneDensity, 0, stone);
  addRock(ridgeDensity, 1, ridge);
  const patches: (Circle & { kind: number })[] = [];
  const patchPieces: Circle[][] = [];
  for (const [density, kind, id] of [[slowDensity, TERRAIN_SLOW, 2], [fastDensity, TERRAIN_FAST, 3]] as const) {
    if (!(density > 0)) continue;
    const rng = stream(id);
    const before = patchPieces.length;
    place(density * area, () => patch(rng, w, h), (discs) => patchPieces.every((p) => apart(discs, p, 0)), patchPieces);
    for (const p of patchPieces.slice(before)) for (const d of p) patches.push({ ...d, kind });
  }
  return new Terrain(rock, patches, w, h);
}

const cache = new Map<string, Terrain>();

// The map of a config, built once per process and shared by every world and creature that uses it.
export function terrainOf(config: TerrainSettings): Terrain {
  const { width, height, stoneDensity, ridgeDensity, slowDensity, fastDensity } = config.world;
  if (!(stoneDensity > 0 || ridgeDensity > 0 || slowDensity > 0 || fastDensity > 0)) return NO_TERRAIN;
  const key = [config.seed, width, height, stoneDensity, ridgeDensity, slowDensity, fastDensity].join("|");
  let t = cache.get(key);
  if (!t) {
    if (cache.size >= 8) cache.clear(); // settings edited in a form make many keys; keep only the recent ones
    cache.set(key, (t = generate(config)));
  }
  return t;
}
