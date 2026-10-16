import { isIP } from "node:net";
import type { Refused } from "../../src/typescript/src/live/add.ts";
import { TokenBucket } from "./budget.ts";
import { LIVE } from "./config.ts";

const ADD_STRIKES = 3; // adds past the rate a connection may send (one more each minute) before it counts as a flood: a page with stale rules stays

// "per 5 minutes", "per 90 s": the window as a visitor reads it.
const per = (windowS: number): string => (windowS % 60 === 0 ? `per ${windowS / 60 === 1 ? "minute" : `${windowS / 60} minutes`}` : `per ${Math.round(windowS)} s`);

// Adding is off while the admin set no room for it: no creatures per window, or no visitor creatures alive (aliveMax 0).
// The hello and rules then carry no rules.
export const addingOn = (): boolean => LIVE.add.perWindow > 0 && LIVE.add.aliveMax > 0;

// A connection's add rate: a burst, refilled at the admin's socket rate (read live), and the strikes past it.
export interface AddPace {
  tokens: TokenBucket;
  strikes: TokenBucket;
  notBefore: number; // ms (monotonic): the retryS this connection was last told ends here; an add before it is a strike
}

// The add policy in one place: per connection the pace, for everyone the rate of add messages read, and the caps (AddGate) on what
// goes in. public.ts keeps the transport, LiveWorld the insertion.
export class AddPolicy {
  readonly gate: AddGate;
  private readonly attempts: TokenBucket;

  constructor(limits: { addAttemptsPerSecond: number; addAttemptBurst: number }, gate = new AddGate()) {
    this.gate = gate;
    this.attempts = new TokenBucket(limits.addAttemptsPerSecond, limits.addAttemptBurst);
  }

  connection(): AddPace {
    return { tokens: new TokenBucket(() => 1 / LIVE.add.socketEveryS, LIVE.add.burst), strikes: new TokenBucket(1 / 60, ADD_STRIKES), notBefore: 0 }; // add.burst as the connection opens
  }

  // An add message on a connection, before it is read: null to read it; past the rate a refusal with the wait, or "cut" once the strikes
  // are used up (a flood). Only an add sent before the wait it was told counts as a strike, so a page that keeps to retryS is never cut,
  // however often its visitor clicks.
  pace(p: AddPace, now = performance.now()): Refused | "cut" | null {
    if (p.tokens.take(1)) return null;
    if (now < p.notBefore && !p.strikes.take(1)) return "cut";
    const retryS = Math.ceil(p.tokens.waitS(1));
    p.notBefore = now + retryS * 1000;
    return { t: "refused", reason: "adding too fast on this connection", retryS };
  }

  // Before parsing: the rate of add messages read for all viewers together, and whether adding is on.
  admit(): Refused | null {
    if (!this.attempts.take(1)) return { t: "refused", reason: "the world is busy, try again in 5 s", retryS: 5 };
    if (!addingOn()) return { t: "refused", reason: "adding is off right now" };
    return null;
  }
}

// The caps on visitor adds (LIVE.add, admin-tunable): creatures per window for everyone together and per visitor, the visitor-added
// creatures alive at once, and a world that cannot keep up. Only adds that went in count. The clock is monotonic (a wall clock step back
// would stretch the window) and injectable for tests.
export class AddGate {
  private global: { at: number; n: number }[] = []; // successful adds in the window, oldest first
  private visitors = new Map<string, { at: number; n: number }[]>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  private prune(list: { at: number; n: number }[], since: number): void {
    let k = 0;
    while (k < list.length && list[k]!.at <= since) k++;
    if (k) list.splice(0, k);
  }

  // Seconds until `extra` more creatures fit under `cap` in this window, or 0 when they fit now.
  private wait(list: { at: number; n: number }[], cap: number, extra: number, windowMs: number): number {
    let used = list.reduce((s, e) => s + e.n, 0);
    if (used + extra <= cap) return 0;
    if (extra > cap) return Infinity;
    for (const e of list) {
      used -= e.n;
      if (used + extra <= cap) return Math.max(1, Math.ceil((e.at + windowMs - this.now()) / 1000));
    }
    return Infinity;
  }

  // null when an add of `copies` may go in now, else why not. visitor: the address key, or null when unknown.
  check(visitor: string | null, copies: number, world: { aliveAdded: number; population: number; speed: number; paused: boolean }): Refused | null {
    const a = LIVE.add;
    const windowMs = a.windowS * 1000;
    const t = this.now();
    this.prune(this.global, t - windowMs);
    if (copies > a.maxCopies) return { t: "refused", reason: `at most ${a.maxCopies} copies` };
    if (world.paused) return { t: "refused", reason: "the world is paused, try again later", retryS: 60 };
    if (world.speed < a.minSpeed) return { t: "refused", reason: "the world is busy, try again in 30 s", retryS: 30 };
    if (world.aliveAdded + copies > a.aliveMax) {
      const room = a.aliveMax - world.aliveAdded;
      return room > 0 ? { t: "refused", reason: `only ${room} more visitor ${room === 1 ? "creature fits" : "creatures fit"} right now, ask for ${room === 1 ? "1 copy" : `${room} copies or fewer`}` } : { t: "refused", reason: `${a.aliveMax} visitor creatures are alive already; try again when some have died`, retryS: 120 };
    }
    const g = this.wait(this.global, a.perWindow, copies, windowMs);
    if (g) return Number.isFinite(g) ? { t: "refused", reason: `the world is busy with new creatures, try again in ${g} s`, retryS: g } : { t: "refused", reason: a.perWindow > 0 ? `at most ${a.perWindow} creatures go in ${per(a.windowS)}, ask for fewer copies` : "adding is off right now" };
    if (visitor !== null) {
      const list = this.visitors.get(visitor);
      if (list) {
        this.prune(list, t - windowMs);
        if (!list.length) this.visitors.delete(visitor);
      }
      const v = this.wait(list ?? [], a.perVisitor, copies, windowMs);
      if (v) return Number.isFinite(v) ? { t: "refused", reason: `you added creatures a moment ago, try again in ${v} s`, retryS: v } : { t: "refused", reason: a.perVisitor > 0 ? `at most ${a.perVisitor} creatures per visitor ${per(a.windowS)}, ask for fewer copies` : "adding is off right now" };
    }
    return null;
  }

  // An add went in. The visitor map holds only visitors with adds in the window, so at most perWindow of them.
  record(visitor: string | null, copies: number): void {
    const e = { at: this.now(), n: copies };
    this.global.push(e);
    if (visitor === null) return;
    const list = this.visitors.get(visitor) ?? [];
    list.push(e);
    this.visitors.set(visitor, list);
    if (this.visitors.size > 4 * Math.max(1, LIVE.add.perWindow)) {
      const since = this.now() - LIVE.add.windowS * 1000;
      for (const [k, l] of this.visitors) {
        this.prune(l, since);
        if (!l.length) this.visitors.delete(k);
      }
    }
  }
}

// The visitor's address key from the tunnel's X-Forwarded-For (one address, as Tailscale sets it), or null when the header is not
// trusted (then only the global caps apply). A trusted but missing or malformed header counts under one shared key, so it cannot
// skip the per-visitor cap. IPv6 addresses key on their /64, which one visitor usually holds whole.
export const UNKNOWN_VISITOR = "unknown";
export function visitorKey(header: string | string[] | undefined, trust: boolean): string | null {
  if (!trust) return null;
  if (typeof header !== "string" || header.length > 64) return UNKNOWN_VISITOR;
  const ip = header.trim();
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return UNKNOWN_VISITOR;
  if (ip.includes(".")) return ip; // IPv4-mapped
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}
