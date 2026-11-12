import { GROUND_PAD } from "../groundField.ts";
import type { GroundField } from "../groundField.ts";
import type { SpawnField } from "../spawnField.ts";
import type { Rng } from "../types.ts";

// The food and poison weights of a hand-designed map and the local caps derived from them, which every thread that runs the map needs.
// The generator that makes them (mapBuild.ts) and the map specs stay out of this file, so pages and threads that only run a map do not load them.

export interface Disc {
  x: number;
  y: number;
  r: number;
}

export const SHARE_UNIT = 255; // winter share byte per 1.0 (MapLayer.winterFood): 255 is all of the summer food
export const WEIGHT_UNIT = 64; // weight byte per 1.0, so weights run from 0 to just under 4
export const CAP_CELL = 1000; // world units per cell of the local caps
const OPEN_SAMPLES = 8; // sample points per side of a cap cell when finding its open share

// Whether a point is inside one of the discs, from a grid of the discs by centre made on the first call.
export function discsBlocked(rock: readonly Disc[], width: number): (x: number, y: number) => boolean {
  const cell = 300; // wider than the largest disc reach below
  const gc = Math.ceil(width / cell);
  let grid: Map<number, Disc[]> | null = null;
  return (x, y) => {
    if (!grid) {
      grid = new Map();
      for (const d of rock) {
        const key = Math.min(gc - 1, Math.floor(d.x / cell)) + gc * Math.floor(d.y / cell);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(d);
      }
    }
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let j = cy - 2; j <= cy + 2; j++) {
      for (let i = cx - 2; i <= cx + 2; i++) {
        if (i < 0 || j < 0 || i >= gc) continue;
        for (const d of grid.get(i + gc * j) ?? []) if ((d.x - x) ** 2 + (d.y - y) ** 2 < d.r * d.r) return true;
      }
    }
    return false;
  };
}

interface CapStats {
  capArea: Float64Array; // world area of each cap cell (the last row and column are partial)
  meanFood: Float64Array; // mean weight, 1 is plain
  meanPoison: Float64Array;
  open: Float64Array; // share of each cap cell that is not under rock
}

// Food and poison weights on the nodes of the ground raster (same geometry as GroundField), and their mean per cap cell.
export class MapWeights implements SpawnField {
  readonly exact = true;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly food: Uint8Array;
  readonly poison: Uint8Array;
  readonly paint: Uint8Array | null; // RGBA per node, a map's colour wash (looks only), or null
  readonly winter: Uint8Array | null; // per node the share of the food weight left at mid-winter (255 is all), or null for a map without winter ground
  readonly maxFood: number;
  readonly maxPoison: number;
  readonly capCols: number;
  readonly capRows: number;
  private readonly width: number;
  private readonly height: number;
  private readonly inv: number;
  private readonly blocked: (x: number, y: number) => boolean;
  private caps: CapStats | null = null; // made by the first use of the caps, which only the thread that counts items needs
  private loss = -1; // winterLoss, made on first use: ItemEconomy's constructor reads it, so a world's start pays it and no tick or drawing page does

  // blocked: whether a point is under rock, for the open share of the cap cells.
  constructor(ground: GroundField, food: Uint8Array, poison: Uint8Array, blocked: (x: number, y: number) => boolean, paint: Uint8Array | null = null, winter: Uint8Array | null = null) {
    this.cell = ground.cell;
    this.cols = ground.cols;
    this.rows = ground.rows;
    this.inv = 1 / ground.cell;
    this.food = food;
    this.poison = poison;
    this.paint = paint;
    this.winter = winter;
    this.blocked = blocked;
    this.maxFood = food.reduce((m, v) => Math.max(m, v), 0);
    this.maxPoison = poison.reduce((m, v) => Math.max(m, v), 0);
    this.width = ground.width;
    this.height = ground.height;
    this.capCols = Math.ceil(this.width / CAP_CELL);
    this.capRows = Math.ceil(this.height / CAP_CELL);
  }

  private get stats(): CapStats {
    return (this.caps ??= this.capStats());
  }

  get capArea(): Float64Array {
    return this.stats.capArea;
  }

  get meanFood(): Float64Array {
    return this.stats.meanFood;
  }

  get meanPoison(): Float64Array {
    return this.stats.meanPoison;
  }

  get open(): Float64Array {
    return this.stats.open;
  }

