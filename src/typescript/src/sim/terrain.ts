import type { EngineConfig } from "./config.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { StatefulRng } from "./rng.ts";
import type { Body } from "./physics.ts";
import { buildGroundField } from "./groundField.ts";
import type { GroundField } from "./groundField.ts";
import { builtMap, mapSpec } from "./maps/index.ts";
import type { MapWeights } from "./maps/mapBuild.ts";

// Static map features (#34), generated deterministically from the run seed and the world settings, so every thread that builds
// the world gets the same ones. Rock (stones and ridges) is a set of discs that creatures bounce off like walls and rays report
// as walls. Slow and fast patches are a smooth field on a coarse raster (groundField.ts) under the creatures: they move at SLOW_FACTOR or
// FAST_FACTOR of their speed, and the brain senses which one it stands on. A density is the share of the world area covered, 0 for none.

export const TERRAIN_SLOW = -1;
export const TERRAIN_NORMAL = 0;
export const TERRAIN_FAST = 1;
export const SLOW_FACTOR = 0.5;
export const FAST_FACTOR = 1.75;
const FACTORS = [SLOW_FACTOR, 1, FAST_FACTOR] as const;

export const STONE_RADIUS = [250, 380] as const; // world units; capped at 20% of the shorter world side
const RIDGE_EDGE_DISC = 48; // radius of the discs along the edges of a ridge slab, which is a little wider than twice this
const EDGE_DISC = 0.28; // radius of the discs along a boulder edge, in boulder radii
const EDGE_SPACING = 0.35; // spacing of the discs along a boulder edge in their own radii, so an edge scallops by about 1 unit
const RIDGE_SPACING = 0.5; // the same along a ridge slab, whose discs are smaller, scalloping by about 1.5 units
const OUTCROP_GAP = 130; // free passage between the outcrops of a ridge, wider than a creature
const LOOSE_PEBBLES = 6;
export const MAX_DISCS_PER_PIECE = 240; // however long a ridge, so a map stays cheap to build, to look up and to draw
const GAP = 80; // free passage kept between rock and the walls and between pieces of rock, wider than a creature
const TRIES = 40; // placements tried per piece before giving up on the rest of its kind
const MAX_ROCK_SHARE = 0.4; // rock never covers more of the world than this, however high the setting
export const ROCK_CELL = 300; // world units per cell of the rock grid
const CLEAR_CELL = 100; // world units per square of keepOut's clear-of-rock raster

export const PATCH_SIZE_RANGE = [0.4, 2.5] as const; // the form's range for the size of a slow or fast patch, a multiple of the standard one
export const MAX_PIECES = 300; // pieces of one kind, however high the setting, so a map stays cheap to build and to look up
// The most the settings forms allow for each density; a saved or pasted config above these is refused.
export const MAP_DENSITY_MAX = { stoneDensity: 0.2, ridgeDensity: 0.15, slowDensity: 0.3, fastDensity: 0.3 } as const;

// Throws when a world's map densities are not numbers in 0 .. the form's maximum. Used by every path that reads settings from outside.
export function checkMapDensities(world: object): void {
  for (const [key, max] of Object.entries(MAP_DENSITY_MAX)) {
    const v = (world as Record<string, unknown>)[key];
    if (v !== undefined && !(typeof v === "number" && v >= 0 && v <= max)) throw new Error(`config "world.${key}" must be a number from 0 to ${max}`);
  }
}

