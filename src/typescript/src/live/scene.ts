import type { SnapshotViews } from "../worker/ecoProtocol.ts";
import type { CreatureFrame, ItemsFrame } from "./protocol.ts";

const MIN_SPAN_MS = 100;
const MAX_SPAN_MS = 1200; // frames can be up to 5 apart (1 s) when the server shares its upload

const TAU = 2 * Math.PI;
// Shortest signed turn from a to b.
const turn = (a: number, b: number): number => ((((b - a) % TAU) + 3 * Math.PI) % TAU) - Math.PI;

// Turns the server's frames (about 5 per second) into the views the Ecosystem renderer draws every animation frame,
// moving each creature from where it was drawn to where the new frame puts it. Creatures are matched by id.
export class LiveScene {
  private to: CreatureFrame | null = null;
  private fromX = new Float32Array(0);
  private fromY = new Float32Array(0);
  private fromH = new Float32Array(0);
  private t0 = 0;
  private span = 200;
  private cap = 0;
  private items: ItemsFrame | null = null;
  private readonly index = new Map<number, number>(); // id -> slot in views, as last sampled
  readonly views: SnapshotViews;
  fullEnergy = 1;

  constructor() {
    this.views = {
      count: 0, ids: new Int32Array(0), x: new Float32Array(0), y: new Float32Array(0), heading: new Float32Array(0),
      energy: new Float32Array(0), hue: new Float32Array(0), age: new Float32Array(0), founder: new Int32Array(0), species: new Int32Array(0),
      itemCount: 0, itemX: new Float32Array(0), itemY: new Float32Array(0), itemKind: new Uint8Array(0),
    };
  }

  get tick(): number {
    return this.to?.tick ?? 0;
  }

  setItems(f: ItemsFrame): void {
    this.items = f;
    const nf = f.foodX.length;
    const n = nf + f.poisonX.length;
    const v = this.views;
    if (v.itemX.length < n) {
      v.itemX = new Float32Array(n);
      v.itemY = new Float32Array(n);
      v.itemKind = new Uint8Array(n);
    }
    v.itemX.set(f.foodX, 0);
    v.itemX.set(f.poisonX, nf);
    v.itemY.set(f.foodY, 0);
    v.itemY.set(f.poisonY, nf);
    v.itemKind.fill(1, 0, nf);
    v.itemKind.fill(2, nf, n);
    v.itemCount = n;
  }

  // A new world: ids start over, so nothing carries across.
  reset(): void {
    this.to = null;
    this.index.clear();
    this.cap = 0;
    this.views.count = 0;
  }

  get hasItems(): boolean {
    return this.items !== null;
  }

  // A new frame arrived at nowMs. Creatures already on screen start moving from where they are drawn now.
  push(f: CreatureFrame, nowMs: number): void {
    this.sample(nowMs); // the views may be old (a hidden tab draws nothing), so bring them to now before they become the start
    const prev = this.to;
    this.span = prev ? Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, nowMs - this.t0)) : MIN_SPAN_MS;
    if (this.fromX.length < f.count) {
      const size = Math.max(f.count, 2 * this.fromX.length);
      this.fromX = new Float32Array(size);
      this.fromY = new Float32Array(size);
      this.fromH = new Float32Array(size);
    }
    const v = this.views;
    for (let i = 0; i < f.count; i++) {
      const slot = this.index.get(f.ids[i]!);
      const shown = slot !== undefined && slot < v.count;
      this.fromX[i] = shown ? v.x[slot]! : f.x[i]!;
      this.fromY[i] = shown ? v.y[slot]! : f.y[i]!;
      this.fromH[i] = shown ? v.heading[slot]! : f.heading[i]!;
    }
    this.to = f;
    this.t0 = nowMs;
    if (v.ids.length < f.count) {
      const size = Math.max(f.count, 2 * v.ids.length);
      v.ids = new Int32Array(size);
      v.x = new Float32Array(size);
      v.y = new Float32Array(size);
      v.heading = new Float32Array(size);
      v.energy = new Float32Array(size);
      v.hue = new Float32Array(size);
      v.age = new Float32Array(size);
      v.founder = new Int32Array(size);
      v.species = new Int32Array(size);
    }
    // Slot i of the new frame is slot i of the views from here on; the index must match before the next sample reads from the old one.
    v.count = f.count;
    v.ids.set(f.ids);
    v.energy.set(f.energyShare);
    v.hue.set(f.hue);
    v.age.set(f.age);
    v.founder.set(f.founder);
    for (let i = 0; i < f.count; i++) {
      v.energy[i] = f.energyShare[i]! * this.fullEnergy;
      v.x[i] = this.fromX[i]!;
      v.y[i] = this.fromY[i]!;
      v.heading[i] = this.fromH[i]!;
    }
    this.index.clear();
    for (let i = 0; i < f.count; i++) this.index.set(f.ids[i]!, i);
    this.cap = f.count;
  }

  // Positions at nowMs, between the frame before and the latest. Returns the views, valid until the next call.
  sample(nowMs: number): SnapshotViews {
    const f = this.to;
    if (!f) return this.views;
    const a = Math.min(1, Math.max(0, (nowMs - this.t0) / this.span));
    const v = this.views;
    for (let i = 0; i < this.cap; i++) {
      v.x[i] = this.fromX[i]! + (f.x[i]! - this.fromX[i]!) * a;
      v.y[i] = this.fromY[i]! + (f.y[i]! - this.fromY[i]!) * a;
      v.heading[i] = this.fromH[i]! + turn(this.fromH[i]!, f.heading[i]!) * a;
    }
    return v;
  }

  // Slot of a creature in the current views, or -1.
  slotOf(id: number): number {
    return this.index.get(id) ?? -1;
  }
}
