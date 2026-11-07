import { BIG_IMPACT, Contacts, EVENT_CAP, EVENT_DEATH, EVENT_IMPACT, EVENT_STRIDE } from "../../src/typescript/src/sim/contacts.ts";
import type { CreatureState } from "../../src/typescript/src/sim/types.ts";

// Contacts alone on hand-built members and a one-cell crowd: hunting, collision damage with its events, and the event queue (whole worlds run them in the ecosystem tests).

type Any = any; // stand-ins for the Ecosystem's table, crowd and world

const R = 5; // creature radius
const state = (x: number, y: number, over: Partial<CreatureState> = {}): CreatureState => ({ x, y, heading: 0, vx: 0, vy: 0, turnRate: 0, energy: 100, alive: true, ticksAlive: 0, ...over });

// Members of the given species at the given states; one crowd cell holding them all in member order.
function make(states: CreatureState[], speciesOf: number[], opts: { prey?: number[][]; damage?: boolean; killEnergy?: number } = {}) {
  const members = states.map((_, i) => ({ id: i, species: speciesOf[i]!, kills: 0, bumpKills: 0 }));
  const table = { members, states, length: states.length };
  const crowd = {
    cell: 1000, cols: 1, rows: 1, cellStart: Uint32Array.of(0, states.length), owners: Int32Array.from(states, (_, i) => i), species: Int32Array.from(speciesOf),
    xs: Float32Array.from(states, (s) => s.x), ys: Float32Array.from(states, (s) => s.y), occupied: Int32Array.of(0), occupiedCount: 1, kernel: null,
  };
  const species = (opts.prey ?? [[], []]).map((prey) => ({ prey, plants: false, eatEfficiency: 0.5, eatBaseline: 1 }));
  const counts = species.map(() => ({ eaten: 0 }));
  const config = {
    creature: { radius: R, wallBounce: 1 }, world: { width: 1000, height: 1000 },
    eco: { collisionDamage: opts.damage ?? false, damagePerSpeed: 1, killEnergy: opts.killEnergy ?? 0, ramShare: undefined },
  };
  const items = { terrain: { keepOut: () => {} } };
  const rng = { int: () => 0 };
  const contacts = new Contacts(config as Any, items as Any, crowd as Any, table as Any, species as Any, counts as Any, rng as Any);
  return { contacts, members, counts };
}

describe("Contacts.hunt", () => {
  it("a hunter eats the nearest touching prey: gains efficiency times its energy plus the baseline, the prey dies once, counters and the death event follow", () => {
    const states = [state(500, 500), state(500 + 6, 500, { energy: 40 }), state(500 + 9, 500, { energy: 60 })]; // both prey touch (reach 10); the first is nearer
    const { contacts, members, counts } = make(states, [0, 1, 1], { prey: [[1], []] });
    contacts.hunt();
    expect(states[0]!.energy).toBe(100 + 0.5 * 40 + 1);
    expect([states[1]!.alive, states[1]!.energy]).toEqual([false, 0]);
    expect(states[2]!.alive).toBe(true); // at most one per tick
    expect(members[0]!.kills).toBe(1);
    expect(counts[1]!.eaten).toBe(1);
    contacts.died(states[1]!, 123); // settle meets the dead
    const events = contacts.drainEvents()!;
    expect(Array.from(events)).toEqual([EVENT_DEATH, 506, 500, 123]);
    expect(contacts.drainEvents()).toBeNull();
  });

  it("skips prey out of reach, of a species not preyed on, already dead or without energy, and hunters without energy", () => {
    const states = [state(500, 500), state(500 + 11, 500), state(500, 504, { alive: false }), state(504, 500, { energy: 0 })];
    const { contacts } = make(states, [0, 1, 1, 1], { prey: [[1], []] });
    contacts.hunt();
    expect(states.map((s) => s.alive)).toEqual([true, true, false, true]);
    expect(states[1]!.energy).toBe(100);
    const hungry = [state(500, 500, { energy: 0 }), state(503, 500)];
    make(hungry, [0, 1], { prey: [[1], []] }).contacts.hunt();
    expect(hungry[1]!.alive).toBe(true);
  });
});