  private capStats(): CapStats {
    const { width, height, cols, rows, cell, food, poison } = this;
    const n = this.capCols * this.capRows;
    const capArea = new Float64Array(n);
    const meanFood = new Float64Array(n);
    const meanPoison = new Float64Array(n);
    const count = new Float64Array(n);
    for (let j = GROUND_PAD; j < rows - GROUND_PAD; j++) {
      for (let i = GROUND_PAD; i < cols - GROUND_PAD; i++) {
        const x = (i - GROUND_PAD) * cell;
        const y = (j - GROUND_PAD) * cell;
        if (x >= width || y >= height) continue;
        const c = this.capIndex(x, y);
        count[c]!++;
        meanFood[c]! += food[j * cols + i]! / WEIGHT_UNIT;
        meanPoison[c]! += poison[j * cols + i]! / WEIGHT_UNIT;
      }
    }
    for (let cy = 0; cy < this.capRows; cy++) {
      for (let cx = 0; cx < this.capCols; cx++) {
        const c = cy * this.capCols + cx;
        capArea[c] = (Math.min(width, (cx + 1) * CAP_CELL) - cx * CAP_CELL) * (Math.min(height, (cy + 1) * CAP_CELL) - cy * CAP_CELL);
        if (count[c]! > 0) {
          meanFood[c]! /= count[c]!;
          meanPoison[c]! /= count[c]!;
        } else {
          meanFood[c] = meanPoison[c] = 1;
        }
      }
    }
    const open = new Float64Array(n);
    for (let cy = 0; cy < this.capRows; cy++) {
      for (let cx = 0; cx < this.capCols; cx++) {
        let free = 0;
        for (let j = 0; j < OPEN_SAMPLES; j++) {
          for (let i = 0; i < OPEN_SAMPLES; i++) {
            const x = Math.min(width - 1, (cx + (i + 0.5) / OPEN_SAMPLES) * CAP_CELL);
            const y = Math.min(height - 1, (cy + (j + 0.5) / OPEN_SAMPLES) * CAP_CELL);
            if (!this.blocked(x, y)) free++;
          }
        }
        open[cy * this.capCols + cx] = free / OPEN_SAMPLES ** 2;
      }
    }
    return { capArea, meanFood, meanPoison, open };
  }

  // Whether the kind (0 food, 1 poison) has weight anywhere.
  usable(kind: number): boolean {
    return (kind === 0 ? this.maxFood : this.maxPoison) > 0;
  }

  get bytes(): number {
    return this.food.length + this.poison.length + (this.winter?.length ?? 0);
  }

  capIndex(x: number, y: number): number {
    const cx = Math.min(this.capCols - 1, Math.max(0, Math.floor(x / CAP_CELL)));
    const cy = Math.min(this.capRows - 1, Math.max(0, Math.floor(y / CAP_CELL)));
    return cy * this.capCols + cx;
  }

  // The index of the node nearest (x, y).
  private nodeAt(x: number, y: number): number {
    const i = Math.min(this.cols - 2, Math.max(1, Math.round(x * this.inv) + GROUND_PAD));
    const j = Math.min(this.rows - 2, Math.max(1, Math.round(y * this.inv) + GROUND_PAD));
    return j * this.cols + i;
  }

  // The weight byte of a kind (0 food, 1 poison) at (x, y): the nearest node's.
  byteAt(kind: number, x: number, y: number): number {
    return (kind === 0 ? this.food : this.poison)[this.nodeAt(x, y)]!;
  }

  // Whether a draw of rng lands inside the weight of a kind at (x, y): accepted with probability weight / maximum weight. On winter ground
  // the food weight fades towards its winter share as winterness (0 mid-summer, 1 mid-winter) rises; one draw either way.
  accepts(kind: number, x: number, y: number, rng: Rng, winterness = 0): boolean {
    if (kind !== 0) return rng.next() * this.maxPoison < this.poison[this.nodeAt(x, y)]!;
    const n = this.nodeAt(x, y);
    const w = this.winter;
    return rng.next() * this.maxFood < (w === null ? this.food[n]! : this.food[n]! * (1 - winterness * (1 - w[n]! / SHARE_UNIT)));
  }

  // The share of the food weight on open ground (nodes not under rock) that winter ground loses at mid-winter: sum of weight x (1 - share)
  // over sum of weight, 0 without winter ground. Regrowth scales by 1 - winterness x this.
  get winterLoss(): number {
    if (this.loss < 0) this.loss = this.winter ? this.lossOf(this.winter) : 0;
    return this.loss;
  }

  private lossOf(winter: Uint8Array): number {
    const { width, height, cols, rows, cell, food } = this;
    let all = 0;
    let lost = 0;
    for (let j = GROUND_PAD; j < rows - GROUND_PAD; j++) {
      for (let i = GROUND_PAD; i < cols - GROUND_PAD; i++) {
        const x = (i - GROUND_PAD) * cell;
        const y = (j - GROUND_PAD) * cell;
        if (x >= width || y >= height || this.blocked(x, y)) continue;
        const n = j * cols + i;
        all += food[n]!;
        lost += food[n]! * (1 - winter[n]! / SHARE_UNIT);
      }
    }
    return all > 0 ? lost / all : 0;
  }

  // Items allowed in each cap cell for a density of the kind (as the world setting): exactly round(density * perDensity) in all, shared out in
  // proportion to each cell's open (not under rock) area times its mean weight, rounded so the cells sum to the total (a cell of weight 0 holds none).
  limits(kind: number, density: number, perDensity: number): Int32Array {
    const { capArea, open } = this.stats;
    const mean = kind === 0 ? this.meanFood : this.meanPoison;
    const out = new Int32Array(capArea.length);
    const share = Float64Array.from(out, (_, c) => capArea[c]! * open[c]! * mean[c]!);
    const sum = share.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return out;
    const total = Math.round(density * perDensity);
    let run = 0;
    let before = 0;
    for (let c = 0; c < out.length; c++) {
      run += (total * share[c]!) / sum;
      const now = Math.round(run);
      out[c] = now - before;
      before = now;
    }
    return out;
  }
}
