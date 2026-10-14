import { HISTORY_FIELDS, LINEAGE_FIELDS, LINEAGE_TOP, MAX_HISTORY, MAX_ITEM_SLOTS, MAX_LINEAGE_HISTORY, MAX_RECORDS, PING, PROTOCOL_VERSION, RECORD_BOARDS, decodeCreatures, decodeDelta, decodeItems, frameType, MSG_CREATURES, MSG_DELTA, MSG_DETAIL, MSG_GENOME, MSG_ITEMS } from "./protocol.ts";
import type { CreatureFrame, Delta, Hello, History, ItemsSnapshot, ServerText, Stats, WireRecord } from "./protocol.ts";
import { decodeDetail, decodeGenome } from "./detail.ts";
import type { Detail } from "./detail.ts";
import { retryDelayS } from "./serverUrl.ts";
import { cleanAddReply, cleanAddRules, encodeAdd, validName } from "./add.ts";
import type { AddRequest, AddRules, Added, Refused } from "./add.ts";
import { cleanMap } from "./mapInfo.ts";

export type LinkState = "connecting" | "live" | "offline" | "full" | "updating" | "outdated";

export interface LinkHandlers {
  onState(state: LinkState, retryInS: number): void;
  onHello(hello: Hello): void;
  onCreatures(frame: CreatureFrame): void;
  onItems(frame: ItemsSnapshot): void;
  onDelta(deltas: Delta[]): void;
  onDetail(detail: Detail): void;
  onGenome(id: number, genome: Float32Array): void;
  onStats(stats: Stats): void;
  onHistory(history: History): void;
  onAdd?(reply: Added | Refused): void;
  onRules?(rules: AddRules | null): void;
}

const PING_EVERY_MS = 20_000;
export const HIDDEN_CLOSE_MS = 3 * 60_000; // a tab hidden this long lets go of its viewer slot, and connects again when shown
const STALE_MS = 15_000; // no message for this long counts as a dead link
const OFFLINE_AFTER_FAILURES = 2; // the first try is "connecting", later failed ones "offline"

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const MAX_COUNT = 1e9; // creatures, births, items: far past any real world, short enough for a tile
const MAX_SECONDS = 1e10; // simulated or server time, about 300 years
const within = (v: unknown, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n(v)));
const count = (v: unknown): number => Math.round(within(v, 0, MAX_COUNT));
const seconds = (v: unknown): number => within(v, 0, MAX_SECONDS);
const id = (v: unknown): number => Math.round(within(v, 0, 0xffffffff));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A flat array of exactly `size` finite numbers per record and at most `max` records, else empty.
function numbers(v: unknown, size: number, max: number): number[] {
  if (!Array.isArray(v) || v.length % size !== 0 || v.length > size * max) return [];
  return v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : [];
}
const int = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function cleanRecord(e: unknown): WireRecord | null {
  if (!isObj(e) || !isObj(e.plan)) return null;
  const p = e.plan;
  if (!int(p.rayCount, 1, 16) || !Array.isArray(p.hiddenLayers) || p.hiddenLayers.length > 4 || !p.hiddenLayers.every((x) => int(x, 1, 32))) return null;
  const plan = { rayCount: p.rayCount as number, raySpread: Math.min(2 * Math.PI, Math.max(0, n(p.raySpread))), rayLength: Math.min(400, Math.max(0, n(p.rayLength))), hiddenLayers: (p.hiddenLayers as number[]).slice(), memoryShort: Math.min(8, Math.max(0, Math.round(n(p.memoryShort)))), memoryLong: Math.min(8, Math.max(0, Math.round(n(p.memoryLong)))) };
  return { id: id(e.id), hue: n(e.hue), value: within(e.value, 0, MAX_SECONDS), from: seconds(e.from), to: seconds(e.to), alive: e.alive === true, plan };
}

