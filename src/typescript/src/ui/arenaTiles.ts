import type { Recording } from "../sim/rl/recording.ts";
import { drawArena, frameAt, loopSeconds } from "./arenaScene.ts";
import { fitCanvas } from "./canvas.ts";

// One iteration's best candidate in its tiles: tile k plays recordings[k].
export interface Show {
  iter: number;
  genome: Float32Array;
  recordings: Recording[];
  names: string[]; // env name per recording
  envCount: number; // recordings[k] plays env k % envCount
  policy?: boolean; // the current policy of a backprop run, not an iteration's best candidate
}

// Tile grid shapes: the desktop column count per tile count (phones use 2 columns in CSS).
export const TILE_COUNTS = [1, 4, 6, 12] as const;
export const DEFAULT_TILES = 12;
export const tileColumns = (n: number): number => (n <= 1 ? 1 : n === 4 ? 2 : n === 6 ? 3 : 4);

// "Forage box · best of iteration 42 · layout 3": the scenario, which learner, and which of that scenario's layouts (tile index within its env + 1).
export function tileTitle(name: string, iter: number, k: number, envCount: number, policy = false): string {
  const learner = iter === 0 ? "starting creature" : policy ? `policy at update ${iter}` : `best of iteration ${iter}`;
  return `${name} · ${learner} · layout ${Math.floor(k / Math.max(1, envCount)) + 1}`;
}

// The live result line of a recording; kills only when there were any.
export const resultLine = (r: { food: number; kills: number; seconds: number }): string => `food ${r.food}${r.kills > 0 ? `, kills ${r.kills}` : ""}, alive ${r.seconds.toFixed(0)} s`;

// Where the opened-large view draws: its canvas and caption lines.
export interface ZoomTarget {
  canvas: HTMLCanvasElement;
  title: HTMLElement;
  stats: HTMLElement;
}

interface Tile {
  box: HTMLElement;
  canvas: HTMLCanvasElement;
  title: HTMLElement;
  stats: HTMLElement;
}

// A grid of small canvases that replay the latest show. Each tile loops its own episode; a newer show waits until the longest one has played.
export class TileGrid {
  private tiles: Tile[] = [];
  private playing: Show | null = null;
  private queued: Show | null = null;
  private t0 = 0;
  private readonly root: HTMLElement;
  private loop = 0; // seconds of the longest recording of the playing show
  private clock = 0; // playback seconds into the playing show, advanced by real time times speed
  private last = 0;
  private zoom: { k: number; target: ZoomTarget } | null = null;
  speed = 4; // playback seconds per real second; 0 is Max: the tiles hold their frame and a new show replaces the playing one
  paused = false; // holds every tile, and the large view, on its current frame
  onOpen: (k: number) => void = () => {};
  onFinished: () => void = () => {}; // once per show, when every tile has played to the end and no newer show waits
  private asked = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  get size(): number {
    return this.tiles.length;
  }

  get current(): Show | null {
    return this.playing;
  }

  // Rebuilds the grid for n tiles (one of TILE_COUNTS).
  setCount(n: number): void {
    this.root.style.setProperty("--cols", String(tileColumns(n)));
    this.root.replaceChildren();
    this.tiles = Array.from({ length: n }, (_, k) => {
      const box = document.createElement("figure");
      box.className = "tile-box";
      box.tabIndex = 0;
      box.setAttribute("role", "button");
      box.title = "Open large";
      box.addEventListener("click", () => this.onOpen(k));
      box.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        this.onOpen(k);
      });
      const canvas = document.createElement("canvas");
      const cap = document.createElement("figcaption");
      const title = document.createElement("b");
      const stats = document.createElement("span");
      cap.append(title, stats);
      box.append(canvas, cap);
      this.root.append(box);
      return { box, canvas, title, stats };
    });
    if (this.playing) this.label();
  }

  clear(): void {
    this.playing = this.queued = null;
    for (const t of this.tiles) {
      t.box.hidden = false;
      t.title.textContent = "";
      t.stats.textContent = "";
    }
  }

  // Shows tile k's recording large in `target` (null closes it); it keeps following tile k when a new show arrives.
  setZoom(k: number | null, target?: ZoomTarget): void {
    this.zoom = k === null || !target ? null : { k, target };
    if (this.playing) this.label();
  }

  show(s: Show, now: number): void {
    if (this.playing && this.speed > 0) this.queued = s;
    else this.start(s, now);
  }

  private start(s: Show, now: number): void {
    this.playing = s;
    this.asked = false;
    this.clock = 0;
    this.last = now;
    this.loop = Math.max(0.1, ...s.recordings.map(loopSeconds));
    this.label();
  }

  private label(): void {
    const s = this.playing!;
    const put = (k: number, title: HTMLElement, stats: HTMLElement): void => {
      const rec = s.recordings[k]!;
      title.textContent = tileTitle(s.names[k] ?? "", s.iter, k, s.envCount, s.policy);
      stats.textContent = resultLine(rec.result);
    };
    this.tiles.forEach((t, k) => {
      t.box.hidden = !s.recordings[k];
      if (s.recordings[k]) put(k, t.title, t.stats);
    });
    if (this.zoom && s.recordings[this.zoom.k]) put(this.zoom.k, this.zoom.target.title, this.zoom.target.stats);
  }

  // Draws every tile and the opened one; returns tile 0's recording and frame for the brain view.
  draw(now: number): { rec: Recording; frame: number } | null {
    if (!this.paused) this.clock += Math.min(0.25, Math.max(0, (now - this.last) / 1000)) * this.speed; // the cap keeps a background tab from jumping ahead
    this.last = now;
    if (this.queued && this.clock >= this.loop) {
      this.start(this.queued, now);
      this.queued = null;
    }
    const s = this.playing;
    if (s && !this.queued && !this.asked && this.clock >= this.loop) {
      this.asked = true;
      this.onFinished();
    }
    let first: { rec: Recording; frame: number } | null = null;
    const paint = (rec: Recording, canvas: HTMLCanvasElement): number => {
      const dpr = fitCanvas(canvas);
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const f = frameAt(rec, this.clock); // each tile loops its own episode; a new show starts when the longest has played
      drawArena(ctx, rec, f, canvas.clientWidth, canvas.clientHeight);
      return f;
    };
    this.tiles.forEach((tile, k) => {
      const rec = s?.recordings[k];
      if (!rec) return;
      const f = paint(rec, tile.canvas);
      if (k === 0) first = { rec, frame: f };
    });
    const zoomRec = this.zoom && s?.recordings[this.zoom.k];
    if (this.zoom && zoomRec) paint(zoomRec, this.zoom.target.canvas);
    return first;
  }
}
