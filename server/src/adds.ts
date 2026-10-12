import { isIP } from "node:net";
import type { Refused } from "../../src/typescript/src/live/add.ts";
import { LIVE } from "./config.ts";

// The caps on visitor adds (LIVE.add, admin-tunable): creatures per window for everyone together and per visitor address, the share of
// added creatures alive, and a world that cannot keep up. Only adds that went in count. The clock is injectable for tests.
export class AddGate {
  private global: { at: number; n: number }[] = []; // successful adds in the window, oldest first
  private visitors = new Map<string, { at: number; n: number }[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
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
    if (world.aliveAdded + copies > Math.floor(a.aliveShare * world.population)) return { t: "refused", reason: "enough added creatures are alive right now, try again in a few minutes", retryS: 120 };
    const g = this.wait(this.global, a.perWindow, copies, windowMs);
    if (g) return { t: "refused", reason: Number.isFinite(g) ? `the world is busy with new creatures, try again in ${g} s` : "adding is off right now", ...(Number.isFinite(g) ? { retryS: g } : {}) };
    if (visitor !== null) {
      const list = this.visitors.get(visitor);
      if (list) {
        this.prune(list, t - windowMs);
        if (!list.length) this.visitors.delete(visitor);
      }
      const v = this.wait(list ?? [], a.perVisitor, copies, windowMs);
      if (v) return { t: "refused", reason: Number.isFinite(v) ? `you added creatures a moment ago, try again in ${v} s` : "adding is off right now", ...(Number.isFinite(v) ? { retryS: v } : {}) };
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
