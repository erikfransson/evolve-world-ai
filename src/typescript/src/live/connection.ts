import { PING, PROTOCOL_VERSION, decodeCreatures, decodeItems, frameType, MSG_CREATURES, MSG_ITEMS } from "./protocol.ts";
import type { CreatureFrame, Hello, ItemsFrame, ServerText, Stats } from "./protocol.ts";
import { retryDelayS } from "./serverUrl.ts";

export type LinkState = "connecting" | "live" | "offline" | "full" | "outdated";

export interface LinkHandlers {
  onState(state: LinkState, retryInS: number): void;
  onHello(hello: Hello): void;
  onCreatures(frame: CreatureFrame): void;
  onItems(frame: ItemsFrame): void;
  onStats(stats: Stats): void;
}

const PING_EVERY_MS = 20_000;
const STALE_MS = 15_000; // no message for this long counts as a dead link
const OFFLINE_AFTER_FAILURES = 2; // the first try is "connecting", later failed ones "offline"

// Stats from the wire with every field a finite number, so one bad value cannot put NaN or text on the page.
export function cleanStats(s: Stats): Stats {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { t: "stats", tick: n(s.tick), simSeconds: n(s.simSeconds), speed: n(s.speed), population: n(s.population), births: n(s.births), deaths: n(s.deaths), food: n(s.food), poison: n(s.poison), viewers: n(s.viewers), uptimeS: n(s.uptimeS) };
}

// One WebSocket to the world server that reconnects with backoff.
export class LiveLink {
  private ws: WebSocket | null = null;
  private world: Hello["world"] | null = null;
  private failures = 0;
  private full = false; // the server said it has no room, until the next hello
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastMessage = 0;
  private readonly url: string;
  private readonly h: LinkHandlers;

  constructor(url: string, handlers: LinkHandlers) {
    this.url = url;
    this.h = handlers;
  }

  start(): void {
    this.h.onState("connecting", 0);
    this.open();
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

  private open(): void {
    this.full = false; // a busy reply on this try sets it again
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
    this.h.onState(this.full ? "full" : this.failures >= OFFLINE_AFTER_FAILURES ? "offline" : "connecting", Math.ceil(wait));
    this.timer = setTimeout(() => this.open(), wait * 1000);
  }

  private message(data: unknown): void {
    this.lastMessage = Date.now();
    try {
      if (typeof data === "string") return this.text(JSON.parse(data) as ServerText);
      if (!(data instanceof ArrayBuffer) || !this.world) return;
      const type = frameType(data);
      if (type === MSG_CREATURES) this.h.onCreatures(decodeCreatures(data, this.world));
      else if (type === MSG_ITEMS) this.h.onItems(decodeItems(data, this.world));
    } catch (err) {
      console.warn("bad message from the server", err); // a malformed frame is dropped, the link stays
    }
  }

  private text(msg: ServerText): void {
    if (msg.t === "hello") {
      if (msg.version !== PROTOCOL_VERSION) {
        clearTimeout(this.timer);
        const ws = this.ws;
        this.ws = null; // no reconnect: a reload is needed
        ws?.close();
        return this.h.onState("outdated", 0);
      }
      this.full = false;
      this.world = msg.world;
      this.failures = 0;
      this.h.onHello(msg);
      this.h.onState("live", 0);
    } else if (msg.t === "stats") this.h.onStats(cleanStats(msg));
    else if (msg.t === "busy") this.full = true; // the server closes next, lost() reports it with the retry time
  }
}
