import type { EcoCreature } from "./ecosystem.ts";
import type { CreatureState } from "./types.ts";

const START_CAPACITY = 64;

// The living creatures of an Ecosystem in list order, and every per-member column the hot loops read. admit and swapRemove are the only writers, so
// the columns cannot drift apart: entry i of each is about members[i]. Also the members in creature construction order (Creature.slot) with, for resident
// bodies, the whole sense batch as row addresses and member indices.
export class MemberTable {
  readonly members: EcoCreature[] = [];
  readonly states: CreatureState[] = []; // states[i] is members[i].creature.state
  readonly byId = new Map<number, EcoCreature>();
  // Valid for the first members.length entries; the arrays are replaced when they fill up, so read them from the table, not from a copy held across an admit.
  kinds = new Int32Array(START_CAPACITY); // species of members[i]
  birthEnergies = new Float64Array(START_CAPACITY); // members[i].birth.energy, so the birth scan reads no creature object
  rowAt = new Int32Array(START_CAPACITY); // resident bodies: f64 index of members[i]'s row, so the hot loops read the rows, not the state objects
  readonly bySlot: EcoCreature[] = []; // the members in creature construction order, kept up to date as they come and go
  slotRows = new Int32Array(START_CAPACITY); // resident bodies: the row addresses and member indices of bySlot, in that order
  slotSelves = new Int32Array(START_CAPACITY);
  version = 0; // counts admit and swapRemove calls, so a grid of the members can tell it is still theirs
  private readonly resident: boolean;

  constructor(resident: boolean) {
    this.resident = resident;
  }

  get length(): number {
    return this.members.length;
  }

  // Adds m at the end of the member list, and to bySlot. Its species, birth energy and (resident) row are read from m now.
  admit(m: EcoCreature): void {
    const i = this.members.length;
    this.version++;
    if (i === this.kinds.length) this.growColumns();
    m.index = i;
    this.members.push(m);
    this.states.push(m.creature.state);
    this.kinds[i] = m.species;
    this.birthEnergies[i] = m.birth.energy;
    this.byId.set(m.id, m);
    const list = this.bySlot;
    const slot = m.creature.slot;
    const at = list.length === 0 || list[list.length - 1]!.creature.slot < slot ? list.length : this.slotPosition(slot);
    list.splice(at, 0, m);
    if (this.resident) {
      const r = m.creature.resident!;
      this.rowAt[i] = r.o;
      this.slotRows.copyWithin(at + 1, at, i);
      this.slotSelves.copyWithin(at + 1, at, i);
      this.slotRows[at] = r.ptr;
      this.slotSelves[at] = i;
    }
  }

  // Removes members[i] by moving the last member into its place; returns the removed one.
  swapRemove(i: number): EcoCreature {
    const m = this.members[i]!;
    this.version++;
    const last = this.members.length - 1;
    const moved = this.members[last]!;
    this.members[i] = moved;
    moved.index = i;
    const at = this.slotPosition(m.creature.slot);
    this.bySlot.splice(at, 1);
    if (this.resident) {
      this.slotRows.copyWithin(at, at + 1, last + 1);
      this.slotSelves.copyWithin(at, at + 1, last + 1);
      this.rowAt[i] = this.rowAt[last]!;
      if (moved !== m) this.slotSelves[this.slotPosition(moved.creature.slot)] = i; // the member that took m's place in the list
    }
    this.states[i] = this.states[last]!;
    this.kinds[i] = this.kinds[last]!;
    this.birthEnergies[i] = this.birthEnergies[last]!;
    this.members.pop();
    this.states.pop();
    this.byId.delete(m.id);
    return m;
  }

  // Where a creature of this slot sits (or would sit) in bySlot.
  private slotPosition(slot: number): number {
    const list = this.bySlot;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.creature.slot < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private growColumns(): void {
    const size = 2 * this.kinds.length;
    const grown = <T extends Int32Array | Float64Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a);
      return b;
    };
    this.kinds = grown(this.kinds);
    this.birthEnergies = grown(this.birthEnergies);
    this.rowAt = grown(this.rowAt);
    this.slotRows = grown(this.slotRows);
    this.slotSelves = grown(this.slotSelves);
  }
}
