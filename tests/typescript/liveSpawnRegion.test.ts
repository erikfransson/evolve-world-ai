// @vitest-environment node
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { AddGate } from "../../server/src/adds.ts";
import { LIMITS, LIVE } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import { MAX_SPAWN_REGION, cleanAddRules, encodeAdd, parseAdd } from "../../src/typescript/src/live/add.ts";
import type { AddRequest } from "../../src/typescript/src/live/add.ts";
import { mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import { genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { smallConfig } from "./liveHelpers.ts";

// Adding into a chosen region of the Six Realms (clock) map. The Live map builds in about 8 s, slower under coverage.
const ADD_DEFAULTS = structuredClone(LIVE.add);
afterEach(() => Object.assign(LIVE.add, ADD_DEFAULTS));
const seq = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};
const plan = { rayCount: 3, raySpread: 1.2, rayLength: 120, hiddenLayers: [6], memoryShort: 1, memoryLong: 0 };
const genome = Float32Array.from({ length: genomeLengthFor("forager", plan) }, (_, i) => Math.sin(i) * 0.7);
let names = 0;
const request = (over: Partial<AddRequest> = {}): AddRequest => ({ plan, genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: `Reg${++names}`, hue: 200, copies: 3, ...over });

const regions = mapSpec("clock")!.regions!;
const clockWorld = (map = "clock"): LiveWorld => {
  const c = smallConfig();
  const spec = mapSpec(map);
  c.world.map = map;
  if (spec) {
    c.world.width = spec.width;
    c.world.height = spec.height;
  }
  c.eco.initialPopulation = 0;
  c.eco.foodMaxDensity = 1.0;
  return new LiveWorld(c, null);
};
const inside = (live: LiveWorld, ids: number[], g: { x: number; y: number; r: number }): number[] =>
  ids.map((id) => {
    const s = live.eco.get(id)!.creature.state;
    return Math.hypot(s.x - g.x, s.y - g.y);
  });

describe("adding into a region", { timeout: 90_000 }, () => {
  const live = clockWorld();

  it("advertises the regions it takes in the add rules, and a map without geometry advertises none", () => {
    expect(live.addRules().spawnRegions).toBe(regions.length);
    expect(live.addRules().spawnRegions).toBeLessThanOrEqual(MAX_SPAWN_REGION);
    expect(cleanAddRules(JSON.parse(JSON.stringify(live.addRules())))?.spawnRegions).toBe(regions.length);
    expect(new LiveWorld(smallConfig(), null).addRules()).not.toHaveProperty("spawnRegions");
  });

  it("puts every copy inside 0.6 of the region's radius, for each realm and the Commons", () => {
    regions.forEach((g, i) => {
      const res = live.addCreatures(request({ region: i, copies: 5 }), seq(i + 1));
      if (!("ids" in res)) throw new Error(res.reason);
      expect(res.ids).toHaveLength(5);
      for (const d of inside(live, res.ids, g)) expect(d).toBeLessThanOrEqual(0.6 * g.r);
    });
    expect(regions[regions.length - 1]!.id).toBe("commons");
  });

  it("without a region it spawns anywhere on the map, as before (draws are the same)", () => {
    const a = clockWorld();
    const b = clockWorld();
    const ra = a.addCreatures(request({ name: "Same1", copies: 4 }), seq(9));
    const rb = b.addCreatures({ ...request({ name: "Same1", copies: 4 }), region: undefined }, seq(9));
    if (!("ids" in ra) || !("ids" in rb)) throw new Error("add failed");
    const pos = (w: LiveWorld, ids: number[]) => ids.map((id) => [w.eco.get(id)!.creature.state.x, w.eco.get(id)!.creature.state.y]);
    expect(pos(a, ra.ids)).toEqual(pos(b, rb.ids));
    const far = inside(a, ra.ids, regions[0]!).some((d) => d > 0.6 * regions[0]!.r);
    expect(far).toBe(true); // not confined to the first realm
  });

  it("refuses an index beyond this world's list, inserting nothing", () => {
    const before = live.eco.population;
    for (const region of [regions.length, regions.length + 1, MAX_SPAWN_REGION - 1]) {
      expect(live.addCreatures(request({ region }), seq(3))).toMatchObject({ reason: expect.stringMatching(/no such region/) });
    }
    expect(live.eco.population).toBe(before);
  });

  it("refuses a region on a map without region geometry (inland-sea, the random map), inserting nothing", () => {
    for (const map of ["inland-sea", ""]) {
      const w = clockWorld(map);
      expect(w.addRules()).not.toHaveProperty("spawnRegions");
      expect(w.addCreatures(request({ region: 0 }), seq(3))).toMatchObject({ reason: expect.stringMatching(/no such region/) });
      expect(w.eco.population).toBe(0);
    }
  });

  it("refuses a crowded or blocked region with a message that says so, inserting nothing", () => {
    const w = clockWorld();
    const terrain = (w.eco.world as unknown as { terrain: { touchesRock(x: number, y: number, r: number): boolean } }).terrain;
    const g = regions[2]!;
    const spy = vi.spyOn(terrain, "touchesRock").mockImplementation((x, y) => Math.hypot(x - g.x, y - g.y) < g.r); // rock fills the region
    try {
      const res = w.addCreatures(request({ region: 2 }), seq(4));
      expect(res).toMatchObject({ reason: expect.stringMatching(/region is crowded, try another/) });
      expect(w.eco.population).toBe(0);
      const other = w.addCreatures(request({ region: 3 }), seq(4)); // another region still takes it
      expect(other).toHaveProperty("ids");
    } finally {
      spy.mockRestore();
    }
  });

  it("a flood of adds aimed at one region is stopped by the existing limits", () => {
    LIVE.add.minSpeed = 0;
    const w = clockWorld();
    const gate = new AddGate(() => 0);
    const state = { speed: 3, paused: false };
    let inserted = 0;
    let refused = 0;
    for (let k = 0; k < 60; k++) {
      const req = request({ region: k % 2 === 0 ? 0 : 6, copies: 10 });
      const no = gate.check("one-visitor", req.copies, state);
      if (no) {
        refused++;
        continue;
      }
      const r = w.addCreatures(req, seq(k + 1));
      if ("ids" in r) {
        gate.record("one-visitor", r.ids.length);
        inserted += r.ids.length;
      }
    }
    expect(inserted).toBe(LIVE.add.perVisitor); // 90, the per-visitor cap, however many adds aim at the regions
    expect(refused).toBeGreaterThan(40);
    expect(w.eco.population).toBe(inserted);
    expect(inserted).toBeLessThanOrEqual(LIVE.add.perWindow);
  });
});

describe("a region add on the public server", { timeout: 90_000 }, () => {
  const servers: PublicServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  it("goes in over the wire, an index past the list is refused, and a bad type is refused unread of the rest", async () => {
    LIVE.add.minSpeed = 0;
    const world = clockWorld();
    for (let i = 0; i < 3; i++) world.step();
    const pub = startPublic("127.0.0.1", 61491, world, { ...LIMITS }, new AddGate(), false);
    servers.push(pub);
    await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
    const ws = new WebSocket("ws://127.0.0.1:61491/");
    ws.on("error", () => {});
    const replies: { t: string; ids?: number[]; reason?: string; add?: { spawnRegions?: number } }[] = [];
    const hello = new Promise<{ add: { spawnRegions?: number } }>((r) => ws.on("message", (d: Buffer, bin: boolean) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.t === "hello") r(m);
      if (m.t === "added" || m.t === "refused") replies.push(m);
    }));
    expect((await hello).add.spawnRegions).toBe(regions.length);
    ws.send(encodeAdd(request({ region: 6, copies: 2 })));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]!.t).toBe("added");
    for (const d of inside(world, replies[0]!.ids!, regions[6]!)) expect(d).toBeLessThanOrEqual(0.6 * regions[6]!.r);
    const n = world.eco.population;
    ws.send(encodeAdd(request({ region: regions.length })));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toMatchObject({ t: "refused", reason: expect.stringMatching(/no such region/) });
    ws.send(encodeAdd(request({ region: 1 })).replace('"region":1', '"region":"1"'));
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[2]).toMatchObject({ t: "refused", reason: expect.stringMatching(/region must be/) });
    expect(world.eco.population).toBe(n);
    ws.close();
  });
});

