import { ITEM_RADIUS_RANGE } from "../config.ts";
import { MAX_MAP_DISC_R } from "./mapParts.ts";
import type { Disc } from "./weights.ts";

// Rock fill for a solidRock map (mapBuild): ground an item could lie on but no creature could reach becomes rock.

const SOLID_BODY = 12; // world units: the default creature's radius (config creature.radius), whose unreachable ground a solidRock map fills
const FILL_CELL = 4; // world units of the raster the unreachable ground is found on
const FILL_BUCKET = 400; // world units of the square each raster is centred on
const FILL_SLACK = 5; // world units: a cell counts as a creature position when its centre is this much closer to rock than a creature may be, so no channel a creature fits through is missed between cell centres
const FILL_HALO = 100; // world units of margin round it; sealed pockets up to about this size are found

// Fills the ground where an item could lie but no creature could reach it: slits, notches, pinholes and sealed pockets in and between rock.
// Judged for the smallest item and the default creature, on a raster round each FILL_BUCKET square with a FILL_HALO margin: a creature
// position counts as reachable when it connects to the raster's border, so a pocket smaller than the halo is always found. Each filling
// disc stops a grid step short of the nearest reachable creature position (exact Euclidean distance) and of the raster's edge, beyond
// which ground is unseen, so it never takes ground a creature could stand on. Reachability is judged generously (FILL_SLACK), never the other way.
// The squares are walked in a fixed order, so the result is the same on every build.
export function fillUnreachable(rock: Disc[], width: number, height: number): void {
  const S = FILL_CELL;
  const B = FILL_BUCKET;
  const halo = FILL_HALO;
  const n = Math.ceil((B + 2 * halo) / S);
  const item = ITEM_RADIUS_RANGE[0];
  const key = (bx: number, by: number): number => bx * 65536 + by;
  const byBucket = new Map<number, Disc[]>();
  const todo = new Set<number>();
  const index = (d: Disc): void => {
    const k = key(Math.floor(d.x / B), Math.floor(d.y / B));
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(d);
  };
  for (const d of rock) {
    index(d);
    for (let by = Math.max(0, Math.floor((d.y - d.r - item) / B)); by <= Math.floor((d.y + d.r + item) / B); by++) {
      for (let bx = Math.max(0, Math.floor((d.x - d.r - item) / B)); bx <= Math.floor((d.x + d.r + item) / B); bx++) todo.add(key(bx, by));
    }
  }
  const reach = Math.ceil((MAX_MAP_DISC_R + halo + SOLID_BODY) / B);
  const blocked = new Uint8Array(n * n); // bit 1: no item fits, bit 2: no creature fits
  const seen = new Uint8Array(n * n);
  const dist = new Float64Array(n * n);
  const line = new Float64Array(n);
  const src = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const stack = new Int32Array(n * n);
  for (const k of [...todo].sort((a, b) => a - b)) {
    const bx = Math.floor(k / 65536);
    const by = k - bx * 65536;
    const ox = bx * B - halo;
    const oy = by * B - halo;
    blocked.fill(0);
    if (ox < SOLID_BODY || oy < SOLID_BODY || ox + n * S > width - SOLID_BODY || oy + n * S > height - SOLID_BODY) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = ox + (i + 0.5) * S;
          const y = oy + (j + 0.5) * S;
          const edge = Math.min(x, y, width - x, height - y);
          blocked[j * n + i] = (edge < item ? 1 : 0) | (edge < SOLID_BODY ? 2 : 0);
        }
      }
    }
    const stamp = (d: Disc): void => {
      const outer = d.r + SOLID_BODY - FILL_SLACK;
      const r1 = (d.r + item) ** 2;
      const r2 = outer * outer;
      for (let j = Math.max(0, Math.floor((d.y - outer - oy) / S)); j <= Math.min(n - 1, Math.floor((d.y + outer - oy) / S)); j++) {
        const dy2 = (oy + (j + 0.5) * S - d.y) ** 2;
        for (let i = Math.max(0, Math.floor((d.x - outer - ox) / S)), row = j * n; i <= Math.min(n - 1, Math.floor((d.x + outer - ox) / S)); i++) {
          if (blocked[row + i] === 3) continue;
          const q = (ox + (i + 0.5) * S - d.x) ** 2 + dy2;
          if (q < r2) blocked[row + i] |= q < r1 ? 3 : 2;
        }
      }
    };
    for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) for (const d of byBucket.get(key(bx + a, by + b)) ?? []) stamp(d);
    const lo = Math.floor(halo / S);
    const hi = Math.min(n, lo + Math.ceil(B / S));
    let free = false; // any item ground in the core at all (not so inside a massif)
    for (let j = lo; j < hi && !free; j++) for (let i = lo; i < hi && !free; i++) free = !(blocked[j * n + i]! & 1);
    if (!free) continue;
    // creature positions joined to the border, then the distance of every cell to the nearest of them
    seen.fill(0);
    let top = 0;
    const visit = (m: number): void => {
      if (seen[m] || blocked[m]! & 2) return;
      seen[m] = 1;
      stack[top++] = m;
    };
    for (let c = 0; c < n; c++) {
      visit(c);
      visit((n - 1) * n + c);
      visit(c * n);
      visit(c * n + n - 1);
    }
    while (top > 0) {
      const q = stack[--top]!;
      const i = q % n;
      if (i > 0) visit(q - 1);
      if (i < n - 1) visit(q + 1);
      if (q >= n) visit(q - n);
      if (q + n < n * n) visit(q + n);
    }
    let any = false; // any item ground in the core that no creature position reaches
    for (let j = lo; j < hi && !any; j++) for (let i = lo; i < hi && !any; i++) any = !seen[j * n + i] && !(blocked[j * n + i]! & 1);
    if (!any) continue;
    for (let q = 0; q < n * n; q++) dist[q] = seen[q] ? 0 : Infinity;
    sqDist2d(dist, n, line, src, v, z);
    // in the core: world units to the nearest creature position found, or to the raster's edge when that is nearer (ground beyond it is unseen)
    for (let j = lo; j < hi; j++) for (let i = lo; i < hi; i++) dist[j * n + i] = Math.min(Math.sqrt(dist[j * n + i]!) * S, (Math.min(i, j, n - 1 - i, n - 1 - j) + 0.5) * S);
    // the core's unreachable item ground, deepest first, each filled by a disc reaching to the nearest creature position
    const lost: number[] = [];
    for (let j = lo; j < hi; j++) for (let i = lo; i < hi; i++) if (!(blocked[j * n + i]! & 1) && dist[j * n + i]! > SOLID_BODY + item) lost.push(j * n + i);
    lost.sort((a, b) => dist[b]! - dist[a]! || a - b);
    for (const q of lost) {
      if (blocked[q]! & 1) continue;
      const r = Math.min(MAX_MAP_DISC_R, Math.floor(dist[q]! - SOLID_BODY - S)); // a grid step short: a creature position may lie that far from its cell's centre
      if (r < 1) continue; // a sliver within a grid step of reach: left, rather than a loose speck of rock
      const d = { x: Math.round(ox + ((q % n) + 0.5) * S), y: Math.round(oy + (Math.floor(q / n) + 0.5) * S), r };
      rock.push(d);
      index(d);
      stamp(d);
    }
  }
}

