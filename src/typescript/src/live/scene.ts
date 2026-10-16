import type { SnapshotViews } from "../worker/ecoProtocol.ts";
import type { Detail } from "./detail.ts";
import { ItemMirror } from "./items.ts";
import type { CreatureFrame, Delta, ItemsSnapshot, WireEvent } from "./protocol.ts";

const MIN_SPAN_MS = 100;
const MAX_SPAN_MS = 1200; // frames can be up to 5 apart (1 s) when the server shares its upload
const SPAN_SLACK = 1.3; // a frame's motion is spread over this much of the usual gap, so one arriving a little late finds the creatures still moving
const SPAN_EASE = 0.3; // weight of the newest gap in the usual one, both ways: a single late frame or a burst after a stall moves it a little, and after a stretch of slow frames the lag shrinks back within a few frames
const MAX_QUEUE = 4096; // timeline entries waiting for their tick; past this the oldest apply at once
const MAX_AHEAD_S = 60; // an entry this many simulated seconds past the latest frame applies at once (frames are at most 5 s apart, 20 s at 4x)
const U32 = 2 ** 32;

const TAU = 2 * Math.PI;
// Shortest signed turn from a to b.
const turn = (a: number, b: number): number => ((((b - a) % TAU) + 3 * Math.PI) % TAU) - Math.PI;

type Entry =
  | { tick: number; kind: "items"; snap: ItemsSnapshot }
  | { tick: number; kind: "ops"; ops: Delta["ops"] }
  | { tick: number; kind: "events"; events: WireEvent[] }
  | { tick: number; kind: "detail"; detail: Detail };

export interface SceneHandlers {
  onEvents(events: Float32Array, kinds: WireEvent[]): void; // collision events, as the engine's (kind, x, y, value) quads
  onDetail(detail: Detail): void;
}

// Turns the server's frames (about 5 per second) into the views the Ecosystem renderer draws every animation frame.
// Everything runs on one timeline, the simulation tick at the interpolated moment: creatures move from where they were drawn
// to the latest frame, and item changes, collision events, details, births and deaths take effect when that tick passes theirs.
export class LiveScene {
  private to: CreatureFrame | null = null;
  private fromTick = 0;
  private fromX = new Float32Array(0);
  private fromY = new Float32Array(0);
  private fromH = new Float32Array(0);
  private appear = new Float64Array(0); // tick at which a creature new in `to` shows, -Infinity for ones already shown
  private ghosts: { id: number; x: number; y: number; heading: number; energy: number; hue: number; age: number; founder: number; until: number }[] = [];
  private t0 = 0;
  private span = 200;
  private gap = 0; // ms between frames as they usually arrive (an average weighted to the recent ones), 0 before the second frame
  private queue: Entry[] = [];
  private itemsTick = -Infinity; // tick of the last full item set applied: older item changes are already in it
  private shownKey = -1; // membership signature of the last sample, to tell callers when creatures appeared
  readonly items = new ItemMirror();
  readonly views: SnapshotViews;
  fullEnergy = 1;
  dt = 1 / 30;
  displayTick = 0; // the simulation tick shown now
  handlers: SceneHandlers | null = null;

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

  // Ticks are u32 on the wire: the one nearest the timeline, so a world running past 2^32 ticks keeps its order.
  private unwrap(tick: number): number {
    const ref = this.to?.tick ?? this.queue.at(-1)?.tick ?? tick;
    return ref + ((((tick - ref + U32 / 2) % U32) + U32) % U32) - U32 / 2;
  }

  get hasItems(): boolean {
    return this.items.capacity > 0;
  }

  get queued(): number {
    return this.queue.length;
  }

  // A new world: ids start over, so nothing carries across.
  reset(): void {
    this.to = null;
    this.gap = 0;
    this.ghosts = [];
    this.queue = [];
    this.itemsTick = -Infinity;
    this.items.clear();
    this.syncItems();
    this.views.count = 0;
    this.displayTick = 0;
    this.shownKey = -1;
  }

