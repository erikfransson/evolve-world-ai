// @vitest-environment node
import { LIVE } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { LiveLink } from "../../src/typescript/src/live/connection.ts";
import { BIRTH_BYTES, MAX_BIRTH_WAIT_S, birthNote, decodeBirthWait, encodeBirthWait } from "../../src/typescript/src/live/detail.ts";
import type { BirthWait, Detail } from "../../src/typescript/src/live/detail.ts";
import { MSG_BIRTH, PROTOCOL_VERSION } from "../../src/typescript/src/live/protocol.ts";
import { smallConfig } from "./liveHelpers.ts";

const ready = { energy: 300, birthEnergy: 200 };
const wait = (waitS: number, full = false): BirthWait => ({ tick: 1, id: 2, waitS, full });

describe("birth wait: wire", () => {
  it("round-trips the wait in tenths of a second, rounded up, and the full flag", () => {
    expect(decodeBirthWait(encodeBirthWait(77, 9, 12.34, true))).toEqual({ tick: 77, id: 9, waitS: 12.4, full: true });
    expect(decodeBirthWait(encodeBirthWait(1, 2, 0.01, false))).toEqual({ tick: 1, id: 2, waitS: 0.1, full: false }); // never 0 while waiting
    expect(encodeBirthWait(1, 2, 0, false).length).toBe(BIRTH_BYTES);
  });

  // Red without the clamp: setUint16 wraps a huge wait to a small one, and NaN or a negative to garbage.
  it("sends a non-finite, negative or huge wait as 0 or the cap", () => {
    const sent = (s: number): number => decodeBirthWait(encodeBirthWait(1, 2, s, false)).waitS;
    expect(sent(-Infinity)).toBe(0); // a creature that never gave birth (lastBirthTick -Infinity)
    expect(sent(-5)).toBe(0);
    expect(sent(Number.NaN)).toBe(0);
    expect(sent(1e9)).toBe(MAX_BIRTH_WAIT_S);
    expect(sent(Infinity)).toBe(MAX_BIRTH_WAIT_S);
  });

  it("rejects a short, oversized or mistyped message and ignores later bytes and flag bits", () => {
    const b = encodeBirthWait(1, 2, 3, true);
    expect(() => decodeBirthWait(b.slice(0, BIRTH_BYTES - 1))).toThrow();
    expect(() => decodeBirthWait(new Uint8Array(65).fill(MSG_BIRTH))).toThrow();
    expect(() => decodeBirthWait(Uint8Array.from([5, ...b.slice(1)]))).toThrow();
    const longer = new Uint8Array(20);
    longer.set(b);
    longer[11] = 0xfe; // bit 0 clear, the rest set
    expect(decodeBirthWait(longer)).toEqual({ tick: 1, id: 2, waitS: 3, full: false });
  });
});

describe("birth wait: the selected card's note", () => {
  it("shows the cooldown left while one runs, counting whole seconds up", () => {
    expect(birthNote(ready, wait(12.3))).toBe("cooldown 13 s");
    expect(birthNote(ready, wait(0.1))).toBe("cooldown 1 s");
    expect(birthNote(ready, wait(99.5))).toBe("cooldown 100 s");
    expect(birthNote(ready, wait(150))).toBe("cooldown 3 min");
    expect(birthNote(ready, wait(5, true))).toBe("cooldown 5 s"); // it ends on its own; full shows after
  });

  it("says the world is full once the cooldown is over, and nothing when nothing holds it", () => {
    expect(birthNote(ready, wait(0, true))).toBe("world full");
    expect(birthNote(ready, wait(0))).toBe("");
  });

  it("shows nothing below the birth energy, or with no BIRTH from an older server", () => {
    expect(birthNote({ energy: 199, birthEnergy: 200 }, wait(10, true))).toBe("");
    expect(birthNote({ energy: 200, birthEnergy: 200 }, wait(10))).toBe("cooldown 10 s");
    expect(birthNote(ready, undefined)).toBe("");
    expect(birthNote(ready, null)).toBe("");
  });

  it("ignores non-finite or negative waits and caps huge ones", () => {
    expect(birthNote(ready, wait(Number.NaN))).toBe("");
    expect(birthNote(ready, wait(Infinity))).toBe("");
    expect(birthNote(ready, wait(-3))).toBe("");
    expect(birthNote(ready, wait(1e12))).toBe(`cooldown ${Math.ceil(MAX_BIRTH_WAIT_S / 60)} min`);
    expect(birthNote({ energy: Number.NaN, birthEnergy: 1 }, wait(5))).toBe("");
    expect(birthNote(ready, { waitS: 0, full: "yes" as never })).toBe("");
  });
});