// Throws when a world's map densities or patch sizes are outside the form's range. Used by every path that reads settings from outside.
export function checkMapSettings(world: object): void {
  checkMapDensities(world);
  const { map, width, height } = world as { map?: unknown; width?: unknown; height?: unknown };
  if (map !== undefined && map !== "") {
    const spec = typeof map === "string" ? mapSpec(map) : undefined;
    if (!spec) throw new Error(`config "world.map" must be "" or the name of a map`);
    if (width !== spec.width || height !== spec.height) throw new Error(`config "world.map" ${spec.name} needs a world of ${spec.width} x ${spec.height}`);
  }
  for (const key of ["slowSize", "fastSize"]) {
    const v = (world as Record<string, unknown>)[key];
    if (v !== undefined && !(typeof v === "number" && v >= PATCH_SIZE_RANGE[0] && v <= PATCH_SIZE_RANGE[1])) throw new Error(`config "world.${key}" must be a number from ${PATCH_SIZE_RANGE[0]} to ${PATCH_SIZE_RANGE[1]}`);
  }
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

// The settings that make the map, which key the cache.
export type TerrainSettings = Pick<EngineConfig, "seed"> & { world: Pick<EngineConfig["world"], "width" | "height" | "stoneDensity" | "ridgeDensity" | "slowDensity" | "fastDensity"> & Partial<Pick<EngineConfig["world"], "slowSize" | "fastSize" | "map">> };

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
  // Mud and firm ground as a raster field; null when the map has none.
  readonly ground: GroundField | null;
  // Food and poison weights of a hand-designed map (see maps/mapBuild.ts); null for the random map, where items spread evenly.
  readonly weights: MapWeights | null;
  readonly empty: boolean; // no rock and no patches

  constructor(rock: readonly Circle[], ground: GroundField | null, width: number, height: number, weights: MapWeights | null = null) {
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
    this.ground = ground;
    this.weights = weights;
    this.empty = rock.length === 0 && ground === null;
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
  // keepOut's early-out: one byte per CLEAR_CELL square, 1 where a disc of nearRadius could touch rock from somewhere inside it. Built on the first keepOut per radius.
  private nearRadius = NaN;
  private near = new Uint8Array(0);
  private nearCols = 0;
  private nearRows = 0;

  private buildNear(radius: number): void {
    const cols = (this.nearCols = Math.ceil(this.width / CLEAR_CELL));
    const rows = (this.nearRows = Math.ceil(this.height / CLEAR_CELL));
    const near = (this.near = new Uint8Array(cols * rows));
    for (let i = 0; i < this.rockCount; i++) {
      const x = this.rockX[i]!;
      const y = this.rockY[i]!;
      const reach = this.rockR[i]! + radius + 1; // +1 world unit of slack over the exact touch distance
      const c0 = Math.max(0, Math.floor((x - reach) / CLEAR_CELL));
      const c1 = Math.min(cols - 1, Math.floor((x + reach) / CLEAR_CELL));
      const r0 = Math.max(0, Math.floor((y - reach) / CLEAR_CELL));
      const r1 = Math.min(rows - 1, Math.floor((y + reach) / CLEAR_CELL));
      for (let r = r0; r <= r1; r++) {
        const dy = Math.max(r * CLEAR_CELL - y, 0, y - (r + 1) * CLEAR_CELL);
        for (let c = c0; c <= c1; c++) {
          const dx = Math.max(c * CLEAR_CELL - x, 0, x - (c + 1) * CLEAR_CELL);
          if (dx * dx + dy * dy < reach * reach) near[r * cols + c] = 1;
        }
      }
    }
    this.nearRadius = radius;
  }

  // -1 on slow ground, 1 on fast ground, 0 elsewhere.
  valueAt(x: number, y: number): number {
    return this.ground === null ? 0 : this.ground.valueAt(x, y);
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
    if (radius !== this.nearRadius) this.buildNear(radius);
    const nx0 = Math.floor(s.x / CLEAR_CELL);
    const ny0 = Math.floor(s.y / CLEAR_CELL);
    if (nx0 >= 0 && nx0 < this.nearCols && ny0 >= 0 && ny0 < this.nearRows && this.near[ny0 * this.nearCols + nx0] === 0) return; // no disc reaches this square (NaN fails the tests and takes the full path)
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

export const NO_TERRAIN = new Terrain([], null, 1, 1);

// Places pieces of one kind, each given by make and accepted by ok, until their area reaches the target, at least one, and appends
// their discs to placed (one array per piece). Stops early when a piece finds no room. Returns the area covered.
function place(target: number, make: () => { discs: Circle[]; area: number }, ok: (discs: Circle[]) => boolean, placed: Circle[][]): number {
  let covered = 0;
  for (let count = 0; (covered < target || count === 0) && count < MAX_PIECES; count++) {
    let piece: { discs: Circle[]; area: number } | null = null;
    for (let t = 0; t < TRIES && !piece; t++) {
      const candidate = make();
      if (ok(candidate.discs)) piece = candidate;
    }
    if (!piece) return covered;
    placed.push(piece.discs);
    covered += piece.area;
  }
  return covered;
}

const boundsOf = new WeakMap<readonly Circle[], Circle>(); // a piece's bounding circle, found once
const bounds = (discs: readonly Circle[]): Circle => {
  const known = boundsOf.get(discs);
  if (known) return known;
  const found = boundsFrom(discs);
  boundsOf.set(discs, found);
  return found;
};
const boundsFrom = (discs: readonly Circle[]): Circle => {
  const x = discs.reduce((s, d) => s + d.x, 0) / discs.length;
  const y = discs.reduce((s, d) => s + d.y, 0) / discs.length;
  return { x, y, r: discs.reduce((m, d) => Math.max(m, Math.hypot(d.x - x, d.y - y) + d.r), 0) };
};

const apart = (a: readonly Circle[], b: readonly Circle[], gap: number): boolean => a.every((p) => b.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r + gap));

// A boulder: an irregular polygon of seven to nine corners. Its edges are rows of small discs and a core disc fills the inside, so the
// union has straight edges and corners that read as angular rock.
function stone(rng: StatefulRng, w: number, h: number): { discs: Circle[]; area: number } {
  const cap = 0.2 * Math.min(w, h);
  const radius = rng.range(Math.min(STONE_RADIUS[0], cap), Math.min(STONE_RADIUS[1], cap));
  const n = 7 + rng.int(3);
  const cx = rng.range(1.15 * radius + GAP, w - 1.15 * radius - GAP);
  const cy = rng.range(1.15 * radius + GAP, h - 1.15 * radius - GAP);
  const rho = EDGE_DISC * radius;
  const corners: { x: number; y: number; reach: number; a: number }[] = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * (k + rng.range(-0.3, 0.3))) / n;
    const reach = radius * rng.range(0.72, 1.1);
    corners.push({ x: cx + (reach - rho) * Math.cos(a), y: cy + (reach - rho) * Math.sin(a), reach, a });
  }
  const discs: Circle[] = [];
  let area = 0;
  let nearest = Infinity;
  for (let k = 0; k < n; k++) {
    const p = corners[k]!;
    const q = corners[(k + 1) % n]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (EDGE_SPACING * rho)));
    for (let j = 0; j < steps; j++) discs.push({ x: p.x + ((q.x - p.x) * j) / steps, y: p.y + ((q.y - p.y) * j) / steps, r: rho });
    nearest = Math.min(nearest, Math.hypot((p.x + q.x) / 2 - cx, (p.y + q.y) / 2 - cy));
    area += 0.5 * p.reach * q.reach * Math.sin(2 * Math.PI / n);
  }
  // the inside: a second, smaller ring of larger discs and one at the centre, so no gap is left whichever way the corners fall
  for (let k = 0; k < n; k++) {
    const p = corners[k]!;
    discs.push({ x: cx + 0.45 * (p.x - cx), y: cy + 0.45 * (p.y - cy), r: 1.5 * rho });
  }
  discs.push({ x: cx, y: cy, r: Math.max(rho, 0.55 * nearest) });
  return { discs, area };
}