  // Entries wait in tick order (in arrival order for equal ticks): item changes of a frame can arrive after details of later ticks.
  private enqueue(e: Entry): void {
    if (this.to && e.tick > this.to.tick + MAX_AHEAD_S / this.dt) return this.run(e); // far ahead: never let it hold others back
    const q = this.queue;
    let lo = q.length;
    if (lo && q[lo - 1]!.tick > e.tick) {
      lo = 0;
      let hi = q.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (q[mid]!.tick <= e.tick) lo = mid + 1;
        else hi = mid;
      }
    }
    q.splice(lo, 0, e);
    if (q.length > MAX_QUEUE) this.run(q.shift()!);
  }

  setItems(s: ItemsSnapshot): void {
    this.enqueue({ tick: this.unwrap(s.tick), kind: "items", snap: s });
  }

  addDeltas(deltas: readonly Delta[]): void {
    for (const d of deltas) {
      let start = 0;
      // Ops sorted by tick within a delta; each run of one tick becomes one entry.
      while (start < d.ops.length) {
        const t = d.ops[start]!.tick;
        let end = start + 1;
        while (end < d.ops.length && d.ops[end]!.tick === t) end++;
        this.enqueue({ tick: this.unwrap(t), kind: "ops", ops: d.ops.slice(start, end) });
        start = end;
      }
      if (d.events.length) this.enqueue({ tick: this.unwrap(d.tick), kind: "events", events: d.events });
    }
  }

  addDetail(d: Detail): void {
    this.enqueue({ tick: this.unwrap(d.tick), kind: "detail", detail: d });
  }

  private run(e: Entry): void {
    if (e.kind === "items") {
      this.items.reset(e.snap);
      this.itemsTick = e.tick;
    } else if (e.kind === "ops") {
      if (e.tick <= this.itemsTick) return; // a connect catch-up set can be newer than the frames that follow it
      for (const op of e.ops) this.items.apply(op.slot, op.kind, op.x, op.y);
    }
    else if (e.kind === "events") {
      const out = new Float32Array(4 * e.events.length);
      e.events.forEach((ev, i) => out.set([ev.kind, ev.x, ev.y, ev.value], 4 * i));
      this.handlers?.onEvents(out, e.events);
    } else this.handlers?.onDetail(e.detail);
  }

  private syncItems(): void {
    const v = this.views;
    v.itemX = this.items.x;
    v.itemY = this.items.y;
    v.itemKind = this.items.kind;
    v.itemCount = this.items.count;
  }

  // A new frame arrived at nowMs. Creatures already on screen start moving from where they are drawn now.
  push(f: CreatureFrame, nowMs: number): void {
    f = { ...f, tick: this.unwrap(f.tick) };
    this.sample(nowMs); // the views may be old (a hidden tab draws nothing), so bring them to now before they become the start
    const prev = this.to;
    const v = this.views;
    if (prev) {
      const gap = Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, nowMs - this.t0));
      this.gap = this.gap ? this.gap + SPAN_EASE * (gap - this.gap) : gap;
    }
    this.span = prev ? Math.min(MAX_SPAN_MS, SPAN_SLACK * this.gap) : MIN_SPAN_MS;
    this.fromTick = prev ? Math.min(this.displayTick, f.tick) : f.tick;
    if (this.fromX.length < f.count) {
      const size = Math.max(f.count, 2 * this.fromX.length);
      this.fromX = new Float32Array(size);
      this.fromY = new Float32Array(size);
      this.fromH = new Float32Array(size);
      this.appear = new Float64Array(size);
    }
    const shown = new Map<number, number>();
    for (let i = 0; i < v.count; i++) shown.set(v.ids[i]! >>> 0, i); // the views hold ids as i32, the frame as u32
    const ghostUntil = new Map(this.ghosts.map((g) => [g.id, g.until]));
    for (let i = 0; i < f.count; i++) {
      const slot = shown.get(f.ids[i]!);
      if (slot !== undefined) {
        shown.delete(f.ids[i]!);
        this.fromX[i] = v.x[slot]!;
        this.fromY[i] = v.y[slot]!;
        this.fromH[i] = v.heading[slot]!;
        this.appear[i] = -Infinity;
      } else {
        this.fromX[i] = f.x[i]!;
        this.fromY[i] = f.y[i]!;
        this.fromH[i] = f.heading[i]!;
        // Born since the last frame: shows at its birth tick, from its age in whole seconds (so never early). Everyone in a first frame shows at once.
        this.appear[i] = prev ? Math.max(this.fromTick, f.tick - f.age[i]! / this.dt) : -Infinity;
      }
    }
    // On screen but not in the frame: died before f.tick. Drawn where they are until the timeline reaches it, so they leave as the frame says.
    const ghosts: LiveScene["ghosts"] = [];
    for (const [id, i] of shown) ghosts.push({ id, x: v.x[i]!, y: v.y[i]!, heading: v.heading[i]!, energy: v.energy[i]!, hue: v.hue[i]!, age: v.age[i]!, founder: v.founder[i]!, until: ghostUntil.get(id) ?? f.tick });
    this.ghosts = ghosts;
    this.to = f;
    this.t0 = nowMs;
    const need = f.count + ghosts.length;
    if (v.ids.length < need) {
      const size = Math.max(need, 2 * v.ids.length);
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
    this.shownKey = -1;
    this.sample(nowMs);
  }

  // The world at nowMs, between the frame before and the latest. Returns true when creatures appeared or left since the last call.
  sample(nowMs: number): boolean {
    const f = this.to;
    if (!f) {
      this.drain(Infinity);
      return false;
    }
    const a = Math.min(1, Math.max(0, (nowMs - this.t0) / this.span));
    this.displayTick = this.fromTick + (f.tick - this.fromTick) * a;
    this.drain(this.displayTick);
    const v = this.views;
    let k = 0;
    let key = 0;
    for (let i = 0; i < f.count; i++) {
      if (this.displayTick < this.appear[i]!) continue;
      v.ids[k] = f.ids[i]!;
      v.x[k] = this.fromX[i]! + (f.x[i]! - this.fromX[i]!) * a;
      v.y[k] = this.fromY[i]! + (f.y[i]! - this.fromY[i]!) * a;
      v.heading[k] = this.fromH[i]! + turn(this.fromH[i]!, f.heading[i]!) * a;
      v.energy[k] = f.energyShare[i]! * this.fullEnergy;
      v.hue[k] = f.hue[i]!;
      v.age[k] = f.age[i]!;
      v.founder[k] = f.founder[i]!;
      v.species[k++] = 0;
    }
    key = k;
    for (const g of this.ghosts) {
      if (this.displayTick >= g.until) continue;
      v.ids[k] = g.id;
      v.x[k] = g.x;
      v.y[k] = g.y;
      v.heading[k] = g.heading;
      v.energy[k] = g.energy;
      v.hue[k] = g.hue;
      v.age[k] = g.age;
      v.founder[k] = g.founder;
      v.species[k++] = 0;
    }
    key = key * 4099 + k;
    v.count = k;
    const changed = key !== this.shownKey;
    this.shownKey = key;
    return changed;
  }

  private drain(tick: number): void {
    let n = 0;
    while (n < this.queue.length && this.queue[n]!.tick <= tick) this.run(this.queue[n++]!);
    if (n) this.queue.splice(0, n);
    this.syncItems();
  }

  // Slot of a creature in the current views, or -1.
  slotOf(id: number): number {
    const v = this.views;
    for (let i = 0; i < v.count; i++) if (v.ids[i]! >>> 0 === id) return i;
    return -1;
  }
}