// Squared Euclidean distance transform in place (Felzenszwalb and Huttenlocher): f holds 0 at the sources and Infinity elsewhere, in cells.
function sqDist2d(f: Float64Array, n: number, line: Float64Array, src: Float64Array, v: Int32Array, z: Float64Array): void {
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) line[k] = f[j * n + k]!;
    if (sqDist1d(line, src, n, v, z)) for (let k = 0; k < n; k++) f[j * n + k] = line[k]!;
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) line[k] = f[k * n + i]!;
    if (sqDist1d(line, src, n, v, z)) for (let k = 0; k < n; k++) f[k * n + i] = line[k]!;
  }
}

// One line of sqDist2d, in place; false (and the line untouched) when it has no finite value.
function sqDist1d(line: Float64Array, src: Float64Array, n: number, v: Int32Array, z: Float64Array): boolean {
  let m = -1;
  for (let q = 0; q < n; q++) {
    const fq = line[q]!;
    if (fq === Infinity) continue;
    if (m < 0) {
      m = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let sp = (fq + q * q - (line[v[m]!]! + v[m]! * v[m]!)) / (2 * q - 2 * v[m]!);
    while (sp <= z[m]!) {
      m--;
      sp = (fq + q * q - (line[v[m]!]! + v[m]! * v[m]!)) / (2 * q - 2 * v[m]!);
    }
    m++;
    v[m] = q;
    z[m] = sp;
    z[m + 1] = Infinity;
  }
  if (m < 0) return false;
  src.set(line); // the parabolas read the original values
  m = 0;
  for (let q = 0; q < n; q++) {
    while (z[m + 1]! < q) m++;
    line[q] = (q - v[m]!) ** 2 + src[v[m]!]!;
  }
  return true;
}