// A ridge: a rocky range along a gently bent spine, two or three outcrops with passable gaps between them. An outcrop is an angular
// slab, a polygon whose edge kinks along both sides and that tapers at the ends, built as rows of discs along its edges like a
// boulder. A few loose pebbles lie beside it.
function ridge(rng: StatefulRng, w: number, h: number): { discs: Circle[]; area: number } {
  const grow = Math.min(1.3, Math.max(1, Math.sqrt(Math.min(w, h) / 1500))); // bigger worlds get broader, longer ranges
  const rho = RIDGE_EDGE_DISC * grow;
  const length = Math.min(2400 * grow, Math.max(500, 0.45 * Math.min(w, h))) * rng.range(0.7, 1.3);
  let x = rng.range(GAP, w - GAP);
  let y = rng.range(GAP, h - GAP);
  let heading = rng.range(0, 2 * Math.PI);
  const bend = (rng.range(0.35, 0.9) * (rng.next() < 0.5 ? -1 : 1)) / length; // radians per unit length, a total turn of about half a radian
  const outcrops = length > 900 ? 2 + rng.int(2) : 1;
  const budget = (MAX_DISCS_PER_PIECE - LOOSE_PEBBLES - 8) / outcrops; // discs per outcrop; an outcrop has about 4 / rho per unit length
  const run = Math.min((length - OUTCROP_GAP * (outcrops - 1)) / outcrops, (budget * rho) / 4);
  const discs: Circle[] = [];
  const pebbles: Circle[] = [];
  let covered = 0;
  for (let o = 0; o < outcrops; o++) {
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    const segments = Math.max(2, Math.round(run / (1.5 * rho)));
    const step = run / segments;
    for (let i = 0; i <= segments; i++) {
      const swell = rho * 0.9 * Math.sin((Math.PI * i) / segments) ** 0.6; // the inset half width: how far the slab reaches past its edge discs
      const nx = -Math.sin(heading);
      const ny = Math.cos(heading);
      const wobble = rng.range(-0.55, 0.55) * rho; // the whole slab shifts sideways here, which kinks both edges
      const lw = wobble + swell * rng.range(0.15, 1);
      const rw = -wobble + swell * rng.range(0.15, 1);
      left.push([x + nx * lw, y + ny * lw]);
      right.push([x - nx * rw, y - ny * rw]);
      if (i % 3 === 1 && pebbles.length < LOOSE_PEBBLES && rng.next() < 0.6) {
        const r = rho * rng.range(0.25, 0.45);
        const off = (rng.next() < 0.5 ? -1 : 1) * (2.2 * rho + r + rng.range(50, 100));
        pebbles.push({ x: x + nx * off, y: y + ny * off, r });
      }
      x += step * Math.cos(heading);
      y += step * Math.sin(heading);
      heading += bend * step;
    }
    const loop = [...left, ...right.reverse()]; // the inset outline; its edges carry the discs
    for (let k = 0; k < loop.length; k++) {
      const [px, py] = loop[k]!;
      const [qx, qy] = loop[(k + 1) % loop.length]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / (RIDGE_SPACING * rho)));
      for (let j = 0; j < steps; j++) discs.push({ x: px + ((qx - px) * j) / steps, y: py + ((qy - py) * j) / steps, r: rho });
    }
    covered += run;
    x += OUTCROP_GAP * Math.cos(heading);
    y += OUTCROP_GAP * Math.sin(heading);
    heading += bend * OUTCROP_GAP;
  }
  // Pebbles stay clear of the slabs by more than a creature's width, or are dropped.
  for (const l of pebbles) if (discs.length < MAX_DISCS_PER_PIECE && discs.every((d) => Math.hypot(d.x - l.x, d.y - l.y) >= d.r + l.r + 45)) discs.push(l);
  return { discs, area: 2.8 * rho * covered };
}

