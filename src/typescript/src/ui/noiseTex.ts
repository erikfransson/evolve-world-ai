import { createRng } from "../sim/rng.ts";
import { makeCanvas } from "./canvas.ts";

// Static textures of the abyssal look: value noise, and the seamless tiles and the world-sized floor image made from it. Everything here is
// painted once and cached; nothing animates.

type Canvas = OffscreenCanvas | HTMLCanvasElement;

const hash = (ix: number, iy: number, seed: number): number => {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// Smooth value noise in 0..1; with period > 0 it repeats every `period` lattice cells in both directions.
export function valueNoise(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (i: number): number => (period > 0 ? ((i % period) + period) % period : i);
  const x0 = wrap(ix);
  const x1 = wrap(ix + 1);
  const y0 = wrap(iy);
  const y1 = wrap(iy + 1);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Fractal noise in about -1..1: octaves of doubling frequency at half the amplitude. period is the lattice period of the first octave (0: none).
export function fbm(x: number, y: number, seed: number, octaves: number, period = 0): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let k = 0; k < octaves; k++) {
    sum += amp * (2 * valueNoise(x * f, y * f, seed + 17 * k, period * f) - 1);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

export const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function canvasOfPixels(w: number, h: number, px: Uint8ClampedArray<ArrayBuffer>): Canvas | null {
  if (typeof ImageData === "undefined") return null;
  const c = makeCanvas(w, h);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!c || !g) return null;
  g.putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

// A tile of N x N pixels covering `units` world units, made per pixel by fill(u, v, out) with u, v in 0..1 around the tile.
function pixelTile(n: number, fill: (u: number, v: number, out: number[]) => void): Canvas | null {
  const px = new Uint8ClampedArray(4 * n * n);
  const out = [0, 0, 0, 255];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out[3] = 255;
      fill(i / n, j / n, out);
      const k = 4 * (j * n + i);
      px[k] = out[0]!;
      px[k + 1] = out[1]!;
      px[k + 2] = out[2]!;
      px[k + 3] = out[3]!;
    }
  }
  return canvasOfPixels(n, n, px);
}

// Sediment ripples across a tile: stripes along an integer lattice direction (so the tile repeats), their phase bent by noise.
// kx, ky: stripe count across the tile along x and y; bend: how far the noise moves them, in stripes; returns -1..1.
export function ripple(u: number, v: number, kx: number, ky: number, bend: number, seed: number): number {
  const w = fbm(u * 4, v * 4, seed, 3, 4);
  const p = kx * u + ky * v + bend * w;
  const s = Math.sin(2 * Math.PI * p);
  return s + 0.25 * Math.sin(4 * Math.PI * p + 1.2);
}

// ---- Floor: one image over the whole world, large soft patches of silt, a few percent in lightness ----

const floorImages = new Map<string, Canvas | null>();
export const FLOOR_RGB = [10, 28, 33] as const;
export const FLOOR_CELL = 80; // world units per pixel of the floor image, at most

export function floorImage(width: number, height: number): { image: Canvas | null; cell: number } {
  const cell = Math.min(FLOOR_CELL, Math.max(8, Math.max(width, height) / 400));
  const w = Math.ceil(width / cell) + 1;
  const h = Math.ceil(height / cell) + 1;
  const key = `${w}x${h}`;
  let image = floorImages.get(key);
  if (image === undefined) {
    const px = new Uint8ClampedArray(4 * w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = i * cell;
        const y = j * cell;
        // broad drifts of silt, a lighter and a darker family, plus a faint finer mottle
        const n = 0.7 * fbm(x / 2600, y / 2600, 5, 3) + 0.3 * fbm(x / 520, y / 520, 9, 2);
        const k = 4 * (j * w + i);
        if (n > 0) {
          px[k] = 90;
          px[k + 1] = 170;
          px[k + 2] = 170;
          px[k + 3] = Math.round(255 * 0.07 * Math.min(1, n * 1.6));
        } else {
          px[k] = 0;
          px[k + 1] = 4;
          px[k + 2] = 8;
          px[k + 3] = Math.round(255 * 0.18 * Math.min(1, -n * 1.6));
        }
      }
    }
    image = canvasOfPixels(w, h, px);
    floorImages.set(key, image);
  }
  return { image, cell };
}