describe("parseAdd and the region", () => {
  const rules = new LiveWorld(smallConfig(), null).addRules();
  const obj = (r = request()): Record<string, unknown> => JSON.parse(encodeAdd(r));
  it("accepts 0 to 15 and absence, refuses everything else and still refuses any other key", () => {
    for (let region = 0; region < MAX_SPAWN_REGION; region++) expect(parseAdd(JSON.stringify({ ...obj(), region }), rules)).toMatchObject({ region });
    expect(parseAdd(JSON.stringify(obj()), rules)).not.toHaveProperty("region");
    for (const region of [-1, 1.5, NaN, null, "1", 1e308, 2 ** 53, [1], { a: 1 }, 16, true, 0.1]) {
      expect(parseAdd(JSON.stringify({ ...obj(), region }), rules), String(region)).toMatch(/^wrong fields$|region must be/);
    }
    expect(parseAdd(JSON.stringify({ ...obj(), region: 1, extra: 1 }), rules)).toBe("wrong fields");
    expect(parseAdd(JSON.stringify({ ...obj(), region: 1, mutationScale: 2 }), rules)).toMatchObject({ region: 1, mutationScale: 2 });
    expect(parseAdd(JSON.stringify({ ...obj(), region: 16 }), rules)).toMatch(/region must be/);
  });
  it("encodes without a region byte-identical to before, and with one as one extra key at the end", () => {
    const r = request({ name: "Bytes1" });
    const plain = encodeAdd(r);
    expect(plain).not.toContain("region");
    expect(encodeAdd({ ...r, region: undefined })).toBe(plain);
    expect(encodeAdd({ ...r, region: 4 })).toBe(plain.slice(0, -1) + ',"region":4}');
  });
});