describe("birth wait: server", () => {
  const world = (): LiveWorld => {
    const w = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 5; i++) w.step();
    return w;
  };
  const read = (w: LiveWorld, id: number): BirthWait => decodeBirthWait(w.birthWait(id)!);

  it("sends the cooldown left after a birth, none before the first, and nothing for a dead id", () => {
    const w = world();
    const m = w.eco.members[0]!;
    expect(read(w, m.id)).toEqual({ tick: w.eco.tick, id: m.id, waitS: 0, full: false });
    m.lastBirthTick = w.eco.tick - 30;
    expect(read(w, m.id).waitS).toBeCloseTo(Math.ceil((m.cooldownTicks - 30) * w.config.dt * 10) / 10, 6);
    expect(w.birthWait(4_000_000_000)).toBeNull();
  });

  it("covers an added creature's birth hold", () => {
    const w = world();
    const src = w.eco.members[0]!;
    const r = w.addCreatures({ plan: { ...src.creature.plan, hiddenLayers: [...src.creature.plan.hiddenLayers] }, genome: src.creature.brain.genome as Float32Array, birth: { energy: 150, cost: 70, cooldown: 10 }, name: "Kiwi", hue: 10, copies: 1 });
    if (!("ids" in r)) throw new Error(r.reason);
    expect(read(w, r.ids[0]!).waitS).toBeCloseTo(LIVE.add.birthHoldS, 1);
  });

  it("flags a world at its birth cap", () => {
    const w = world();
    const id = w.eco.members[0]!.id;
    const r = w.eco.retune({ eco: { maxPopulation: w.eco.population + w.config.eco.birthReserve } });
    expect(r.ok).toBe(true);
    expect(read(w, id).full).toBe(true);
  });

  // The note is true to the engine: with the energy, no wait and room the creature has a child on the next tick; with a wait it does not.
  it("matches the engine's birth rule", () => {
    for (const held of [false, true]) {
      const w = world();
      const m = w.eco.members[0]!;
      m.creature.state.energy = m.birth.energy + m.birth.cost + 50;
      m.lastBirthTick = held ? w.eco.tick : -Infinity;
      const b = read(w, m.id);
      expect(birthNote({ energy: m.creature.state.energy, birthEnergy: m.birth.energy }, b) === "").toBe(!held);
      const before = m.children;
      w.step();
      expect(m.children - before).toBe(held ? 0 : 1);
    }
  });
});

describe("birth wait: page link", () => {
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket | null = null;
    readyState = 1;
    binaryType = "";
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeSocket.last = this;
    }
    close(): void {
      this.readyState = 3;
    }
    send(): void {}
  }
  const hello = JSON.stringify({ t: "hello", version: PROTOCOL_VERSION, world: { width: 2000, height: 1300 }, radius: 10, dt: 1 / 30, fullEnergy: 100, itemSlots: 4 });

  // A BIRTH goes with the DETAIL of its own tick and id; a server from before BIRTH sends none, and the detail carries none.
  it("attaches a BIRTH to the detail of the same tick and id only", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const w = new LiveWorld(smallConfig(), null);
      w.step();
      const id = w.eco.members[0]!.id;
      w.watch(id);
      w.refreshWatched();
      const got: Detail[] = [];
      const link = new LiveLink("ws://x", { onState() {}, onHello() {}, onCreatures() {}, onItems() {}, onDelta() {}, onDetail: (d) => got.push(d), onGenome() {}, onStats() {}, onHistory() {} }, null);
      link.start();
      const ws = FakeSocket.last!;
      ws.onmessage!({ data: hello });
      link.select(id);
      const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;
      const detail = buf(w.detail(id)!);
      ws.onmessage!({ data: buf(w.birthWait(id)!) });
      ws.onmessage!({ data: detail });
      ws.onmessage!({ data: detail }); // the BIRTH was used up
      ws.onmessage!({ data: buf(encodeBirthWait(w.eco.tick + 1, id, 5, false)) }); // another tick
      ws.onmessage!({ data: detail });
      ws.onmessage!({ data: buf(encodeBirthWait(w.eco.tick, id + 1, 5, false)) }); // another creature
      ws.onmessage!({ data: detail });
      expect(got.map((d) => d.birth)).toEqual([{ tick: w.eco.tick, id, waitS: 0, full: false }, undefined, undefined, undefined]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