const insideWorld = (discs: readonly Circle[], w: number, h: number): boolean => discs.every((d) => d.x >= d.r + GAP && d.x <= w - d.r - GAP && d.y >= d.r + GAP && d.y <= h - d.r - GAP);

function generate(config: TerrainSettings): Terrain {
  const { width: w, height: h, stoneDensity, ridgeDensity, slowDensity, fastDensity, slowSize = 1, fastSize = 1 } = config.world;
  const area = w * h;
  const stream = (kind: number): StatefulRng => createRng(deriveSeed(config.seed, 0x0b57, kind)); // one stream per kind, so a density change leaves the other kinds alone
  const rock: Circle[] = [];
  let rockArea = 0; // of the pieces placed so far, which overlap their own discs
  const pieces: Circle[][] = [];
  const rockOk = (discs: Circle[]): boolean => insideWorld(discs, w, h) && pieces.every((p) => apart([bounds(discs)], [bounds(p)], GAP) || apart(discs, p, GAP));
  const addRock = (density: number, kind: number, make: typeof stone): void => {
    const share = Math.min(density, MAX_ROCK_SHARE - rockArea / area);
    if (!(share > 0)) return;
    const rng = stream(kind);
    const before = pieces.length;
    rockArea += place(share * area, () => make(rng, w, h), rockOk, pieces);
    for (const p of pieces.slice(before)) rock.push(...p);
  };
  addRock(stoneDensity, 0, stone);
  addRock(ridgeDensity, 1, ridge);
  const ground = buildGroundField(w, h, [{ density: slowDensity, size: slowSize, rng: stream(2) }, { density: fastDensity, size: fastSize, rng: stream(3) }], config.seed, { maxBlobs: MAX_PIECES, tries: TRIES }); // mud layer, then firm
  return new Terrain(rock, ground, w, h);
}