// Stats from the wire with every field a finite number in a sane range and every list bounded, so one bad value cannot put NaN, text,
// a negative count or a share past 100% on the page.
export function cleanStats(s: Stats): Stats {
  const out: Stats = {
    t: "stats", tick: within(s.tick, 0, 0xffffffff), simSeconds: seconds(s.simSeconds), speed: within(s.speed, 0, 1000), population: count(s.population), births: count(s.births), deaths: count(s.deaths), food: count(s.food), poison: count(s.poison), viewers: count(s.viewers), uptimeS: seconds(s.uptimeS),
    depth: count(s.depth),
    season: isObj(s.season) && n(s.season.yearMinutes) > 0 ? { yearMinutes: within(s.season.yearMinutes, 1, 1e6), winterFood: within(s.season.winterFood, 0, 1) } : null,
    best: isObj(s.best) ? { age: id(s.best.age), children: id(s.best.children) } : null,
  };
  const sample = numbers(s.sample, HISTORY_FIELDS, 1);
  if (sample.length) out.sample = sample;
  const lineageSample = numbers(s.lineageSample, LINEAGE_FIELDS, 1);
  if (lineageSample.length) out.lineageSample = lineageSample;
  if (Array.isArray(s.lineages)) {
    let left = out.population; // the lineages together hold at most the population, so every share is 0 to 100%
    out.lineages = s.lineages.slice(0, LINEAGE_TOP).filter(isObj).map((l) => {
      const c = Math.min(left, count(l.count));
      left -= c;
      return { founder: id(l.founder), hue: n(l.hue), pool: l.pool === true, count: c, ...(validName(l.name) ? { name: l.name, ...(l.starter === true ? { starter: true } : {}) } : {}) };
    });
  }
  if (Array.isArray(s.records)) {
    out.records = s.records
      .slice(0, RECORD_BOARDS.length)
      .filter((r) => isObj(r) && RECORD_BOARDS.includes(r.board as never) && Array.isArray(r.entries))
      .map((r) => ({ board: r.board, entries: r.entries.slice(0, MAX_RECORDS).map(cleanRecord).filter((e): e is WireRecord => e !== null) }));
  }
  return out;
}

export function cleanHistory(h: History): History {
  return { t: "history", samples: numbers(h.samples, HISTORY_FIELDS, MAX_HISTORY), lineage: numbers(h.lineage, LINEAGE_FIELDS, MAX_LINEAGE_HISTORY) };
}

const EMPTY_AXIS = 0.2;
// The population graph starts at time 0 and draws the seasons from there, so a history window from `first` to `last` (simulated s)
// is shifted back by whole years: the seasons stay in place (aligned). When that would leave more than EMPTY_AXIS of the axis empty
// (history since a restart in mid-year), the axis starts at the first sample instead, and the seasons are not drawn.
export function historyAxis(first: number, last: number, yearS: number): { shift: number; aligned: boolean } {
  const yearStart = yearS > 0 ? Math.floor(first / yearS) * yearS : first;
  const aligned = first - yearStart <= EMPTY_AXIS * Math.max(1, last - yearStart);
  return { shift: aligned ? yearStart : first, aligned };
}

// A hello with sane numbers, or null.
export function cleanHello(h: Hello): Hello | null {
  const ok = isObj(h.world) && n(h.world.width) > 0 && n(h.world.height) > 0 && n(h.radius) > 0 && n(h.dt) > 0 && n(h.fullEnergy) > 0 && int(h.itemSlots, 0, MAX_ITEM_SLOTS);
  const s: Record<string, unknown> = isObj(h.summary) ? h.summary : {};
  const seedCopies = int(s.seedCopies, 1, 100) ? (s.seedCopies as number) : undefined;
  const summary = { initialPopulation: count(s.initialPopulation), maxPopulation: count(s.maxPopulation), collisionDamage: s.collisionDamage === true, seasons: s.seasons === true, ...(seedCopies ? { seedCopies } : {}) };
  return ok ? { ...h, summary, add: cleanAddRules(h.add), map: cleanMap(h.map) } : null;
}

// One WebSocket to the world server that reconnects with backoff.
// What LiveLink needs of the document: whether the tab is hidden, and word when that changes.
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
}

export class LiveLink {
  private ws: WebSocket | null = null;
  private asleep = false; // closed because the tab stayed hidden
  private outdated = false; // the page needs a reload: no more connects
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private world: Hello["world"] | null = null;
  private slots = 0;
  private selected: number | null = null;
  private failures = 0;
  private full = false; // the server said it has no room, until the next hello
  private updating = false; // the server runs an older protocol than this page: it is being updated, keep retrying
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastMessage = 0;
  private readonly url: string;
  private readonly h: LinkHandlers;

  private readonly visibility: Visibility | null;

  constructor(url: string, handlers: LinkHandlers, visibility: Visibility | null = typeof document === "undefined" ? null : document) {
    this.url = url;
    this.h = handlers;
    this.visibility = visibility;
  }

