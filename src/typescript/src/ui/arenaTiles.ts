import type { Recording } from "../sim/rl/recording.ts";
import { drawArena, frameAt, loopSeconds } from "./arenaScene.ts";
import { fitCanvas } from "./canvas.ts";

// One iteration's best candidate in its tiles: tile k plays recordings[k].
export interface Show {
  iter: number;
  genome: Float32Array;
  recordings: Recording[];
  names: string[]; // env name per recording
}

interface Tile {
  box: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  title: HTMLElement;
  stats: HTMLElement;
}

export const TILE_COUNTS = [1, 4, 9] as const;

// A grid of small canvases that replay the latest show. Each tile loops its own episode; a newer show waits until the longest one has played.
export class TileGrid {
  private tiles: Tile[] = [];
  private playing: Show | null = null;
  private queued: Show | null = null;
  private t0 = 0;
  private readonly root: HTMLElement;
  private loop = 0; // seconds of the longest recording of the playing show

  constructor(root: HTMLElement) {
    this.root = root;
  }

  get size(): number {
    return this.tiles.length;
  }

  get current(): Show | null {
    return this.playing;
  }

  // Rebuilds the grid for n tiles (1, 4 or 9).
  setCount(n: number): void {
    const cols = Math.round(Math.sqrt(n));
    this.root.style.setProperty("--cols", String(cols));
    this.root.replaceChildren();
    this.tiles = Array.from({ length: n }, () => {
      const box = document.createElement("figure");
      box.className = "tile-box";
      const canvas = document.createElement("canvas");
      const cap = document.createElement("figcaption");
      const title = document.createElement("b");
      const stats = document.createElement("span");
      cap.append(title, stats);
      box.append(canvas, cap);
      this.root.append(box);
      return { box, canvas, ctx: canvas.getContext("2d")!, title, stats };
    });
    if (this.playing) this.label();
  }

  clear(): void {
    this.playing = this.queued = null;
    for (const t of this.tiles) {
      t.title.textContent = "";
      t.stats.textContent = "";
    }
  }

  show(s: Show, now: number): void {
    if (this.playing) this.queued = s;
    else this.start(s, now);
  }

  private start(s: Show, now: number): void {
    this.playing = s;
    this.t0 = now;
    this.loop = Math.max(0.1, ...s.recordings.map(loopSeconds));
    this.label();
  }

  private label(): void {
    const s = this.playing!;
    this.tiles.forEach((t, k) => {
      const rec = s.recordings[k];
      t.box.hidden = !rec;
      if (!rec) return;
      t.title.textContent = s.names[k] ?? "";
      const r = rec.result;
      t.stats.textContent = `food ${r.food}, kills ${r.kills}, alive ${r.seconds.toFixed(0)} s`;
    });
  }

  // Draws every tile; returns tile 0's recording and frame for the brain view.
  draw(now: number): { rec: Recording; frame: number } | null {
    if (this.queued && (now - this.t0) / 1000 >= this.loop) {
      this.start(this.queued, now);
      this.queued = null;
    }
    const s = this.playing;
    const elapsed = (now - this.t0) / 1000;
    let first: { rec: Recording; frame: number } | null = null;
    this.tiles.forEach((tile, k) => {
      const rec = s?.recordings[k];
      if (!rec) return;
      const dpr = fitCanvas(tile.canvas);
      tile.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const f = frameAt(rec, elapsed); // each tile loops its own episode; a new show starts when the longest has played
      drawArena(tile.ctx, rec, f, tile.canvas.clientWidth, tile.canvas.clientHeight);
      if (k === 0) first = { rec, frame: f };
    });
    return first;
  }
}
