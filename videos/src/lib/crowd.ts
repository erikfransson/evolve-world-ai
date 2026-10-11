// A grazing crowd driven by the real simulation (World, Creature, collide), drawn as Critters with reactions.
import { DEFAULT_CONFIG, itemCounts, withOverrides } from "../../../src/typescript/src/sim/config.ts";
import { genomeLength, layerSizes } from "../../../src/typescript/src/sim/brain.ts";
import { Creature } from "../../../src/typescript/src/sim/creature.ts";
import { collide } from "../../../src/typescript/src/sim/physics.ts";
import type { Contact } from "../../../src/typescript/src/sim/physics.ts";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "../../../src/typescript/src/sim/types.ts";
import type { HitKind } from "../../../src/typescript/src/sim/types.ts";
import { World } from "../../../src/typescript/src/sim/world.ts";
import { Critter } from "./critter.ts";
import { clamp, lerp, rng, wrapAngle } from "./ease.ts";
import { item } from "./stage.ts";
import type { Item } from "./stage.ts";

export const SIM_DT = DEFAULT_CONFIG.dt;

export interface CrowdOptions {
  width: number; height: number; radius: number;
  families: number[]; // hues
  perFamily: number;
  cap: number; // most living at once
  food: number; // food density
  poison: number; // fraction of items that are poison
  seed: number;
  births?: boolean;
}

export interface Member {
  c: Critter; body: Creature; live: boolean; fam: number;
  e: number; // energy 0..1
  bornAt: number; leaveAt: number; skip: number;
  px: number; py: number; // previous tick position for interpolation
  avoidUntil: number; // ticks; set after eating poison, it then steers away from poison
  calm: number; // tick before which it does not react to bumps again
}

export interface CrowdEvents {
  eat?(m: Member, it: Item, t: number): void;
  poison?(m: Member, it: Item, t: number): void;
  bump?(a: Member, b: Member, speed: number, t: number): void;
  birth?(parent: Member, child: Member, t: number): void;
}

const TAU = Math.PI * 2;

export class Crowd {
  config: ReturnType<typeof withOverrides>; world: World; members: Member[] = []; items: Item[] = []; ghosts: Item[] = [];
  tick = 0;
  private rand: () => number;
  private srng: ReturnType<typeof createRng>; private genome: Float32Array; private contact: Contact = { speed: 0 } as Contact;
  o: CrowdOptions; on: CrowdEvents;
  constructor(o: CrowdOptions, on: CrowdEvents = {}) {
    this.o = o; this.on = on;
    this.config = withOverrides(DEFAULT_CONFIG, { world: { width: o.width, height: o.height, foodDensity: o.food, poisonDensity: 0, respawn: true }, creature: { radius: o.radius } });
    const { food } = itemCounts(this.config);
    const poison = Math.round(food * o.poison);
    this.world = new World(this.config, food + poison);
    this.srng = createRng(o.seed);
    this.world.scatter(food, poison, this.srng);
    this.rand = rng(o.seed + 99);
    this.genome = new Float32Array(genomeLength(layerSizes(this.config)));
    for (let i = 0; i < this.world.count; i++) this.items.push(item(this.world.xs[i]!, this.world.ys[i]!, this.world.kinds[i] === HIT_POISON ? "poison" : "food", o.radius * 0.42, -1, i + 1));
    const slots = o.cap + 4;
    for (let i = 0; i < slots; i++) {
      const fam = Math.floor(i / o.perFamily) % o.families.length;
      const first = i < o.families.length * o.perFamily;
      const hue = (o.families[fam]! + (this.rand() - 0.5) * 20 + 360) % 360;
      const body = new Creature(this.config, this.genome, 0, 0, 0);
      const c = new Critter(0, 0, o.radius, hue, i + 3);
      const m: Member = { c, body, live: first, fam, e: 0.3 + 0.6 * this.rand(), bornAt: -999, leaveAt: -1, skip: i % 3 === 0 ? 1 : 0, px: 0, py: 0, avoidUntil: 0, calm: 0 };
      if (first) {
        body.reset(this.genome, o.radius + this.rand() * (o.width - 2 * o.radius), o.radius + this.rand() * (o.height - 2 * o.radius), this.rand() * TAU, this.config.creature.startEnergy);
        m.px = body.state.x; m.py = body.state.y;
      }
      this.members.push(m);
    }
  }