describe("Contacts.collideAll", () => {
  it("pushes an overlapping pair apart and, with damage on, costs both energy by the closing speed", () => {
    const states = [state(500, 500, { vx: 10 }), state(500 + 6, 500, { vx: -10 })]; // overlapping by 4, closing at 20
    const { contacts } = make(states, [0, 0], { damage: true });
    contacts.collideAll();
    expect(states[1]!.x - states[0]!.x).toBeGreaterThanOrEqual(2 * R - 1e-9);
    expect(states[0]!.energy).toBe(80);
    expect(states[1]!.energy).toBe(80);
    expect(states[0]!.vx).toBeLessThan(0); // bounced
    expect(Array.from(contacts.drainEvents()!)).toEqual([EVENT_IMPACT, 503, 500, 20]); // 20 each is a big impact, at the midpoint
  });

  it("reports a big impact as an event, and a lethal bump with one survivor as a kill", () => {
    expect(BIG_IMPACT).toBeLessThan(20);
    const states = [state(500, 500, { vx: 10 }), state(506, 500, { vx: -10, energy: 5 })];
    const { contacts, members } = make(states, [0, 0], { damage: true, killEnergy: 3 });
    const seen: [CreatureState, CreatureState][] = [];
    contacts.onBumpKill = (survivor, victim) => seen.push([survivor, victim]);
    contacts.collideAll();
    expect(states[1]!.energy).toBe(0);
    expect(states[0]!.energy).toBe(100 - 20 + 5 + 3); // lost 20 to the bump, took the victim's energy before it and the kill bonus
    expect(contacts.bumpKills).toBe(1);
    expect(members[0]!.bumpKills).toBe(1);
    expect(seen).toEqual([[states[0], states[1]]]);
    const events = contacts.drainEvents()!;
    expect(events[0]).toBe(EVENT_IMPACT);
    expect(events[3]).toBe(20);
    contacts.died(states[1]!, 7);
    expect(contacts.drainEvents()![0]).toBe(EVENT_DEATH); // slain by a bump
    contacts.died(states[0]!, 8); // not slain: no event
    expect(contacts.drainEvents()).toBeNull();
  });

  it("a creature killed by a bump, or already at 0 energy, no longer pushes or blocks the others", () => {
    const states = [state(500, 500, { vx: 10 }), state(506, 500, { vx: -10, energy: 5 }), state(512, 500)]; // 0 kills 1 first, then 1 still overlaps 2
    make(states, [0, 0, 0], { damage: true }).contacts.collideAll();
    expect(states[1]!.energy).toBe(0);
    expect([states[2]!.x, states[2]!.vx]).toEqual([512, 0]);
    const starved = [state(500, 500, { energy: 0 }), state(504, 500)];
    make(starved, [0, 0]).contacts.collideAll();
    expect([starved[0]!.x, starved[1]!.x]).toEqual([500, 504]);
  });

  it("keeps at most EVENT_CAP events between drains", () => {
    const pairs = EVENT_CAP + 8;
    const states = Array.from({ length: 2 * pairs }, (_, i) => state(20 + 30 * (i >> 1) + 6 * (i & 1), 500, { vx: i & 1 ? -10 : 10 })); // each pair collides, no two pairs touch
    const { contacts } = make(states, states.map(() => 0), { damage: true });
    contacts.collideAll();
    expect(contacts.drainEvents()!.length).toBe(EVENT_CAP * EVENT_STRIDE);
    expect(contacts.drainEvents()).toBeNull();
  });

  it("does nothing for fewer than two members, and endTick forgets the slain so a later death is not reported", () => {
    const one = make([state(500, 500)], [0]);
    one.contacts.collideAll();
    expect(one.contacts.drainEvents()).toBeNull();
    const states = [state(500, 500), state(504, 500)];
    const { contacts } = make(states, [0, 1], { prey: [[1], []] });
    contacts.hunt();
    contacts.endTick();
    contacts.died(states[1]!, 9);
    expect(contacts.drainEvents()).toBeNull();
  });
});