// Close up the floor shows the faintest ripples: an overlay tile (alpha only) of 1200 world units.
export const RIPPLE_UNITS = 1200;
let floorRipples: Canvas | null | undefined;
export function floorRippleTile(): Canvas | null {
  if (floorRipples === undefined) {
    floorRipples = pixelTile(512, (u, v, out) => {
      const r = ripple(u, v, 28, 9, 1.6, 31);
      const m = 0.5 + 0.5 * fbm(u * 3, v * 3, 33, 2, 3); // ripples come and go in patches
      const a = Math.min(1, Math.abs(r) * m * smooth(0.3, 0.8, m));
      if (r > 0) {
        out[0] = 120;
        out[1] = 190;
        out[2] = 190;
        out[3] = Math.round(255 * 0.025 * a);
      } else {
        out[0] = 0;
        out[1] = 6;
        out[2] = 10;
        out[3] = Math.round(255 * 0.06 * a);
      }
    });
  }
  return floorRipples;
}

// ---- Ground: a smooth colour tile (mottle and ripples) and a grain tile over it ----

export const GROUND_BASE_UNITS = 1200;
export const GROUND_GRAIN_UNITS = 320;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export interface GroundLook {
  base: readonly number[]; // rgb
  mottle: number; // lightness swing of the broad stains, fraction
  seed: number;
}

export interface RippleLook {
  light: readonly number[];
  dark: readonly number[];
  lightAlpha: number; // opacity of the crests and of the troughs at their strongest
  darkAlpha: number;
  stripes: readonly [number, number]; // stripes across the tile along x and y
  bend: number;
  seed: number;
}

export function groundBaseTile(look: GroundLook): Canvas | null {
  return pixelTile(512, (u, v, out) => {
    const l = 1 + look.mottle * (0.65 * fbm(u * 3, v * 3, look.seed, 4, 3) + 0.35 * fbm(u * 9, v * 9, look.seed + 8, 2, 9));
    out[0] = look.base[0]! * l;
    out[1] = look.base[1]! * l;
    out[2] = look.base[2]! * l;
  });
}

// Ripple marks as a transparent tile: pale crests and dark troughs in patches.
export function groundRippleTile(look: RippleLook): Canvas | null {
  return pixelTile(512, (u, v, out) => {
    const r = ripple(u, v, look.stripes[0], look.stripes[1], look.bend, look.seed);
    const patch = smooth(-0.15, 0.45, fbm(u * 2, v * 2, look.seed + 5, 2, 2)); // ripples come and go
    const a = Math.min(1, Math.abs(r)) * patch;
    const c = r > 0 ? look.light : look.dark;
    out[0] = c[0]!;
    out[1] = c[1]!;
    out[2] = c[2]!;
    out[3] = Math.round(255 * a * (r > 0 ? look.lightAlpha : look.darkAlpha));
  });
}

export interface GrainLook {
  light: readonly number[];
  dark: readonly number[];
  fine: number; // density of fine specks per pixel
  coarse: number; // density of larger pale grit per pixel
  shell: number; // density of bright shell fragments per pixel
  seed: number;
}

