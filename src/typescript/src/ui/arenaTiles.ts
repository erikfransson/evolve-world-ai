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
  preview?: boolean; // the gallery's sample clips of the chosen envs, before a run
}

// A per-env change of held-out reward for the tile badges.
export interface Badge {
  text: string;
  dir: "up" | "down" | "flat";
}

// The small line under a tile's env name: which learner, and the layout when an env has more than one tile.
export function tileSub(s: Pick<Show, "iter" | "policy" | "preview" | "envCount">, k: number, total: number): string {
  if (s.preview) return "sample clip";
  const learner = s.iter === 0 ? "starting creature" : s.policy ? `policy, update ${s.iter}` : `best of iteration ${s.iter}`;
  return total > s.envCount ? `${learner} · layout ${Math.floor(k / Math.max(1, s.envCount)) + 1}` : learner;
}

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
  k: number; // the recording this tile plays
  box: HTMLElement;
  canvas: HTMLCanvasElement;
  title: HTMLElement;
  sub: HTMLElement;
  stats: HTMLElement;
  badge: HTMLElement;
}

// A grid of small canvases that replay the latest show, one per slot (a recording index). Each tile loops its own episode; a newer show waits
// until the longest one has played.
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
  private badges: readonly (Badge | null)[] = []; // per env index

  constructor(root: HTMLElement) {
    this.root = root;
  }

  get current(): Show | null {
    return this.playing;
  }

  // The recordings shown, in order; the boxes are rebuilt only when their number changes.
  setSlots(slots: readonly number[]): void {
    if (slots.length !== this.tiles.length) {
      this.root.replaceChildren();
      this.tiles = slots.map(() => this.box());
    }
    this.tiles.forEach((t, i) => (t.k = slots[i]!));
    if (this.playing) this.label();
  }

  private box(): Tile {
    const box = document.createElement("figure");
    box.className = "tile-box";
    box.tabIndex = 0;
    box.setAttribute("role", "button");
    box.title = "Open large";
    const tile: Tile = { k: 0, box, canvas: document.createElement("canvas"), title: document.createElement("b"), sub: document.createElement("small"), stats: document.createElement("span"), badge: document.createElement("i") };
    box.addEventListener("click", () => this.onOpen(tile.k));
    box.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      this.onOpen(tile.k);
    });
    const frame = document.createElement("div");
    frame.className = "tile-frame";
    tile.badge.className = "tile-badge";
    frame.append(tile.canvas, tile.badge);
    const cap = document.createElement("figcaption");
    const head = document.createElement("div");
    head.className = "tile-head";
    tile.stats.className = "tile-result";
    head.append(tile.title, tile.stats);
    cap.append(head, tile.sub);
    box.append(frame, cap);
    this.root.append(box);
    return tile;
  }

  // Held-out change per env index, shown on the tiles of that env.
  setBadges(badges: readonly (Badge | null)[]): void {
    this.badges = badges;
    if (this.playing) this.label();
  }

  clear(): void {
    this.playing = this.queued = null;
    for (const t of this.tiles) {
      t.box.hidden = false;
      t.box.classList.remove("empty");
      for (const e of [t.title, t.sub, t.stats, t.badge]) e.textContent = "";
      t.badge.hidden = true;
    }
  }

  // Shows tile k's recording large in `target` (null closes it); it keeps following tile k when a new show arrives.
  setZoom(k: number | null, target?: ZoomTarget): void {
    this.zoom = k === null || !target ? null : { k, target };
    if (this.playing) this.label();
  }

  // Plays s at once, dropping a queued show (the gallery's clips, which no training show follows).
  replace(s: Show, now: number): void {
    this.queued = null;
    this.start(s, now);
  }

  show(s: Show, now: number): void {
    if (this.playing && this.speed > 0 && !this.playing.preview) this.queued = s;
    else {
      this.queued = null; // a show queued before Max would otherwise replay after this newer one
      this.start(s, now);
    }
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
    const total = s.recordings.length;
    for (const t of this.tiles) {
      const rec = s.recordings[t.k];
      t.box.classList.toggle("empty", !rec);
      t.title.textContent = s.names[t.k] ?? "";
      t.sub.textContent = rec ? tileSub(s, t.k, total) : "replay at the next show";
      t.stats.textContent = rec && !s.preview ? resultLine(rec.result) : ""; // a sample clip plays some other creature
      const badge = s.preview ? null : this.badges[t.k % Math.max(1, s.envCount)];
      t.badge.hidden = !badge;
      t.badge.textContent = badge?.text ?? "";
      t.badge.className = `tile-badge ${badge?.dir ?? ""}`;
    }
    const z = this.zoom && s.recordings[this.zoom.k];
    if (this.zoom && z) {
      this.zoom.target.title.textContent = s.preview ? `${s.names[this.zoom.k] ?? ""} · sample clip` : tileTitle(s.names[this.zoom.k] ?? "", s.iter, this.zoom.k, s.envCount, s.policy);
      this.zoom.target.stats.textContent = s.preview ? "A sample of this environment. Press Start to train your creature in it." : resultLine(z.result);
    }
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
    for (const tile of this.tiles) {
      const rec = s?.recordings[tile.k];
      if (!rec || tile.canvas.clientWidth <= 0) continue;
      const f = paint(rec, tile.canvas);
      if (tile.k === 0) first = { rec, frame: f };
    }
    const r0 = s && !s.preview ? s.recordings[0] : undefined;
    if (!first && r0) first = { rec: r0, frame: frameAt(r0, this.clock) }; // tile 0 on another page still drives the brain view
    const zoomRec = this.zoom && s?.recordings[this.zoom.k];
    if (this.zoom && zoomRec) paint(zoomRec, this.zoom.target.canvas);
    return first;
  }
}
