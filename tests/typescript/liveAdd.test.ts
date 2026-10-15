// @vitest-environment node
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { AddGate, AddPolicy, addingOn, visitorKey } from "../../server/src/adds.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LIMITS, LIVE } from "../../server/src/config.ts";
import { LiveWorld, groundShares } from "../../server/src/liveWorld.ts";
import { Saves } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { cleanHello } from "../../src/typescript/src/live/connection.ts";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanMap } from "../../src/typescript/src/live/mapInfo.ts";
import { reshapeGenome } from "../../src/typescript/src/live/reshape.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import { applyTunables, readTunables } from "../../server/src/tunables.ts";
import { MAX_ADD_BYTES, MAX_ADD_GENOME, cleanAddReply, cleanAddRules, encodeAdd, parseAdd, upkeepOf } from "../../src/typescript/src/live/add.ts";
import type { AddRequest, AddRules } from "../../src/typescript/src/live/add.ts";
import { genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { planUpkeep } from "../../src/typescript/src/sim/sensors.ts";
import { smallConfig } from "./liveHelpers.ts";

const ADD_DEFAULTS = structuredClone(LIVE.add);
// The server's spot draws, made repeatable.
const seq = (seed: number): (() => number) => {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
};
const MAX_LATE_ROWS = 20_000; // lineage rows a restore accepts (MAX_CREATURES in ecoState.ts)
const FOUNDERS = new URL("../../src/typescript/public/live-founders.json", import.meta.url);
const RESEED_DEFAULT = LIVE.reseed;
afterEach(() => {
  Object.assign(LIVE.add, ADD_DEFAULTS);
  LIVE.reseed = RESEED_DEFAULT;
});

const plan = { rayCount: 3, raySpread: 1.2, rayLength: 120, hiddenLayers: [6], memoryShort: 1, memoryLong: 0 };
const genomeFor = (p: typeof plan): Float32Array => Float32Array.from({ length: genomeLengthFor("forager", p) }, (_, i) => Math.sin(i) * 0.7);
let names = 0; // each request its own name by default: a name a living family carries is refused
const request = (over: Partial<AddRequest> = {}): AddRequest => ({ plan, genome: genomeFor(plan), birth: { energy: 150, cost: 70, cooldown: 10 }, name: `Zed${++names}`, hue: 200, copies: 2, ...over });
const rules = (): AddRules => new LiveWorld(smallConfig(), null).addRules();
// The add message as an object, to break one field at a time.
const asObject = (r = request()): Record<string, unknown> => JSON.parse(encodeAdd(r));
const send = (o: unknown): string => JSON.stringify(o);

describe("add message: encode and parse", () => {
  it("round-trips a request exactly, weights as float32", () => {
    const r = request({ name: "Zed42" });
    const back = parseAdd(encodeAdd(r), rules());
    if (typeof back === "string") throw new Error(back);
    expect(back.plan).toEqual(plan);
    expect(Array.from(back.genome)).toEqual(Array.from(Float32Array.from(r.genome)));
    expect([back.name, back.hue, back.copies, back.birth]).toEqual(["Zed42", 200, 2, { energy: 150, cost: 70, cooldown: 10 }]);
  });

  it("bounds the message by the largest genome PLAN_LIMITS allow, and that one fits", () => {
    const big = { rayCount: 16, raySpread: 6.28, rayLength: 400, hiddenLayers: [32, 32, 32, 32], memoryShort: 8, memoryLong: 8 };
    expect(genomeLengthFor("forager", big)).toBe(MAX_ADD_GENOME);
    const text = encodeAdd(request({ plan: big, genome: genomeFor(big), name: "Abcdefgh12345678" }));
    expect(text.length).toBeLessThanOrEqual(MAX_ADD_BYTES);
    expect(typeof parseAdd(text, rules())).not.toBe("string");
    expect(parseAdd(text + " ".repeat(MAX_ADD_BYTES), rules())).toBe("message too large");
  });

  it("refuses wrong, missing and extra keys at every level, and other key orders", () => {
    const r = rules();
    const o = asObject();
    expect(parseAdd(send({ ...o, extra: 1 }), r)).toBe("wrong fields");
    const { copies: _c, ...missing } = o;
    expect(parseAdd(send(missing), r)).toBe("wrong fields");
    expect(parseAdd(send({ ...o, plan: { ...(o.plan as object), extra: 1 } }), r)).toBe("wrong plan fields");
    expect(parseAdd(send({ ...o, birth: { energy: 150, cost: 70 } }), r)).toBe("wrong birth fields");
    expect(parseAdd(send({ name: o.name, ...o }), r)).toBe("not an add message"); // t must come first
    expect(parseAdd(encodeAdd(request()).replace('"copies":2', '"__proto__":{"x":1},"copies":2'), r)).toBe("wrong fields");
    expect(parseAdd('{"t":"add",', r)).toBe("not JSON");
    expect(parseAdd(send({ ...o, t: "select" }), r)).toBe("not an add message");
  });

  it("refuses NaN and out-of-range weights, a genome of the wrong length or alphabet, and huge arrays", () => {
    const r = rules();
    const n = genomeLengthFor("forager", plan);
    const bad = genomeFor(plan);
    bad[5] = NaN;
    expect(parseAdd(encodeAdd(request({ genome: bad })), r)).toMatch(/finite/);
    bad[5] = 5000;
    expect(parseAdd(encodeAdd(request({ genome: bad })), r)).toMatch(/finite/);
    expect(parseAdd(encodeAdd(request({ genome: new Float32Array(n + 1) })), r)).toMatch(/float32 weights/);
    const o = asObject();
    const g = o.genome as string;
    expect(parseAdd(send({ ...o, genome: "!" + g.slice(1) }), r)).toMatch(/float32 weights/);
    expect(parseAdd(send({ ...o, genome: Array.from(genomeFor(plan)) }), r)).toMatch(/float32 weights/); // a JSON array, not base64
    expect(parseAdd(send({ ...o, plan: { ...plan, hiddenLayers: Array(1e4).fill(4) } }), r)).toMatch(/hiddenLayers/);
    expect(parseAdd(send({ ...o, plan: { ...plan, rayCount: 17 } }), r)).toMatch(/rayCount/);
    expect(parseAdd(send({ ...o, plan: { ...plan, rayLength: 1e9 } }), r)).toMatch(/rayLength/);
    expect(parseAdd(send({ ...o, plan: { ...plan, raySpread: 0 } }), r)).toMatch(/raySpread must be above 0/); // insertCreature needs a spread
  });

  it("refuses bad names: unicode, spaces, 17 characters, control characters, empty, not text", () => {
    const r = rules();
    for (const name of ["Zoë", "Big Bob", "A".repeat(17), "Bob\u0007", "Bob‮", "", "<b>x</b>", 42, null]) {
      expect(parseAdd(send({ ...asObject(), name }), r)).toMatch(/letters or digits/);
    }
    expect(typeof parseAdd(send({ ...asObject(), name: "A".repeat(16) }), r)).toBe("object");
  });

  it("refuses copies, hue and birth traits out of range", () => {
    const r = rules();
    for (const copies of [0, 11, 1.5, "2", 1e9]) expect(parseAdd(send({ ...asObject(), copies }), r)).toMatch(/copies/);
    expect(parseAdd(send({ ...asObject(), copies: 3 }), { ...r, maxCopies: 2 })).toMatch(/copies must be 1 to 2/);
    for (const hue of [-1, 361, "red"]) expect(parseAdd(send({ ...asObject(), hue }), r)).toMatch(/hue/);
    expect(parseAdd(send({ ...asObject(), birth: { energy: r.birth.energy[1] + 1, cost: 70, cooldown: 10 } }), r)).toMatch(/birth/);
    expect(parseAdd(send({ ...asObject(), birth: { energy: 150, cost: 70, cooldown: -1 } }), r)).toMatch(/birth/);
  });

  it("takes an optional mutation scale of 0.25 to 4, refuses anything else, and the added creatures carry it", () => {
    const r = rules();
    for (const mutationScale of [0.25, 1, 2.5, 4]) expect(parseAdd(send({ ...asObject(), mutationScale }), r)).toMatchObject({ mutationScale });
    expect(parseAdd(send(asObject()), r)).not.toHaveProperty("mutationScale"); // a page from before 0.2.1
    for (const mutationScale of [0, 0.2, 4.01, -1, 1e308, "2", null, [2], { v: 2 }]) expect(parseAdd(send({ ...asObject(), mutationScale }), r)).toMatch(/mutationScale/);
    expect(parseAdd(send({ ...asObject(), mutationScale: 2, extra: 1 }), r)).toBe("wrong fields");
    const back = parseAdd(encodeAdd(request({ mutationScale: 0.5 })), r);
    if (typeof back === "string") throw new Error(back);
    const w = new LiveWorld(smallConfig(), null);
    const added = w.addCreatures(back, seq(2));
    if (!("ids" in added)) throw new Error(added.reason);
    for (const id of added.ids) expect(w.eco.get(id)!.mutationScale).toBe(0.5);
  });

  it("cleans replies and rules from the wire", () => {
    expect(cleanAddReply({ t: "added", ids: [3, 4], name: "Zed" })).toEqual({ t: "added", ids: [3, 4], name: "Zed" });
    expect(cleanAddReply({ t: "added", ids: [3], name: "Z d" })).toBeNull();
    expect(cleanAddReply({ t: "added", ids: [...Array(11).keys()], name: "Z" })).toBeNull(); // past MAX_COPIES (10)
    expect(cleanAddReply({ t: "added", ids: [...Array(10).keys()], name: "Z" })).toMatchObject({ t: "added" });
    expect(cleanAddReply({ t: "refused", reason: "busy‮<b>", retryS: 12.2 })).toEqual({ t: "refused", reason: "busy<b>", retryS: 13 });
    expect(cleanAddReply({ t: "refused", reason: 5, retryS: NaN })).toEqual({ t: "refused", reason: "refused" });
    expect(cleanAddRules(rules())).toEqual(rules());
    expect(cleanAddRules({ ...rules(), maxCopies: 11 })).toBeNull();
  });

  it("defaults a hello's missing or bad summary, so the info section cannot throw", () => {
    const h = new LiveWorld(smallConfig(), null).hello(5);
    expect(cleanHello({ ...h, summary: undefined as never })!.summary).toEqual({ initialPopulation: 0, maxPopulation: 0, collisionDamage: false, seasons: false });
    expect(cleanHello({ ...h, summary: { initialPopulation: "x", maxPopulation: -5, collisionDamage: 1, seasons: true } as never })!.summary).toEqual({ initialPopulation: 0, maxPopulation: 0, collisionDamage: false, seasons: true });
  });

  it("names in the stats lineages pass the name filter, as in the details", () => {
    const config = smallConfig();
    config.eco.initialPopulation = 2;
    const w = new LiveWorld(config, null);
    const r = w.addCreatures(request({ copies: 1, name: "Good1" }), seq(4));
    if (!("ids" in r)) throw new Error(r.reason);
    const t = w.eco.lineageTable.toState();
    w.eco.lineageTable.load({ ...t, late: t.late.map((row) => [...row.slice(0, 5), "bad name"] as (typeof t.late)[0]) }); // from an older or hand-edited save
    const named = w.stats(0).lineages!.find((l) => l.founder === r.ids[0]);
    expect(named).toBeDefined();
    expect(named!.name).toBeUndefined();
  });

  it("computes energy per second like the engine", () => {
    const c = smallConfig();
    expect(upkeepOf(plan, rules().costs)).toBeCloseTo(planUpkeep(plan, c), 10);
  });
});

describe("add caps (adds.ts)", () => {
  const fresh = { aliveAdded: 0, population: 1000, speed: 4, paused: false };
  const clock = (): { now: () => number; t: number } => {
    const c = { t: 1_000_000, now: () => c.t };
    return c;
  };

  it("global window: 20 creatures per 5 minutes for everyone, then a wait until the oldest leaves the window", () => {
    const c = clock();
    const gate = new AddGate(c.now);
    for (let i = 0; i < 6; i++) {
      expect(gate.check(`v${i}`, 3, fresh)).toBeNull();
      gate.record(`v${i}`, 3);
      c.t += 1000;
    }
    expect(gate.check("v9", 2, fresh)).toBeNull(); // 18 + 2 = 20
    gate.record("v9", 2);
    const no = gate.check("v10", 1, fresh);
    expect(no?.reason).toMatch(/busy with new creatures/);
    expect(no?.retryS).toBe(300 - 7 + 1); // the first add, 7 s ago, leaves the window then
    c.t += (300 - 6) * 1000; // past the first add's window
    expect(gate.check("v10", 3, fresh)).toBeNull();
  });

  it("the window runs on the monotonic clock: a wall clock step forward does not open it early", () => {
    const wall = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(wall); // before the gate, so a gate on the wall clock would read this one
    try {
      const gate = new AddGate();
      LIVE.add.perWindow = 3;
      gate.record(null, 3);
      clock.mockReturnValue(wall + 86_400_000);
      expect(gate.check(null, 1, fresh)?.reason).toMatch(/busy with new creatures/);
    } finally {
      clock.mockRestore();
    }
  });

  it("an alive floor with no share still lets visitors add, capped at the floor (whichever is more)", () => {
    LIVE.add.aliveShare = 0;
    LIVE.add.aliveFloor = 50;
    expect(addingOn()).toBe(true);
    expect(new LiveWorld(smallConfig(), null).currentAddRules()).not.toBeNull();
    expect(new AddGate(clock().now).check(null, 1, { ...fresh, aliveAdded: 49 })).toBeNull();
    expect(new AddGate(clock().now).check(null, 2, { ...fresh, aliveAdded: 49 })?.reason).toMatch(/enough added creatures/);
    LIVE.add.aliveFloor = 0;
    expect(addingOn()).toBe(false);
  });

  it("a world just started or resumed is not taken for a busy one: the set speed until a full second is measured", async () => {
    const w = new LiveWorld(smallConfig(), null);
    expect(w.speed).toBe(0);
    expect(w.speedForAdds()).toBe(LIVE.speed);
    w.paused = true;
    await w.advance();
    w.paused = false;
    expect(w.speedForAdds()).toBe(LIVE.speed);
  });

  it("the policy: a connection's burst, then refusals with the wait, then a cut; the global read rate; adding off", () => {
    const policy = new AddPolicy({ addAttemptsPerSecond: 1, addAttemptBurst: 2 });
    const pace = policy.connection();
    expect([policy.pace(pace), policy.pace(pace)]).toEqual([null, null]);
    const r = policy.pace(pace);
    expect(r).toMatchObject({ t: "refused", reason: "adding too fast on this connection" });
    expect((r as { retryS: number }).retryS).toBeGreaterThan(LIVE.add.socketEveryS - 1);
    expect([policy.pace(pace), policy.pace(pace)].every((x) => x !== "cut")).toBe(true);
    expect(policy.pace(pace)).toBe("cut");
    expect([policy.admit(), policy.admit()]).toEqual([null, null]);
    expect(policy.admit()).toMatchObject({ reason: expect.stringMatching(/busy/) });
    LIVE.add.perWindow = 0;
    expect(new AddPolicy({ addAttemptsPerSecond: 1, addAttemptBurst: 2 }).admit()).toMatchObject({ reason: "adding is off right now" });
  });

  it("copies past a cap get a reason that says so, not that adding is off", () => {
    const gate = new AddGate(clock().now);
    LIVE.add.perVisitor = 2;
    LIVE.add.maxCopies = 3;
    expect(gate.check("v", 3, fresh)?.reason).toBe("at most 2 creatures per visitor per 5 minutes, ask for fewer copies");
    LIVE.add.perWindow = 0; // turned off while an add waited for its tick
    expect(gate.check(null, 1, fresh)?.reason).toBe("adding is off right now");
  });

  it("per visitor: 3 creatures per window per address, other addresses unaffected, unknown address not limited per visitor", () => {
    LIVE.add.perVisitor = 3; // the mechanism, at a cap smaller than the default 10
    const c = clock();
    const gate = new AddGate(c.now);
    gate.record("1.2.3.4", 3);
    expect(gate.check("1.2.3.4", 1, fresh)?.reason).toMatch(/a moment ago/);
    expect(gate.check("5.6.7.8", 3, fresh)).toBeNull();
    expect(gate.check(null, 3, fresh)).toBeNull();
    c.t += 301_000;
    expect(gate.check("1.2.3.4", 3, fresh)).toBeNull();
  });

  it("alive share: added creatures alive stay at most 10% of the population", () => {
    const gate = new AddGate();
    expect(gate.check(null, 3, { ...fresh, aliveAdded: 97 })).toBeNull();
    expect(gate.check(null, 3, { ...fresh, aliveAdded: 98 })?.reason).toMatch(/enough added creatures/);
    LIVE.add.aliveFloor = 0;
    expect(gate.check(null, 1, { ...fresh, population: 9 })?.reason).toMatch(/enough added creatures/); // floor(0.9) = 0
  });

  it("alive floor: an empty or small world takes up to 20 added creatures alive, past the 10% share", () => {
    const gate = new AddGate();
    const empty = { ...fresh, population: 0 };
    expect(gate.check(null, 3, empty)).toBeNull();
    expect(gate.check(null, 3, { ...empty, aliveAdded: 17 })).toBeNull();
    expect(gate.check(null, 1, { ...empty, aliveAdded: 20 })?.reason).toMatch(/enough added creatures/);
    expect(gate.check(null, 3, { ...fresh, population: 1000, aliveAdded: 97 })).toBeNull(); // 10% of 1000 is past the floor
  });

  it("copies past the admin's max, a busy world and a paused world are refused", () => {
    const gate = new AddGate();
    LIVE.add.maxCopies = 2;
    expect(gate.check(null, 3, fresh)?.reason).toMatch(/at most 2 copies/);
    expect(gate.check(null, 1, { ...fresh, speed: 0.2 })?.reason).toMatch(/busy, try again in 30 s/);
    expect(gate.check(null, 1, { ...fresh, paused: true })?.reason).toMatch(/paused/);
  });

  it("an extinct world stays empty unless reseed is on, and adds populate it again", () => {
    const config = smallConfig();
    config.eco.initialPopulation = 0;
    const w = new LiveWorld(config, null);
    let reseeds = 0;
    w.onReseed = () => reseeds++;
    for (let i = 0; i < 5; i++) w.step();
    expect([w.eco.extinct, reseeds]).toEqual([true, 0]);
    const r = w.addCreatures(request({ copies: 3 }), seq(3));
    if (!("ids" in r)) throw new Error(r.reason);
    expect(w.eco.population).toBe(3);
    const v = new LiveWorld(config, null);
    v.onReseed = () => reseeds++;
    LIVE.reseed = 1;
    for (let i = 0; i < 5; i++) v.step();
    expect([v.eco.extinct, reseeds]).toEqual([true, 1]); // no founders: one reseed, not one per tick
    const f = new LiveWorld(config, null);
    f.founders = loadFounders(FOUNDERS.pathname);
    f.onReseed = () => reseeds++;
    for (let i = 0; i < 5; i++) f.step();
    expect(reseeds).toBe(2); // once, with the founders seeded
    expect(f.eco.population).toBeGreaterThan(0);
    expect(applyTunables(v.eco, { reseed: 0 })).toBeNull();
    expect(applyTunables(v.eco, { reseed: 0.5 })).toMatch(/whole/);
    expect(applyTunables(v.eco, { "add.aliveFloor": 5000 })).toMatch(/add.aliveFloor/);
  });

  it("an extinct world does not step, still runs queued work, and its graph gets a 0 sample at once", async () => {
    const config = smallConfig();
    config.eco.initialPopulation = 2;
    const w = new LiveWorld(config, null);
    expect(w.stats(0).sample?.[1]).toBe(2);
    for (let i = 0; i < 100 && !w.eco.extinct; i++) {
      for (const m of w.eco.members) m.creature.state.energy = 0.001; // they starve within a few ticks
      w.step();
    }
    expect(w.eco.extinct).toBe(true);
    const tick = w.eco.tick;
    expect(w.stats(0).sample?.[1]).toBe(0); // well before the next 20 s sample is due
    expect(w.stats(0).sample).toBeUndefined(); // once
    let ran = false;
    const done = w.whenIdle(() => (ran = true));
    await w.tick();
    await done;
    expect([ran, w.eco.tick, w.failedTicks]).toEqual([true, tick, 0]);
  });

  it("the caps are admin settings with limits", () => {
    const eco = new LiveWorld(smallConfig(), null).eco;
    expect(applyTunables(eco, { "add.perWindow": 5, "add.aliveShare": 0.2 })).toBeNull();
    expect([LIVE.add.perWindow, LIVE.add.aliveShare]).toEqual([5, 0.2]);
    expect(readTunables(eco)["add.perWindow"]).toBe(5);
    expect(applyTunables(eco, { "add.maxCopies": 11 })).toMatch(/add.maxCopies/);
    expect(applyTunables(eco, { "add.perWindow": 2.5 })).toMatch(/whole/);
    expect(applyTunables(eco, { "add.socketEveryS": 0 })).toMatch(/add.socketEveryS/);
    expect(applyTunables(eco, { "add.startEnergy": 5000 })).toMatch(/add.startEnergy/);
    expect(applyTunables(eco, { "add.birthHoldS": -1 })).toMatch(/add.birthHoldS/);
    expect(LIVE.add.maxCopies).toBe(10);
    // A birth reserve at or past the cap would stop every birth: refused, alone or with a lower cap, and nothing changes.
    const cap = 500;
    expect(applyTunables(eco, { "eco.maxPopulation": cap })).toBeNull();
    expect(applyTunables(eco, { "eco.birthReserve": cap })).toMatch(/birthReserve must be below/);
    expect(applyTunables(eco, { "eco.maxPopulation": 50, "eco.birthReserve": 50 })).toMatch(/birthReserve must be below/);
    expect(applyTunables(eco, { "eco.birthReserve": cap - 1 })).toBeNull();
    expect(applyTunables(eco, { "eco.maxPopulation": cap - 1 })).toMatch(/birthReserve must be below/);
    expect([eco.config.eco.maxPopulation, eco.config.eco.birthReserve]).toEqual([cap, cap - 1]);
  });

  it("keys visitors on the tunnel's address only when trusted; IPv6 on its /64", () => {
    expect(visitorKey("203.0.113.9", true)).toBe("203.0.113.9");
    expect(visitorKey("203.0.113.9", false)).toBeNull();
    // Trusted but missing or malformed: one shared key, held to the per-visitor cap like any visitor.
    expect(visitorKey(undefined, true)).toBe("unknown");
    expect(visitorKey("1.2.3.4, 5.6.7.8", true)).toBe("unknown"); // Funnel sets one address; a list is not from it
    expect(visitorKey(["1.2.3.4"], true)).toBe("unknown");
    expect(visitorKey("x".repeat(100), true)).toBe("unknown");
    expect(visitorKey("2001:db8:1:2:aaaa::1", true)).toBe("2001:db8:1:2::/64");
    expect(visitorKey("2001:db8:1:2:ffff:1:2:3", true)).toBe("2001:db8:1:2::/64");
    expect(visitorKey("2001:db8::1", true)).toBe("2001:db8:0:0::/64");
  });
});

describe("adding to the world (LiveWorld)", () => {

  it("is deterministic: the same add at the same tick gives the same world", () => {
    const a = new LiveWorld(smallConfig(), null);
    const b = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) [a, b].forEach((w) => w.step());
    const ra = a.addCreatures(request({ copies: 3, name: "Same" }), seq(5));
    const rb = b.addCreatures(request({ copies: 3, name: "Same" }), seq(5));
    expect(ra).toEqual(rb);
    for (let i = 0; i < 200; i++) [a, b].forEach((w) => w.step());
    expect(JSON.stringify(a.saveState())).toBe(JSON.stringify(b.saveState()));
  });

  it("names the lineages, counts the added alive, and a save keeps both", () => {
    const config = smallConfig();
    config.eco.initialPopulation = 3; // so the three named lineages are among the top 8 the stats list
    const a = new LiveWorld(config, null);
    a.step(); // the server runs its first tick before it reads any message; founders born at tick 0 are the seeded ones
    const r = a.addCreatures(request({ copies: 3, name: "Kiwi" }), seq(1));
    if (!("ids" in r)) throw new Error(r.reason);
    expect(r.ids).toHaveLength(3);
    for (const id of r.ids) {
      const m = a.eco.get(id)!;
      expect([m.founderId, a.eco.lineageName(id), Math.round(m.hue)]).toEqual([id, "Kiwi", 200]);
      expect(m.birth).toEqual({ energy: 150, cost: 70, cooldown: 10 });
    }
    expect(a.aliveAdded()).toBe(3);
    const kiwi = a.stats(0).lineages!.filter((l) => l.name === "Kiwi"); // the three copies' families as one row
    expect(kiwi).toHaveLength(1);
    expect([kiwi[0]!.count, kiwi[0]!.founders]).toEqual([3, r.ids.slice(1)]);
    const b = new LiveWorld(config, null);
    b.restoreState(JSON.parse(JSON.stringify(a.saveState())));
    expect(b.aliveAdded()).toBe(3);
    expect(b.eco.lineageName(r.ids[0]!)).toBe("Kiwi");
  });

  it("starts added creatures with the admin's energy, holds their first birth, and their children start without the hold", () => {
    const w = new LiveWorld(smallConfig(), null);
    LIVE.add.startEnergy = 400;
    LIVE.add.birthHoldS = 3;
    const r = w.addCreatures(request({ copies: 1, birth: { energy: 100, cost: 50, cooldown: 5 } }), seq(3));
    if (!("ids" in r)) throw new Error(r.reason);
    const id = r.ids[0]!;
    expect(w.eco.get(id)!.creature.state.energy).toBe(400);
    const dt = w.eco.config.dt;
    for (let t = 0; t < 2.5 / dt; t++) w.step(); // energy far above the birth level, but held
    expect(w.eco.get(id)?.children ?? 0).toBe(0);
    for (let t = 0; t < 1 / dt; t++) w.step();
    const m = w.eco.get(id)!;
    expect(m.children).toBeGreaterThan(0);
    const child = w.eco.members.find((c) => c.parentId === id)!;
    expect(child.lastBirthTick).toBe(-Infinity);
  });

  it("never writes a save that would not restore: too many lineage rows, or a row the restore refuses", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const w = new LiveWorld(smallConfig(), null);
      const r = w.addCreatures(request({ copies: 1 }), seq(1));
      if (!("ids" in r)) throw new Error(r.reason);
      const table = w.eco.lineageTable;
      const good = table.toState();
      const dir = mkdtempSync(join(tmpdir(), "evolve-add-saves-"));
      const saves = new Saves(w, new StateStore(dir));
      // As if the rows had piled up: distinct founders, each with a living member, so the table keeps them.
      table.load({ ...good, late: Array.from({ length: MAX_LATE_ROWS + 1 }, (_, k) => [good.founders + k, 1, 0, 0, 0, "Pile"] as (typeof good.late)[0]) });
      await expect(saves.save()).rejects.toThrow(/not saved.*would not restore/);
      table.load({ ...good, late: [[...good.late[0]!.slice(0, 5), "x".repeat(40)] as (typeof good.late)[0]] }); // a name restore refuses
      await expect(saves.save()).rejects.toThrow(/not saved.*would not restore/);
      expect(err).toHaveBeenCalledWith("SAVE REFUSED: it would not restore, the last good save is kept");
      expect(readdirSync(dir)).toEqual([]);
      table.load(good);
      await expect(saves.save()).resolves.toMatch(/^saved/);
    } finally {
      err.mockRestore();
    }
  });

  it("an added family that died out leaves no row, no name and no added count, before and after a save", () => {
    LIVE.add.startEnergy = 10; // dies within seconds, and the birth hold keeps it childless
    const w = new LiveWorld(smallConfig(), null);
    const r = w.addCreatures(request({ copies: 1, name: "Brief" }), seq(5));
    if (!("ids" in r)) throw new Error(r.reason);
    const id = r.ids[0]!;
    for (let t = 0; t < 30 / w.eco.config.dt && w.eco.get(id); t++) w.step();
    expect(w.eco.get(id)).toBeUndefined();
    expect([w.aliveAdded(), w.eco.lineageName(id), w.eco.lineageTable.toState().late.length]).toEqual([0, "", 0]);
    const b = new LiveWorld(smallConfig(), null);
    b.restoreState(JSON.parse(JSON.stringify(w.saveState())));
    expect([b.aliveAdded(), b.eco.lineageName(id), b.eco.lineageTable.toState().late.length]).toEqual([0, "", 0]);
  });

  it("refuses a name a living family or a starter carries (any case), and frees it when that family dies out", () => {
    const w = new LiveWorld(smallConfig(), null);
    w.founders = [{ name: "Juggernaut", plan, genome: genomeFor(plan) }];
    LIVE.add.startEnergy = 10; // the Kiwi dies within seconds
    const first = w.addCreatures(request({ copies: 1, name: "Kiwi" }), seq(1));
    if (!("ids" in first)) throw new Error(first.reason);
    expect(w.addCreatures(request({ copies: 1, name: "KIWI" }), seq(2))).toEqual({ reason: "the name KIWI is taken by a family alive now, pick another", now: false });
    expect(w.addCreatures(request({ copies: 1, name: "juggernaut" }), seq(3))).toMatchObject({ now: false });
    expect("ids" in w.addCreatures(request({ copies: 1, name: "Lime" }), seq(4))).toBe(true);
    for (let t = 0; t < 30 / w.eco.config.dt && w.eco.get(first.ids[0]!); t++) w.step();
    expect(w.eco.get(first.ids[0]!)).toBeUndefined();
    expect("ids" in w.addCreatures(request({ copies: 1, name: "Kiwi" }), seq(5))).toBe(true);
  });

  it("a full add of 10 copies goes in on a fresh small world, two fit the global window, an 11th copy never does (#42)", () => {
    const gate = new AddGate(() => 0);
    const world = { aliveAdded: 0, population: 40, speed: 3, paused: false }; // a fresh world: the alive floor (20) applies
    expect(gate.check(null, 10, world)).toBeNull();
    gate.record(null, 10);
    expect(gate.check(null, 10, { ...world, aliveAdded: 10 })).toBeNull();
    gate.record(null, 10);
    expect(gate.check(null, 1, { ...world, aliveAdded: 20 })?.reason).toMatch(/enough added creatures|busy with new creatures/);
    expect(gate.check("v", 10, world)?.reason).toMatch(/busy with new creatures/); // the window is spent
    expect(new AddGate(() => 0).check("v", 11, world)?.reason).toMatch(/at most 10 copies/);
    const w = new LiveWorld(smallConfig(), null);
    const r = w.addCreatures(request({ copies: 10 }), seq(7));
    if (!("ids" in r)) throw new Error(r.reason);
    expect(r.ids).toHaveLength(10);
    expect(parseAdd(encodeAdd(request({ copies: 10 })), w.addRules())).toMatchObject({ copies: 10 });
    expect(parseAdd(encodeAdd(request({ copies: 11 })), w.addRules())).toMatch(/copies must be 1 to 10/);
  });

  it("refuses when the world is full, inserting nothing", () => {
    const w = new LiveWorld(smallConfig(), null);
    w.eco.config.eco.maxPopulation = w.eco.population + 2;
    expect(w.addCreatures(request({ copies: 3 }))).toEqual({ reason: "the world is full, try again later" });
    expect(w.aliveAdded()).toBe(0);
  });
});

