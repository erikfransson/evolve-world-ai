import type { EcoConfig } from "./ecoConfig.ts";
import type { SpeciesCount } from "./ecosystem.ts";
import type { MemberTable } from "./memberTable.ts";
import { collide, hurt, keepInside } from "./physics.ts";
import type { Body, Contact } from "./physics.ts";
import type { StatefulRng } from "./rng.ts";
import type { Species } from "./species.ts";
import { HIT_FOOD, HIT_NONE } from "./types.ts";
import type { CreatureState, HitKind } from "./types.ts";
import type { Crowd } from "./crowd.ts";
import type { World } from "./world.ts";

// Collision events for the page's effects, collected since the last drain and bounded: a Float32Array of EVENT_STRIDE numbers each, kind, x, y, value.
// An impact (kind 0, value = energy each lost) is reported at BIG_IMPACT or more; a death (kind 1, value = hue) from a bump or a hunt. Reporting changes no results.
export const EVENT_IMPACT = 0;
export const EVENT_DEATH = 1;
export const EVENT_STRIDE = 4;
export const EVENT_CAP = 32;
export const BIG_IMPACT = 15;

// What creatures do to each other and to items in the shared phase of a tick: eating, hunting and collisions, with their events. Works on the Ecosystem's
// member table, crowd grid and items; the counters of eaten items stay with the Ecosystem, which reads them off eatAt.
export class Contacts {
  readonly slain = new Set<CreatureState>(); // killed by a bump or a hunt this tick
  private readonly config: EcoConfig;
  private readonly items: World;
  private readonly crowd: Crowd;
  private readonly table: MemberTable;
  private readonly species: readonly Species[];
  private readonly counts: SpeciesCount[];
  private readonly rng: StatefulRng;
  private readonly contact: Contact = { speed: 0 };
  private readonly events = new Float32Array(EVENT_CAP * EVENT_STRIDE);
  private eventCount = 0;

  constructor(config: EcoConfig, items: World, crowd: Crowd, table: MemberTable, species: readonly Species[], counts: SpeciesCount[], rng: StatefulRng) {
    this.config = config;
    this.items = items;
    this.crowd = crowd;
    this.table = table;
    this.species = species;
    this.counts = counts;
    this.rng = rng;
  }

  // Member at eats: the item looked up for it in touched, or the first it touches now. Returns the kind of the item eaten (removed from the world), HIT_NONE for none.
  eatAt(at: number, touched?: Int32Array): HitKind {
    const m = this.table.members[at]!;
    if (!this.species[m.species]!.plants) return HIT_NONE;
    let eaten: number;
    if (touched && (touched[at] < 0 || this.items.kinds[touched[at]] !== HIT_NONE)) {
      // Items are only removed in the eat loop, so a looked-up item still there is still the first touched, and none stays none.
      eaten = touched[at];
      if (eaten >= 0) m.creature.eatItem(this.items, eaten);
    } else eaten = m.creature.eat(this.items); // looked up item taken by an earlier creature, or no lookup
    if (eaten < 0) return HIT_NONE;
    const kind = this.items.kinds[eaten] as HitKind;
    if (kind === HIT_FOOD) m.eaten++;
    this.items.removeItem(eaten); // so no one else eats it this tick
    return kind;
  }