  // Nearest item of a kind, skipping `skip` nearer ones.
  private nearest(x: number, y: number, kind: number, skip: number): number {
    let best = -1, bd = Infinity, second = -1, sd = Infinity;
    const w = this.world;
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] !== kind) continue;
      const d = (w.xs[i]! - x) ** 2 + (w.ys[i]! - y) ** 2;
      if (d < bd) { second = best; sd = bd; best = i; bd = d; } else if (d < sd) { second = i; sd = d; }
    }
    return skip && second >= 0 ? second : best;
  }

  step(t: number): void {
    this.tick++;
    const w = this.world, r = this.o.radius, start = this.config.creature.startEnergy;
    for (const m of this.members) {
      if (!m.live) continue;
      const s = m.body.state;
      m.px = s.x; m.py = s.y;
      if (m.leaveAt >= 0) continue;
      // Grazers head for food and walk through poison, unless they recently learned to steer around it.
      const target = this.nearest(s.x, s.y, HIT_FOOD, m.skip);
      let tx = w.xs[target]!, ty = w.ys[target]!;
      if (this.tick < m.avoidUntil) {
        const p = this.nearest(s.x, s.y, HIT_POISON, 0);
        if (p >= 0) {
          const dx = s.x - w.xs[p]!, dy = s.y - w.ys[p]!, d = Math.hypot(dx, dy);
          if (d < r * 4) { tx += (dx / d) * r * 6; ty += (dy / d) * r * 6; }
        }
      }
      const d = wrapAngle(Math.atan2(ty - s.y, tx - s.x) - s.heading);
      const eaten = m.body.move(w, clamp(2 * d, -1, 1), 0.3 + 0.6 * Math.max(0, Math.cos(d)));
      s.energy = start;
      if (eaten >= 0) {
        const it = this.items[eaten]!;
        const ghost = { ...it, eatenAt: t, eater: m.c };
        this.ghosts.push(ghost);
        const kind = w.kinds[eaten] as HitKind;
        w.placeRandomly(eaten, kind, this.srng);
        it.x = w.xs[eaten]!; it.y = w.ys[eaten]!; it.born = t + 0.4; it.seed += 101;
        if (kind === HIT_POISON) { m.e = Math.max(0.1, m.e - 0.3); m.avoidUntil = this.tick + 400; this.on.poison?.(m, ghost, t); }
        else { m.e += 0.16; this.on.eat?.(m, ghost, t); }
      }
      m.e = Math.max(0.12, m.e - 0.02 * SIM_DT);
    }
    for (let i = 0; i < this.members.length; i++) {
      const a = this.members[i]!;
      if (!a.live || a.leaveAt >= 0) continue;
      for (let j = i + 1; j < this.members.length; j++) {
        const b = this.members[j]!;
        if (!b.live || b.leaveAt >= 0) continue;
        if (collide(a.body.state, b.body.state, r, 1, this.contact) && this.contact.speed > 12 && this.tick > a.calm && this.tick > b.calm) {
          a.calm = b.calm = this.tick + 90;
          this.on.bump?.(a, b, this.contact.speed, t);
        }
      }
    }
    if (this.o.births !== false) for (const m of this.members) if (m.live && m.leaveAt < 0 && m.e >= 1 && t - m.bornAt > 3) this.birth(m, t);
    for (const m of this.members) if (m.leaveAt >= 0 && t - m.leaveAt > 1.2) m.live = false;
    this.ghosts = this.ghosts.filter((g) => t - g.eatenAt < 0.3);
  }

  private birth(p: Member, t: number): void {
    p.e = 0.55;
    const child = this.members.find((m) => !m.live);
    if (!child) return;
    const living = this.members.filter((m) => m.live && m.leaveAt < 0);
    if (living.length >= this.o.cap) living.reduce((o, m) => (m.bornAt < o.bornAt ? m : o)).leaveAt = t;
    const s = p.body.state, a = this.rand() * TAU, d = 2 * this.o.radius + 1;
    const x = clamp(s.x + Math.cos(a) * d, this.o.radius, this.o.width - this.o.radius), y = clamp(s.y + Math.sin(a) * d, this.o.radius, this.o.height - this.o.radius);
    child.body.reset(this.genome, x, y, a, this.config.creature.startEnergy);
    child.body.state.vx = Math.cos(a) * 55; child.body.state.vy = Math.sin(a) * 55;
    child.px = x; child.py = y;
    child.c.hue = (p.c.hue + (this.rand() - 0.5) * 20 + 360) % 360;
    child.fam = p.fam; child.e = 0.4; child.live = true; child.leaveAt = -1; child.bornAt = t; child.avoidUntil = 0;
    this.on.birth?.(p, child, t);
  }

  // Moves the Critters to the interpolated sim positions; `frac` is how far into the next tick we are.
  sync(t: number, dt: number, frac: number): void {
    for (const m of this.members) {
      if (!m.live) continue;
      const s = m.body.state;
      m.c.moveTo(lerp(m.px, s.x, frac), lerp(m.py, s.y, frac), s.vx, s.vy);
      m.c.energy = clamp(m.e);
      m.c.scale = m.bornAt < 0 ? 1 : popIn(t - m.bornAt);
      m.c.alpha = m.leaveAt < 0 ? 1 : clamp(1 - (t - m.leaveAt) / 1.2);
      m.c.update(t, dt);
    }
  }

  get kinds(): Uint8Array | number[] { return this.world.kinds as unknown as number[]; }
  alive(): Member[] { return this.members.filter((m) => m.live); }
  static readonly NONE = HIT_NONE;
}

const popIn = (age: number): number => {
  const u = clamp(age / 0.35);
  return Math.max(0.01, 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2);
};