// Specks as a transparent tile: fine light and dark grain, larger grit, a few bright shell fragments.
export function groundGrainTile(look: GrainLook): Canvas | null {
  const N = 512;
  const c = makeCanvas(N, N);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!c || !g) return null;
  const rng = createRng(look.seed);
  const dot = (x: number, y: number, r: number, color: string): void => {
    g.fillStyle = color;
    for (const dx of [-N, 0, N]) {
      for (const dy of [-N, 0, N]) {
        if (x + dx < -r || x + dx > N + r || y + dy < -r || y + dy > N + r) continue;
        g.beginPath();
        g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
  const L = look.light;
  const D = look.dark;
  const nFine = Math.round(look.fine * N * N);
  for (let i = 0; i < nFine; i++) {
    const light = rng.next() < 0.5;
    const c3 = light ? L : D;
    dot(rng.range(0, N), rng.range(0, N), rng.range(0.5, 1.1), `rgba(${c3[0]}, ${c3[1]}, ${c3[2]}, ${rng.range(0.12, light ? 0.3 : 0.4).toFixed(3)})`);
  }
  const nCoarse = Math.round(look.coarse * N * N);
  for (let i = 0; i < nCoarse; i++) {
    const light = rng.next() < 0.6;
    const c3 = light ? L : D;
    dot(rng.range(0, N), rng.range(0, N), rng.range(1.0, 2.2), `rgba(${c3[0]}, ${c3[1]}, ${c3[2]}, ${rng.range(0.15, 0.4).toFixed(3)})`);
  }
  const nShell = Math.round(look.shell * N * N);
  for (let i = 0; i < nShell; i++) {
    const x = rng.range(0, N);
    const y = rng.range(0, N);
    const r = rng.range(1.2, 2.8);
    dot(x, y, r, `rgba(${L[0]! + 20}, ${L[1]! + 20}, ${L[2]! + 20}, ${rng.range(0.35, 0.7).toFixed(3)})`);
    dot(x + 0.5 * r, y + 0.6 * r, r * 0.8, "rgba(0, 0, 0, 0.18)"); // a fragment casts a hair of shadow, so grit reads as lying on the sand
  }
  return c;
}

// ---- Rock: pits and pale crust as transparent tiles ----

export const ROCK_TILE_UNITS = 360;

export function rockPitTile(): Canvas | null {
  const N = 512;
  const c = makeCanvas(N, N);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!c || !g) return null;
  const rng = createRng(61);
  const wrapped = (x: number, y: number, r: number, draw: (x: number, y: number) => void): void => {
    for (const dx of [-N, 0, N]) {
      for (const dy of [-N, 0, N]) {
        if (x + dx < -r - 3 || x + dx > N + r + 3 || y + dy < -r - 3 || y + dy > N + r + 3) continue;
        draw(x + dx, y + dy);
      }
    }
  };
  // broad soft blotches first
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, N);
    const y = rng.range(0, N);
    const r = rng.range(18, 50);
    const light = rng.next() < 0.45;
    wrapped(x, y, r, (px, py) => {
      const grad = g.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, light ? "rgba(150, 190, 190, 0.035)" : "rgba(0, 6, 10, 0.07)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      g.fillStyle = grad;
      g.fillRect(px - r, py - r, 2 * r, 2 * r);
    });
  }
  // pits: a dark hollow with a thin pale lip on the lower right, where it catches the light from above left
  for (let i = 0; i < 2200; i++) {
    const x = rng.range(0, N);
    const y = rng.range(0, N);
    const r = rng.next() < 0.88 ? rng.range(0.5, 1.3) : rng.range(1.3, 2.6);
    const a = rng.range(0.3, 0.65);
    wrapped(x, y, r, (px, py) => {
      g.fillStyle = `rgba(150, 190, 190, ${(a * 0.28).toFixed(3)})`;
      g.beginPath();
      g.arc(px + 0.45 * r, py + 0.55 * r, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `rgba(0, 5, 8, ${a.toFixed(3)})`;
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    });
  }
  return c;
}

// Pale encrusting speckle (sponge, coral, barnacle), clustered in patches: used through a band along the rock edge.
export function rockCrustTile(): Canvas | null {
  const N = 512;
  const c = makeCanvas(N, N);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!c || !g) return null;
  const rng = createRng(73);
  const TONES = ["226, 220, 196", "206, 214, 200", "214, 188, 176", "190, 206, 214"];
  for (let i = 0; i < 9000; i++) {
    const x = rng.range(0, N);
    const y = rng.range(0, N);
    const density = smooth(0.18, 0.5, 0.5 + 0.5 * fbm(x / N * 5, y / N * 5, 77, 3, 5)); // clumps of crust and bare rock between
    if (rng.next() > density) continue;
    const r = rng.next() < 0.8 ? rng.range(0.7, 1.6) : rng.range(1.6, 3.2);
    const tone = TONES[Math.floor(rng.next() * TONES.length)]!;
    const a = rng.range(0.3, 0.75);
    for (const dx of [-N, 0, N]) {
      for (const dy of [-N, 0, N]) {
        const px = x + dx;
        const py = y + dy;
        if (px < -r || px > N + r || py < -r || py > N + r) continue;
        g.fillStyle = `rgba(${tone}, ${a.toFixed(3)})`;
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return c;
}

export const mixColor = (a: readonly number[], b: readonly number[], t: number): number[] => [mix(a[0]!, b[0]!, t), mix(a[1]!, b[1]!, t), mix(a[2]!, b[2]!, t)];