const cache = new Map<string, Terrain>();
const mapTerrains = new Map<string, Terrain>(); // by map name; few and large, so never evicted

// The Terrain of a named map, which does not depend on the seed. Throws for an unknown name or a world of the wrong size.
function mapTerrain(name: string, width: number, height: number): Terrain {
  const spec = mapSpec(name);
  if (!spec) throw new Error(`unknown map "${name}"`);
  if (width !== spec.width || height !== spec.height) throw new Error(`map ${name} needs a world of ${spec.width} x ${spec.height}`);
  let t = mapTerrains.get(name);
  if (!t) {
    const b = builtMap(name);
    mapTerrains.set(name, (t = new Terrain(b.rock, b.ground, width, height, b.weights)));
  }
  return t;
}

// The map of a config, built once per process and shared by every world and creature that uses it.
export function terrainOf(config: TerrainSettings): Terrain {
  const { width, height } = config.world;
  if (config.world.map) return mapTerrain(config.world.map, width, height);
  const limit = (key: keyof typeof MAP_DENSITY_MAX): number => Math.min(MAP_DENSITY_MAX[key], Math.max(0, config.world[key]) || 0); // defence in depth: callers that skip checkMapDensities get the form's range
  const [stoneDensity, ridgeDensity, slowDensity, fastDensity] = [limit("stoneDensity"), limit("ridgeDensity"), limit("slowDensity"), limit("fastDensity")] as const;
  if (!(stoneDensity > 0 || ridgeDensity > 0 || slowDensity > 0 || fastDensity > 0)) return NO_TERRAIN;
  const size = (v: number | undefined): number => Math.min(PATCH_SIZE_RANGE[1], Math.max(PATCH_SIZE_RANGE[0], v ?? 1)) || 1; // the same defence for the patch sizes
  const [slowSize, fastSize] = [size(config.world.slowSize), size(config.world.fastSize)] as const;
  const key = [config.seed, width, height, stoneDensity, ridgeDensity, slowDensity, fastDensity, slowSize, fastSize].join("|");
  let t = cache.get(key);
  if (!t) {
    if (cache.size >= 8) cache.clear(); // settings edited in a form make many keys; keep only the recent ones
    cache.set(key, (t = generate({ seed: config.seed, world: { width, height, stoneDensity, ridgeDensity, slowDensity, fastDensity, slowSize, fastSize } })));
  }
  return t;
}