// The public server with adds, on ports 61xxx.
const servers: PublicServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function serve(port: number, change: Partial<typeof LIMITS> = {}, trust = false): Promise<LiveWorld> {
  LIVE.add.minSpeed = 0; // the test world does not run its clock
  LIVE.add.aliveShare = 1;
  const world = new LiveWorld(smallConfig(), null);
  for (let i = 0; i < 10; i++) world.step();
  const pub = startPublic("127.0.0.1", port, world, { ...LIMITS, ...change }, new AddGate(), trust);
  servers.push(pub);
  await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
  return world;
}
interface Client {
  ws: WebSocket;
  replies: { t: string; ids?: number[]; reason?: string; add?: unknown }[];
  hello: Promise<{ add: unknown }>;
  closed: Promise<number>;
}
function client(port: number, headers: Record<string, string> = {}): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
  const c: Client = { ws, replies: [], hello: null!, closed: null! };
  c.hello = new Promise((r) => ws.on("message", (d: Buffer, bin: boolean) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.t === "hello") r(m);
    if (m.t === "added" || m.t === "refused") c.replies.push(m);
  }));
  c.closed = new Promise((r) => ws.on("close", (code: number) => r(code)));
  ws.on("error", () => {});
  return c;
}

describe("add on the public server", () => {
  it("adds end to end: the hello carries the rules, the reply the ids, the world the named creatures", async () => {
    const world = await serve(61401);
    const c = client(61401);
    const hello = await c.hello;
    expect(cleanAddRules(hello.add)).toEqual(world.addRules());
    c.ws.send(encodeAdd(request({ copies: 2, name: "Probe1" })));
    await vi.waitFor(() => expect(c.replies).toHaveLength(1));
    const r = c.replies[0]!;
    expect(r.t).toBe("added");
    expect(r.ids).toHaveLength(2);
    for (const id of r.ids!) expect(world.eco.lineageName(id)).toBe("Probe1");
    c.ws.close();
  });

  it("refuses a malformed add with a reason and keeps the connection", async () => {
    await serve(61402);
    const c = client(61402);
    await c.hello;
    c.ws.send(send({ ...asObject(), name: "bad name" }));
    await vi.waitFor(() => expect(c.replies).toHaveLength(1));
    expect(c.replies[0]).toMatchObject({ t: "refused", reason: expect.stringMatching(/letters or digits/) });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("per connection: past the burst an add is refused unread with the wait (a page with stale rules), and a flood past the strikes is cut off", async () => {
    await serve(61403);
    const c = client(61403);
    await c.hello;
    for (let i = 1; i <= 3; i++) {
      c.ws.send(encodeAdd(request({ copies: 1 })));
      await vi.waitFor(() => expect(c.replies).toHaveLength(i));
    }
    expect(c.replies.filter((r) => r.t === "added"), JSON.stringify(c.replies)).toHaveLength(2);
    expect(c.replies.find((r) => r.t === "refused")).toMatchObject({ reason: "adding too fast on this connection", retryS: expect.any(Number) });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    for (let i = 0; i < 3; i++) c.ws.send(encodeAdd(request({ copies: 1 }))); // two more strikes, then the fourth past the rate
    expect(await c.closed).toBe(1006);
    expect(c.replies.filter((r) => r.reason === "adding too fast on this connection")).toHaveLength(3);
  });

  it("a wall clock step back does not turn the next add into a strike (the add limits run on the monotonic clock)", async () => {
    await serve(61411);
    const c = client(61411);
    await c.hello;
    c.ws.send(encodeAdd(request({ copies: 1 })));
    await vi.waitFor(() => expect(c.replies).toHaveLength(1));
    const wall = Date.now();
    const back = vi.spyOn(Date, "now").mockReturnValue(wall - 3_600_000); // NTP or an admin set the clock an hour back
    try {
      c.ws.send(encodeAdd(request({ copies: 1 })));
      await vi.waitFor(() => expect(c.replies).toHaveLength(2));
    } finally {
      back.mockRestore();
    }
    expect(c.replies.map((r) => r.t)).toEqual(["added", "added"]);
    c.ws.close();
  });

  it("an add before the hello cuts the connection off (the page waits for its hello)", async () => {
    LIVE.add.minSpeed = 0;
    const world = new LiveWorld(smallConfig(), null);
    const idle = world.whenIdle.bind(world);
    let held = true; // the connection's hello job waits, as it does behind a tick on helper threads
    world.whenIdle = <T>(fn: () => T): Promise<T> => (held ? new Promise<T>((r) => setTimeout(() => r(idle(fn)), 1500)) : idle(fn));
    const pub = startPublic("127.0.0.1", 61408, world, LIMITS, new AddGate(), false);
    servers.push(pub);
    await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
    const c = client(61408);
    await new Promise((r) => c.ws.on("open", r));
    c.ws.send(encodeAdd(request({ copies: 1 })));
    expect(await c.closed).toBe(1006);
    held = false;
  });

  it("sends the add rules again when an admin changes them, and the server applies the new socket rate at once", async () => {
    await serve(61409);
    const c = client(61409);
    const rules: { add: { maxCopies: number } | null }[] = [];
    c.ws.on("message", (d: Buffer, bin: boolean) => {
      if (!bin && JSON.parse(d.toString()).t === "rules") rules.push(JSON.parse(d.toString()));
    });
    await c.hello;
    LIVE.add.maxCopies = 2;
    await vi.waitFor(() => expect(rules.at(-1)?.add?.maxCopies).toBe(2), { timeout: 4000 });
    LIVE.add.perWindow = 0;
    await vi.waitFor(() => expect(rules.at(-1)?.add).toBeNull(), { timeout: 4000 });
    c.ws.close();
  });

  it("trusted header missing: all such adds share one visitor cap", async () => {
    await serve(61410, {}, true);
    LIVE.add.perVisitor = 3; // the mechanism, at a cap smaller than the default 10
    const a = client(61410);
    const b = client(61410);
    await Promise.all([a.hello, b.hello]);
    a.ws.send(encodeAdd(request({ copies: 3 })));
    await vi.waitFor(() => expect(a.replies).toHaveLength(1));
    expect(a.replies[0]!.t).toBe("added");
    b.ws.send(encodeAdd(request({ copies: 1 })));
    await vi.waitFor(() => expect(b.replies).toHaveLength(1));
    expect(b.replies[0]).toMatchObject({ t: "refused", reason: expect.stringMatching(/a moment ago/) });
    a.ws.close();
    b.ws.close();
  });

  it("an add message past MAX_ADD_BYTES closes the connection (ws payload cap)", async () => {
    await serve(61404);
    const c = client(61404);
    await c.hello;
    c.ws.send('{"t":"add",' + " ".repeat(MAX_ADD_BYTES));
    expect(await c.closed).toBe(1009);
  });

  it("the global window holds across connections", async () => {
    await serve(61405);
    LIVE.add.perWindow = 4;
    const a = client(61405);
    const b = client(61405);
    await Promise.all([a.hello, b.hello]);
    a.ws.send(encodeAdd(request({ copies: 3 })));
    await vi.waitFor(() => expect(a.replies).toHaveLength(1));
    b.ws.send(encodeAdd(request({ copies: 2 })));
    await vi.waitFor(() => expect(b.replies).toHaveLength(1));
    expect(a.replies[0]!.t).toBe("added");
    expect(b.replies[0]).toMatchObject({ t: "refused", reason: expect.stringMatching(/busy with new creatures/) });
    a.ws.close();
    b.ws.close();
  });

  it("per visitor via X-Forwarded-For when trusted: a second connection from the same address is held to the visitor cap", async () => {
    await serve(61406, {}, true);
    LIVE.add.perVisitor = 3;
    const a = client(61406, { "x-forwarded-for": "198.51.100.7" });
    const b = client(61406, { "x-forwarded-for": "198.51.100.7" });
    const other = client(61406, { "x-forwarded-for": "198.51.100.8" });
    await Promise.all([a.hello, b.hello, other.hello]);
    a.ws.send(encodeAdd(request({ copies: 3 })));
    await vi.waitFor(() => expect(a.replies).toHaveLength(1));
    b.ws.send(encodeAdd(request({ copies: 1 })));
    other.ws.send(encodeAdd(request({ copies: 1 })));
    await vi.waitFor(() => expect(b.replies.length + other.replies.length).toBe(2));
    expect(b.replies[0]).toMatchObject({ t: "refused", reason: expect.stringMatching(/a moment ago/) });
    expect(other.replies[0]!.t).toBe("added");
    for (const c of [a, b, other]) c.ws.close();
  });

  it("an add flood from many connections is refused unread past the global attempt rate", async () => {
    await serve(61407, { addAttemptsPerSecond: 1, addAttemptBurst: 2, acceptBurst: 100 });
    const cs = Array.from({ length: 5 }, () => client(61407));
    await Promise.all(cs.map((c) => c.hello));
    for (const c of cs) c.ws.send(send({ ...asObject(), name: "bad name" })); // refused either way; the reason says whether it was read
    await vi.waitFor(() => expect(cs.reduce((s, c) => s + c.replies.length, 0)).toBe(5));
    const reasons = cs.map((c) => c.replies[0]!.reason);
    expect(reasons.filter((r) => /letters or digits/.test(r!))).toHaveLength(2);
    expect(reasons.filter((r) => /busy, try again in 5 s/.test(r!))).toHaveLength(3);
    for (const c of cs) c.ws.close();
  });
});

describe("tuning and the map info", () => {
  it("reshapes a genome to a tuned plan: the same plan keeps every weight, a new plan gets its length", () => {
    const g = genomeFor(plan);
    expect(Array.from(reshapeGenome(plan, g, plan))).toEqual(Array.from(g));
    const to = { ...plan, rayCount: 5, hiddenLayers: [9], memoryShort: 0, memoryLong: 2 };
    const out = reshapeGenome(plan, g, to);
    expect(out.length).toBe(genomeLengthFor("forager", to));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(() => reshapeGenome(plan, g, { ...plan, hiddenLayers: [6, 6] })).toThrow(/layers/);
  });

  it("sends the ground shares of the world in the hello; a plain world is all normal ground", () => {
    const w = new LiveWorld(smallConfig(), null);
    expect(w.hello(10).map).toEqual({ ground: { normal: 1, mud: 0, firm: 0, rock: 0 }, regions: [] });
    const c = smallConfig();
    Object.assign(c.world, { stoneDensity: 0.05, slowDensity: 0.1, fastDensity: 0.1 });
    const g = groundShares(new LiveWorld(c, null).eco);
    expect(g.rock).toBeGreaterThan(0);
    expect(g.mud).toBeGreaterThan(0);
    expect(g.normal + g.mud + g.firm + g.rock).toBeCloseTo(1, 2);
  });

  it("cleans the map from the wire: shares clamped, regions bounded and plain text", () => {
    expect(cleanMap(null).ground.normal).toBe(1);
    const m = cleanMap({ ground: { normal: 2, mud: -1, firm: NaN, rock: 0.2 }, regions: [...Array(40)].map((_, i) => ({ name: `R${i}‮<b>`, food: 1e9, poison: 0, ground: "mud", role: "x" })) });
    expect(m.ground).toEqual({ normal: 1, mud: 0, firm: 0, rock: 0.2 });
    expect(m.regions).toHaveLength(16);
    expect(m.regions[0]).toEqual({ name: "R0<b>", food: 100, poison: 0, ground: "mud", role: "x" });
  });
});