  // Each living hunter, from a random start, eats the nearest touching creature of a species it preys on, at most one per
  // tick, using the grid of the moved positions. The prey dies (removed with the other deaths) and cannot be eaten twice.
  hunt(): void {
    const crowd = this.crowd;
    const states = this.table.states;
    const members = this.table.members;
    const n = members.length;
    const reach = 2 * this.config.creature.radius;
    const inv = 1 / crowd.cell;
    const first = n > 0 ? this.rng.int(n) : 0;
    for (let k = 0; k < n; k++) {
      const hunter = members[(first + k) % n]!;
      const sp = this.species[hunter.species]!;
      const s = states[(first + k) % n]!;
      if (sp.prey.length === 0 || s.energy <= 0) continue;
      const cx0 = Math.max(0, Math.floor((s.x - reach) * inv));
      const cx1 = Math.min(crowd.cols - 1, Math.floor((s.x + reach) * inv));
      const cy0 = Math.max(0, Math.floor((s.y - reach) * inv));
      const cy1 = Math.min(crowd.rows - 1, Math.floor((s.y + reach) * inv));
      let best = -1;
      let bestD2 = reach * reach;
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * crowd.cols;
        const end = crowd.cellStart[row + cx1 + 1]!;
        for (let t = crowd.cellStart[row + cx0]!; t < end; t++) {
          if (!sp.prey.includes(crowd.species[t]!)) continue;
          const o = crowd.owners[t]!;
          const p = states[o]!;
          if (!p.alive || p.energy <= 0) continue;
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && best >= 0 && members[o]!.id < members[best]!.id)) {
            best = o;
            bestD2 = d2;
          }
        }
      }
      if (best < 0) continue;
      const prey = states[best]!;
      s.energy += sp.eatEfficiency * prey.energy + sp.eatBaseline;
      prey.energy = 0;
      prey.alive = false;
      this.slain.add(prey);
      hunter.kills++;
      this.counts[members[best]!.species]!.eaten++;
    }
  }

  // Pushes overlapping pairs apart with a bounce, using a grid of the moved positions. Pairs resolve in grid order.
  // The sweep culls on the grid's sorted position arrays; only overlapping pairs touch the creature objects (bump), which write
  // their new positions back to the arrays for the pairs after them.
  // The crowd already holds the moved positions (sharedPhase rebuilds it before eating).
  collideAll(): void {
    const crowd = this.crowd;
    if (this.table.length < 2) return; // no pairs
    const { cols, rows, cellStart, xs, ys } = crowd;
    const { radius } = this.config.creature;
    const reach = 2 * radius;
    const reach2 = reach * reach;
    const kernel = crowd.kernel;
    if (kernel) {
      // the same sweep in WebAssembly (crowd.wat sweep), which finds the pairs; the bumps stay here
      kernel.sweepStart(reach2);
      while (kernel.sweepNext()) this.bumpSlots(kernel.hitS, kernel.hitT, radius);
      return;
    }
    // Occupied cells in row-major order, the same order as sweeping every cell.
    for (let o = 0; o < crowd.occupiedCount; o++) {
      const c = crowd.occupied[o]!;
      const cy = Math.floor(c / cols);
      const cx = c - cy * cols;
      const end = cellStart[c + 1]!;
      const hasRight = cx + 1 < cols;
      // Later creatures of this cell and the cell to the right are one run, the cells below-left, below and below-right another,
      // so each pair is seen once.
      const run1 = hasRight ? cellStart[c + 2]! : end;
      let run2a = 0;
      let run2b = 0;
      if (cy + 1 < rows) {
        const below = c + cols;
        run2a = cellStart[cx > 0 ? below - 1 : below]!;
        run2b = cellStart[hasRight ? below + 2 : below + 1]!;
      }
      for (let s = cellStart[c]!; s < end; s++) {
        for (let t = s + 1; t < run1; t++) {
          const dx = xs[t]! - xs[s]!;
          const dy = ys[t]! - ys[s]!;
          if (!(dx * dx + dy * dy >= reach2)) this.bumpSlots(s, t, radius);
        }
        for (let t = run2a; t < run2b; t++) {
          const dx = xs[t]! - xs[s]!;
          const dy = ys[t]! - ys[s]!;
          if (!(dx * dx + dy * dy >= reach2)) this.bumpSlots(s, t, radius);
        }
      }
    }
  }

  // bump for the creatures at sorted slots s and t of the crowd, then their positions back into its arrays.
  private bumpSlots(s: number, t: number, radius: number): void {
    const { owners, xs, ys } = this.crowd;
    const a = this.table.states[owners[s]!]!;
    const b = this.table.states[owners[t]!]!;
    this.bump(a, b, radius, 1);
    xs[s] = a.x;
    ys[s] = a.y;
    xs[t] = b.x;
    ys[t] = b.y;
  }

  private bump(a: CreatureState, b: CreatureState, radius: number, e: number): void {
    const eco = this.config.eco;
    if (!a.alive || !b.alive) return; // an eaten prey; everyone else is alive until settle
    if (!collide(a, b, radius, e, this.contact)) return;
    if (eco.collisionDamage) {
      const fresh = a.energy > 0 && b.energy > 0 && this.contact.speed > 0; // else hurt does nothing
      hurt(a, b, this.contact.speed, eco.damagePerSpeed);
      if (fresh) this.noteHurt(a, b, eco.damagePerSpeed * this.contact.speed);
    }
    this.confine(a);
    this.confine(b);
  }

  // Keeps a creature inside the walls and out of the rock.
  confine(s: Body): void {
    const { radius, wallBounce } = this.config.creature;
    const { width, height } = this.config.world;
    keepInside(s, radius, width, height, wallBounce);
    this.items.terrain.keepOut(s, radius, wallBounce);
  }

  private noteHurt(a: CreatureState, b: CreatureState, loss: number): void {
    if (loss >= BIG_IMPACT) this.report(EVENT_IMPACT, (a.x + b.x) / 2, (a.y + b.y) / 2, loss);
    if (a.energy <= 0) this.slain.add(a);
    if (b.energy <= 0) this.slain.add(b);
  }

  report(kind: number, x: number, y: number, value: number): void {
    if (this.eventCount >= EVENT_CAP) return;
    this.events.set([kind, x, y, value], this.eventCount++ * EVENT_STRIDE);
  }

  // The events since the last call, or null for none.
  drainEvents(): Float32Array | null {
    if (this.eventCount === 0) return null;
    const out = this.events.slice(0, this.eventCount * EVENT_STRIDE);
    this.eventCount = 0;
    return out;
  }
}
