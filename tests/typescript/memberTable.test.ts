import { MemberTable } from "../../src/typescript/src/sim/memberTable.ts";
import type { EcoCreature } from "../../src/typescript/src/sim/ecosystem.ts";

// admit and swapRemove keep every column in step with the member list, for any order of slots and removals.

const fake = (id: number, slot: number): EcoCreature =>
  ({ id, index: -1, species: id % 3, birth: { energy: id + 0.5 }, creature: { state: { id }, slot, resident: { o: 10 * id, ptr: 1000 + id } } }) as unknown as EcoCreature;

function check(t: MemberTable): void {
  expect(t.bySlot.length).toBe(t.length);
  t.members.forEach((m, i) => {
    expect(m.index).toBe(i);
    expect(t.states[i]).toBe(m.creature.state);
    expect(t.kinds[i]).toBe(m.species);
    expect(t.birthEnergies[i]).toBe(m.birth.energy);
    expect(t.rowAt[i]).toBe(m.creature.resident!.o);
    expect(t.byId.get(m.id)).toBe(m);
  });
  t.bySlot.forEach((m, k) => {
    if (k > 0) expect(t.bySlot[k - 1]!.creature.slot).toBeLessThan(m.creature.slot);
    expect(t.slotSelves[k]).toBe(m.index);
    expect(t.slotRows[k]).toBe(m.creature.resident!.ptr);
  });
  expect(t.byId.size).toBe(t.length);
}

// Small deterministic generator, so the test does not depend on the sim's rng.
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

describe("MemberTable", () => {
  it("keeps every column in step through random admits and removals, past a regrow", () => {
    const rand = lcg(7);
    const t = new MemberTable(true);
    const slots = Array.from({ length: 300 }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    }
    let id = 0;
    for (const slot of slots) {
      t.admit(fake(id++, slot));
      if (id % 4 === 0) {
        const gone = t.swapRemove(Math.floor(rand() * t.length));
        expect(t.byId.has(gone.id)).toBe(false);
      }
      if (id % 25 === 0) check(t);
    }
    while (t.length > 0) {
      t.swapRemove(Math.floor(rand() * t.length));
      check(t);
    }
  });

  it("removes the last member and the only member", () => {
    const t = new MemberTable(true);
    for (const [id, slot] of [[0, 5], [1, 2], [2, 9]] as const) t.admit(fake(id, slot));
    expect(t.swapRemove(t.length - 1).id).toBe(2);
    check(t);
    t.swapRemove(0);
    check(t);
    t.swapRemove(0);
    expect(t.length).toBe(0);
    expect(t.bySlot.length).toBe(0);
  });

  it("without resident bodies leaves the slot columns alone", () => {
    const t = new MemberTable(false);
    t.admit(fake(0, 1));
    t.admit(fake(1, 0));
    t.swapRemove(0);
    expect(t.members.map((m) => m.id)).toEqual([1]);
    expect(t.bySlot.map((m) => m.id)).toEqual([1]);
  });
});