  start(): void {
    this.h.onState("connecting", 0);
    this.open();
    const vis = this.visibility;
    vis?.addEventListener("visibilitychange", () => {
      clearTimeout(this.hiddenTimer);
      if (this.outdated) return;
      if (vis.hidden) this.hiddenTimer = setTimeout(() => this.sleep(), HIDDEN_CLOSE_MS);
      else if (this.asleep) {
        this.asleep = false;
        this.failures = 0;
        this.h.onState("connecting", 0);
        this.open(); // the hello rebuilds the page's state
      }
    });
    setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessage > STALE_MS) {
        // Detached first, so its late close event cannot start a second reconnect.
        const ws = this.ws;
        this.ws = null;
        ws.close();
        this.lost();
      } else this.ws.send(PING);
    }, PING_EVERY_MS);
  }

  // Follow a creature (its details then come about 5 times a second), or none. The server forgets it on reconnect, and the page
  // clears its selection with the new hello.
  select(id: number | null): void {
    this.selected = id;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "select", id }));
  }

  // Sends an add (live/add.ts); the reply comes to onAdd. False when not connected.
  add(req: AddRequest): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.world) return false;
    this.ws.send(encodeAdd(req));
    return true;
  }

  // Hidden for long: close without a reconnect, so the server's viewer slot is free for someone watching.
  private sleep(): void {
    this.asleep = true;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null; // detached first, so its close event does not reconnect
    ws?.close();
  }

  private open(): void {
    this.full = false; // a busy reply on this try sets it again
    this.updating = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.lost();
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastMessage = Date.now();
    ws.onmessage = (e) => this.message(e.data);
    ws.onclose = () => {
      if (this.ws === ws) this.lost();
    };
    ws.onerror = () => ws.close();
  }

  private lost(): void {
    this.ws = null;
    const wait = retryDelayS(this.failures++);
    this.h.onState(this.full ? "full" : this.updating ? "updating" : this.failures >= OFFLINE_AFTER_FAILURES ? "offline" : "connecting", Math.ceil(wait));
    this.timer = setTimeout(() => this.open(), wait * 1000);
  }

  private message(data: unknown): void {
    this.lastMessage = Date.now();
    try {
      if (typeof data === "string") return this.text(JSON.parse(data) as ServerText);
      if (!(data instanceof ArrayBuffer) || !this.world) return;
      const type = frameType(data);
      if (type === MSG_CREATURES) this.h.onCreatures(decodeCreatures(data, this.world));
      else if (type === MSG_ITEMS) this.h.onItems(decodeItems(data, this.world, this.slots));
      else if (type === MSG_DELTA) this.h.onDelta(decodeDelta(data, this.world, this.slots));
      else if (type === MSG_DETAIL) {
        const d = decodeDetail(data);
        if (d.id === this.selected) this.h.onDetail(d);
      } else if (type === MSG_GENOME) {
        const g = decodeGenome(data);
        if (g.id === this.selected) this.h.onGenome(g.id, g.genome);
      }
    } catch (err) {
      console.warn("bad message from the server", err); // a malformed frame is dropped, the link stays
    }
  }

  private text(msg: ServerText): void {
    if (msg.t === "hello") {
      if (typeof msg.version === "number" && msg.version < PROTOCOL_VERSION) {
        // The page was released before the server was: retry with backoff until it runs the new version.
        this.updating = true;
        this.ws?.close();
        return;
      }
      if (msg.version !== PROTOCOL_VERSION) {
        clearTimeout(this.timer);
        this.outdated = true;
        const ws = this.ws;
        this.ws = null; // no reconnect: a reload is needed
        ws?.close();
        return this.h.onState("outdated", 0);
      }
      const hello = cleanHello(msg);
      if (!hello) throw new Error("bad hello");
      this.full = false;
      this.world = msg.world;
      this.slots = msg.itemSlots;
      this.selected = null; // a new world: the server forgot the selection
      this.failures = 0;
      this.h.onHello(hello);
      this.h.onState("live", 0);
    } else if (msg.t === "stats") this.h.onStats(cleanStats(msg));
    else if (msg.t === "history") this.h.onHistory(cleanHistory(msg));
    else if (msg.t === "added" || msg.t === "refused") {
      const r = cleanAddReply(msg);
      if (r) this.h.onAdd?.(r);
    } else if (msg.t === "rules") this.h.onRules?.(cleanAddRules(msg.add));
    else if (msg.t === "busy") this.full = true; // the server closes next, lost() reports it with the retry time
  }
}
