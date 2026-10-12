// @vitest-environment node
import { LIMITS, LIVE, liveConfig } from "../../server/src/config.ts";
import { TokenBucket } from "../../server/src/budget.ts";
import { ItemFeed } from "../../server/src/itemFeed.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { Chronicle } from "../../server/src/chronicle.ts";
import { ItemMirror } from "../../src/typescript/src/live/items.ts";
import { LiveScene } from "../../src/typescript/src/live/scene.ts";
import { MAX_DETAIL_BYTES, MAX_GENOME, MAX_INPUTS, RAY_FEATURES, decodeDetail, decodeGenome, encodeDetail, encodeGenome, genomeBytes } from "../../src/typescript/src/live/detail.ts";
import type { DetailSource } from "../../src/typescript/src/live/detail.ts";
import { NAME_MAX } from "../../src/typescript/src/live/add.ts";
import {
  HISTORY_FIELDS, LINEAGE_FIELDS, MAX_DELTAS, MAX_DELTA_OPS, MAX_HISTORY, MAX_ID, MAX_LINEAGE_HISTORY, MSG_DELTA, decodeCreatures, decodeDelta, decodeItems, deltaMessage, encodeDeltaChunk, parseClientMessage,
} from "../../src/typescript/src/live/protocol.ts";
import type { ItemOp, Stats } from "../../src/typescript/src/live/protocol.ts";
import { cleanStats } from "../../src/typescript/src/live/connection.ts";
import { EXTRA_INPUTS, inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";
import { smallConfig } from "./liveHelpers.ts";

// These small worlds die out within the test; they check the viewer across a restart, so the world starts over as with reseed on.
const RESEED = LIVE.reseed;
beforeAll(() => void (LIVE.reseed = 1));
afterAll(() => void (LIVE.reseed = RESEED));

const world = { width: 2000, height: 1300 };
const QX = world.width / 65535;
const QY = world.height / 65535;

// The item set a world has now, as the wire would carry it (food 1, poison 2).
function itemsOf(live: LiveWorld): Map<number, [number, number, number]> {
  const w = live.eco.world;
  const out = new Map<number, [number, number, number]>();
  for (let i = 0; i < w.count; i++) if (w.kinds[i]) out.set(i, [w.kinds[i]!, w.xs[i]!, w.ys[i]!]);
  return out;
}

function expectSame(mirror: ItemMirror, live: LiveWorld): void {
  const want = itemsOf(live);
  expect(mirror.count).toBe(want.size);
  const w = live.eco.world;
  for (let s = 0; s < w.count; s++) {
    const item = want.get(s);
    expect(mirror.kindAt(s)).toBe(item?.[0] ?? 0);
    if (!item) continue;
    const i = mirror.indexOf(s);
    expect(Math.abs(mirror.x[i]! - item[1])).toBeLessThanOrEqual(QX);
    expect(Math.abs(mirror.y[i]! - item[2])).toBeLessThanOrEqual(QY);
  }
}

describe("client messages", () => {
  it("accepts ping and a well-formed select only", () => {
    expect(parseClientMessage("ping")).toEqual({ t: "ping" });
    expect(parseClientMessage('{"t":"select","id":12}')).toEqual({ t: "select", id: 12 });
    expect(parseClientMessage('{"id":null,"t":"select"}')).toEqual({ t: "select", id: null });
    expect(parseClientMessage(`{"t":"select","id":${MAX_ID}}`)).toEqual({ t: "select", id: MAX_ID });
    const bad = [
      "", "pong", "PING", "null", "[]", "{}", '"select"', "{", '{"t":"select"}', '{"t":"select","id":1,"x":2}', '{"t":"pick","id":1}',
      '{"t":"select","id":"1"}', '{"t":"select","id":1.5}', '{"t":"select","id":-1}', `{"t":"select","id":${MAX_ID + 1}}`, '{"t":"select","id":1e300}',
      '{"t":"select","id":true}', '{"t":"select","id":[1]}', '{"t":"select","id":{}}', '{"__proto__":{"t":"select"},"id":1}', '{"t":"select","id":NaN}',
      `{"t":"select","id":1${" ".repeat(300)}}`,
    ];
    for (const b of bad) expect(parseClientMessage(b), b).toBeNull();
  });
});

describe("item deltas", () => {
  it("round-trips a chunk and rejects out-of-range fields", () => {
    const ops: ItemOp[] = [
      { slot: 5, kind: 0, x: 0, y: 0, tick: 98 },
      { slot: 200_000, kind: 1, x: 1999, y: 3, tick: 99 },
      { slot: 7, kind: 2, x: 10, y: 1290, tick: 100 },
    ];
    const chunk = encodeDeltaChunk(100, ops, [{ kind: 1, x: 5, y: 6, value: 270 }, { kind: 0, x: 1, y: 2, value: 33 }], world)!;
    const [d] = decodeDelta(deltaMessage([chunk]), world);
    expect(d!.tick).toBe(100);
    expect(d!.ops.map((o) => [o.slot, o.kind, o.tick])).toEqual([[5, 0, 98], [200_000, 1, 99], [7, 2, 100]]);
    expect(d!.ops[1]!.x).toBeCloseTo(1999, 0);
    expect(d!.events[0]).toMatchObject({ kind: 1 });
    expect(d!.events[0]!.value).toBeCloseTo(270, 1);
    expect(d!.events[1]!.value).toBe(33);
    expect(() => decodeDelta(deltaMessage([chunk]), world, 1000)).toThrow(); // slot past the hello's item slots
    expect(() => decodeDelta(deltaMessage([chunk]).slice(0, -1), world)).toThrow();
    expect(encodeDeltaChunk(100, [{ slot: 1, kind: 0, x: 0, y: 0, tick: 101 }], [], world)).toBeNull(); // from the future
    expect(encodeDeltaChunk(5000, [{ slot: 1, kind: 0, x: 0, y: 0, tick: 1 }], [], world)).toBeNull(); // too far back
    expect(encodeDeltaChunk(1, [{ slot: 1 << 18, kind: 0, x: 0, y: 0, tick: 1 }], [], world)).toBeNull();
  });

  it("bounds the size of a delta: ops per frame, frames per message, and never more than the full set", () => {
    const many = Array.from({ length: MAX_DELTA_OPS + 1 }, (_, i): ItemOp => ({ slot: i, kind: 0, x: 0, y: 0, tick: 1 }));
    expect(encodeDeltaChunk(1, many, [], world)).toBeNull();
    expect(encodeDeltaChunk(1, many.slice(1), [], world)!.length).toBe(7 + 4 * MAX_DELTA_OPS);
    expect(() => deltaMessage(Array.from({ length: MAX_DELTAS + 1 }, () => new Uint8Array(7)))).toThrow();
    const forged = new Uint8Array([MSG_DELTA, 1, 1, 0, 0, 0, 0xff, 0xff, 0]); // claims 65535 ops
    expect(() => decodeDelta(forged, world)).toThrow(/too big/);
    const feed = new ItemFeed();
    const chunk = encodeDeltaChunk(1, many.slice(0, 100), [], world)!;
    for (let f = 0; f < 3; f++) feed.push(f, chunk);
    expect(feed.delta(0, 2, () => 1e9)!.length).toBe(2 + 2 * chunk.length);
    expect(feed.delta(0, 2, () => chunk.length)).toBeNull(); // larger than the full set: send that
    expect(feed.delta(-1, 2, () => 1e9)).toBeNull(); // nothing yet
    feed.push(3, null);
    expect(feed.delta(2, 3, () => 1e9)).toBeNull(); // a frame that changed too much
    for (let f = 4; f < 4 + MAX_DELTAS + 2; f++) feed.push(f, chunk);
    expect(feed.delta(4, 4 + MAX_DELTAS + 1, () => 1e9)).toBeNull(); // further behind than the ring
    expect(feed.delta(6, 4 + MAX_DELTAS + 1, () => 1e9)).not.toBeNull();
  });

  // Runs a small world frame by frame like the server and feeds viewers with different strides through the real messages.
  for (const stride of [1, 3, 7]) {
    it(`deltas and full sets reproduce the server's items exactly, stride ${stride}, with dropped and late frames`, () => {
      const live = new LiveWorld(smallConfig(), null);
      live.creatureFrame();
      live.takeDelta();
      const feed = new ItemFeed();
      const scene = new LiveScene();
      scene.dt = live.config.dt;
      let last = -1;
      let fulls = 0;
      let now = 0;
      let rng = 7;
      const random = (): number => ((rng = (rng * 16807) % 2147483647) / 2147483647);
      let reseeds = 0;
      live.onReseed = () => {
        // As the server does: a new world needs the full set again (public.ts onReseed).
        reseeds++;
        feed.clear();
        scene.reset();
        last = -1;
      };
      for (let frame = 0; frame < 160; frame++) {
        for (let t = 0; t < 6; t++) live.step();
        const creatures = live.creatureFrame();
        feed.push(frame, live.takeDelta());
        if (frame % stride !== 0) continue;
        if (frame > 20 && frame < 60 && random() < 0.5) continue; // the send queue was full: dropped
        if (frame >= 80 && frame < 80 + MAX_DELTAS + 3) continue; // a long stall: past the ring, so a resync
        const delta = feed.delta(last, frame, () => live.itemsFrame().length);
        if (delta) scene.addDeltas(decodeDelta(delta, world, live.eco.world.count));
        else {
          scene.setItems(decodeItems(live.itemsFrame(), world, live.eco.world.count));
          fulls++;
        }
        const f = decodeCreatures(creatures, world);
        now += 200 + (random() < 0.3 ? 400 * random() : 0); // late frames
        scene.push(f, now);
        last = frame;
        scene.sample(now + 5000); // the timeline reaches the frame's tick
        expectSame(scene.items, live);
      }
      expect(fulls).toBe(2 + reseeds); // the first frame, the resync after the stall, and one per new world
    }, 90_000); // deterministic, but about 5 s of simulation and checks at stride 1 that a loaded machine stretches past the default
  }

  // Across seeds, so it does not hang on one random stream. A frame in which the world died out and started over is skipped.
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`on the page's timeline, food disappears in the frame where its eater reaches it, seed ${seed}`, () => {
      const c = smallConfig();
      c.seed = seed;
      const live = new LiveWorld(c, null);
      let reseeded = false;
      live.onReseed = () => (reseeded = true);
      const R = live.config.creature.radius + live.config.world.itemRadius;
      const TICKS = 24; // per frame at 4x: 30 ticks a simulated second, 5 frames a real second
      live.creatureFrame();
      live.takeDelta();
      let checked = 0;
      for (let frame = 0; frame < 300 && checked < 10; frame++) {
        reseeded = false;
        const before = decodeCreatures(live.creatureFrame(), world);
        live.takeDelta();
        const items = itemsOf(live);
        // Step tick by tick, noting who ate at which tick and where everyone truly was.
        const truth = new Map<number, Map<number, [number, number]>>(); // tick -> id -> position
        const eatersAt = new Map<number, number[]>(); // tick -> ids that ate food
        for (let t = 0; t < TICKS; t++) {
          const eaten = new Map(live.eco.members.map((m) => [m.id, m.eaten]));
          live.step();
          truth.set(live.eco.tick, new Map(live.eco.members.map((m) => [m.id, [m.creature.state.x, m.creature.state.y]])));
          eatersAt.set(live.eco.tick, live.eco.members.filter((m) => m.eaten > (eaten.get(m.id) ?? Infinity)).map((m) => m.id));
        }
        const after = decodeCreatures(live.creatureFrame(), world);
        const chunk = live.takeDelta();
        if (reseeded || !chunk) continue;
        const deltas = decodeDelta(deltaMessage([chunk]), world, live.eco.world.count);
        const touched = new Set<number>();
        for (const op of deltas[0]!.ops) {
          // Only a slot's first change in the frame removes the item it held at the frame's start (a slot can be eaten, refilled and eaten again).
          if (touched.has(op.slot)) continue;
          touched.add(op.slot);
          const eaters = eatersAt.get(op.tick) ?? [];
          const item = items.get(op.slot);
          if (op.kind !== 0 || item?.[0] !== 1 || eaters.length !== 1) continue; // one food eaten by one creature at that tick
          const id = eaters[0]!;
          if (before.ids.indexOf(id) < 0 || after.ids.indexOf(id) < 0) continue;
          const scene = new LiveScene();
          scene.dt = live.config.dt;
          const slots = live.eco.world.count;
          scene.setItems({ tick: before.tick, slots, kinds: Uint8Array.from({ length: slots }, (_, i) => items.get(i)?.[0] ?? 0), x: Float32Array.from({ length: slots }, (_, i) => items.get(i)?.[1] ?? 0), y: Float32Array.from({ length: slots }, (_, i) => items.get(i)?.[2] ?? 0) });
          scene.push(before, 0);
          scene.addDeltas(deltas);
          scene.push(after, 2400); // span 2400 ms, 100 ms a tick
          let goneAt = -1;
          for (let ms = 2400; ms <= 4800; ms += 5) {
            scene.sample(ms);
            // Gone: the slot is empty, or holds a new item elsewhere (eaten and refilled in the same tick).
            const at = scene.items.kindAt(op.slot) === 1 ? scene.items.indexOf(op.slot) : -1;
            if (at < 0 || Math.hypot(scene.items.x[at]! - item[1], scene.items.y[at]! - item[2]) > 2 * QX) {
              goneAt = ms;
              break;
            }
          }
          // It goes when the timeline reaches the tick it was eaten at, not before and not at the frame's end.
          expect(scene.displayTick).toBeGreaterThanOrEqual(op.tick);
          expect(scene.displayTick).toBeLessThan(op.tick + 5 / 100);
          // And there the eater, as drawn, touches it, up to how far its straight path between frames strays from its true one.
          const v = scene.views;
          const i = scene.slotOf(id);
          const [tx, ty] = truth.get(op.tick)!.get(id)!;
          const stray = Math.hypot(v.x[i]! - tx, v.y[i]! - ty);
          expect(Math.hypot(v.x[i]! - item[1], v.y[i]! - item[2])).toBeLessThanOrEqual(R + stray + 2 * QX);
          expect(goneAt).toBeGreaterThan(2400);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(3);
    });
  }
});

describe("timeline", () => {
  const frame = (tick: number, ids: number[], xs: number[], ages = ids.map(() => 100)) => ({
    tick, count: ids.length, ids: Uint32Array.from(ids), x: Float32Array.from(xs), y: new Float32Array(ids.length), heading: new Float32Array(ids.length),
    radius: new Float32Array(ids.length).fill(12), energyShare: new Float32Array(ids.length).fill(0.5), age: Float32Array.from(ages), hue: new Float32Array(ids.length), founder: new Int32Array(ids.length),
  });

  it("shows a death when the timeline reaches the frame and a birth at its birth tick, not when the frame arrives", () => {
    const s = new LiveScene();
    s.dt = 0.1; // 10 ticks a second
    s.push(frame(100, [1, 2], [0, 50]), 0);
    s.push(frame(120, [1, 3], [10, 60], [100, 1]), 1000); // 2 died, 3 was born 1 s (10 ticks) before tick 120; the span is 1000 ms
    expect(s.slotOf(2)).toBeGreaterThanOrEqual(0); // still drawn where it was
    expect(s.slotOf(3)).toBe(-1);
    s.sample(1000 + 0.6 * 1000); // tick 112: past 3's birth (110), before 2's death shows (120)
    expect(s.displayTick).toBeCloseTo(112, 5);
    expect(s.slotOf(3)).toBeGreaterThanOrEqual(0);
    expect(s.slotOf(2)).toBeGreaterThanOrEqual(0);
    s.sample(2000);
    expect(s.slotOf(2)).toBe(-1);
  });

  it("applies details and events at their tick", () => {
    const s = new LiveScene();
    const got: string[] = [];
    s.handlers = { onEvents: () => got.push("event"), onDetail: (d) => got.push(`detail ${d.tick}`) };
    s.push(frame(10, [1], [0]), 0);
    s.addDetail(decodeDetail(encodeDetail(20, 1, null)));
    s.addDeltas([{ tick: 20, ops: [], events: [{ kind: 1, x: 1, y: 1, value: 10 }] }]);
    s.push(frame(20, [1], [10]), 200);
    s.sample(250);
    expect(got).toEqual([]);
    s.sample(1000);
    expect(got).toEqual(["detail 20", "event"]);
  });
  it("does not replay item changes already in a newer connect catch-up set (no blink after connect)", () => {
    const s = new LiveScene();
    s.dt = 1 / 30;
    const kinds = new Uint8Array(4);
    kinds[0] = 1; // slot 0 holds food in the set of "now" (tick 110)
    s.setItems({ tick: 110, slots: 4, kinds, x: new Float32Array([50, 0, 0, 0]), y: new Float32Array([60, 0, 0, 0]) });
    s.push(frame(100, [1], [5]), 0); // the last creature frame is older than the set
    // The next delta repeats ticks 101..120: slot 0 was eaten at 103 and regrew at 108, both already in the set.
    s.addDeltas([{ tick: 120, events: [], ops: [{ slot: 0, kind: 0, x: 0, y: 0, tick: 103 }, { slot: 0, kind: 1, x: 50, y: 60, tick: 108 }] }]);
    s.push(frame(120, [1], [10]), 200);
    for (const t of [210, 240, 270, 300, 330, 360, 400]) {
      s.sample(t);
      expect(s.items.count).toBe(1);
    }
  });
});

describe("selected creature on the wire", () => {
  const source = (rays: number, inputs: number): DetailSource => ({
    x: 10, y: 20, heading: 1, energy: 123.4, age: 99.5, children: 3, eaten: 17, depth: 4, parentId: 77, founderId: 9, founderPool: true, founderName: "", founderHue: 120, hue: 200, upkeep: 2.5, drain: 3.5,
    birthEnergy: 150, birthCost: 60, birthCooldown: 10, plan: { rayCount: rays, raySpread: 2, rayLength: 250, hiddenLayers: [32, 32, 32, 32], memoryShort: 8, memoryLong: 8 },
    rayKinds: Uint8Array.from({ length: rays }, (_, i) => i % 5), rayCloseness: Float32Array.from({ length: rays }, (_, i) => i / rays), rayOffsets: Float32Array.from({ length: rays }, (_, i) => -1 + i / rays), inputs: Float32Array.from({ length: inputs }, (_, i) => Math.sin(i)),
  });

  it("round-trips the largest detail within its bound and decodes into SelectedDetails", () => {
    const bytes = encodeDetail(55, 1234, { ...source(16, 16 * RAY_FEATURES + EXTRA_INPUTS + 16), founderName: "Abcdefgh12345678" });
    expect(bytes.length).toBe(MAX_DETAIL_BYTES);
    const { tick, id, details: d } = decodeDetail(bytes);
    expect([tick, id, d.alive, d.children, d.depth, d.parentId, d.founderId, d.founderPool]).toEqual([55, 1234, true, 3, 4, 77, 9, true]);
    expect(decodeDetail(bytes).founderName).toBe("Abcdefgh12345678");
    expect(d.energy).toBeCloseTo(123.4, 3);
    expect(d.birthCooldown).toBe(10);
    expect(d.plan.hiddenLayers).toEqual([32, 32, 32, 32]);
    expect(d.rayKinds[3]).toBe(3);
    expect(d.rayOffsets[0]).toBeCloseTo(-1, 3);
    expect(d.inputs[5]).toBeCloseTo(Math.sin(5), 3);
    expect(d.genome).toBeNull();
  });

  // The codec's input count must follow the engine's input layout, or a real creature's detail fails to decode.
  it("follows the engine's input layout: the largest plan fits the bounds, and a real creature of that plan round-trips", () => {
    const L = PLAN_LIMITS;
    const c = smallConfig();
    c.creature.rayCount = L.rayCount[1];
    c.brain.hiddenLayers = Array<number>(L.layers[1]).fill(L.neurons[1]);
    c.brain.memory = 1; // memoryShort and memoryLong at their limit
    c.eco.foundersVary = false; // every founder gets this plan
    const live = new LiveWorld(c, null);
    const m = live.eco.members[0]!;
    const plan = m.creature.plan;
    expect([plan.rayCount, plan.hiddenLayers.length, plan.memoryShort, plan.memoryLong]).toEqual([L.rayCount[1], L.layers[1], L.memory[1], L.memory[1]]);
    expect(inputLayout(live.eco.config, plan).size).toBe(MAX_INPUTS);
    expect(genomeLength(layerSizes(live.eco.config, plan))).toBe(MAX_GENOME);
    live.watch(m.id);
    live.step();
    live.refreshWatched();
    const bytes = live.detail(m.id)!;
    expect(bytes.length).toBe(MAX_DETAIL_BYTES - NAME_MAX); // a pool founder has no name
    const d = decodeDetail(bytes).details;
    const engineInputs = m.creature.brain.layerActivations()[0]!;
    expect(d.inputs.length).toBe(engineInputs.length);
    for (let i = 0; i < engineInputs.length; i++) expect(d.inputs[i]).toBeCloseTo(Math.max(-8, Math.min(8, engineInputs[i]!)), 3);
    expect(decodeGenome(live.genome(m.id)!).genome.length).toBe(m.creature.brain.genome.length);
  });

  it("rejects malformed details: bad counts, truncation, oversize, NaN", () => {
    const good = encodeDetail(1, 1, source(4, 4 * RAY_FEATURES + EXTRA_INPUTS + 16));
    expect(() => decodeDetail(good.slice(0, -1))).toThrow();
    expect(() => decodeDetail(new Uint8Array(MAX_DETAIL_BYTES + 1).fill(3))).toThrow();
    expect(() => decodeDetail(encodeDetail(1, 1, source(4, 5)))).toThrow(/inputs/); // input count does not fit the plan
    const nan = good.slice();
    new DataView(nan.buffer).setFloat32(10, NaN, true);
    expect(() => decodeDetail(nan)).toThrow();
    const plan = good.slice();
    plan[76] = 17; // rayCount past the plan limit
    expect(() => decodeDetail(plan)).toThrow(/plan/);
    const dead = decodeDetail(encodeDetail(5, 9, null));
    expect(dead.details.alive).toBe(false);
    expect(dead.id).toBe(9);
  });

  it("round-trips a genome to 1/32767 of its largest weight and bounds its size", () => {
    const g = Float32Array.from({ length: 500 }, (_, i) => Math.cos(i) * 3);
    const back = decodeGenome(encodeGenome(4, g));
    expect(back.id).toBe(4);
    for (let i = 0; i < g.length; i++) expect(Math.abs(back.genome[i]! - g[i]!)).toBeLessThanOrEqual(3 / 32767 + 1e-6);
    expect(genomeBytes(MAX_GENOME)).toBeLessThanOrEqual(LIMITS.detailBurstBytes - MAX_DETAIL_BYTES);
    const forged = encodeGenome(1, new Float32Array(3));
    new DataView(forged.buffer).setUint32(5, MAX_GENOME + 1, true);
    expect(() => decodeGenome(forged)).toThrow();
  });

  it("the server describes a watched creature and says once when it has died", () => {
    const live = new LiveWorld(smallConfig(), null);
    const m = live.eco.members[0]!;
    live.watch(m.id);
    live.step();
    live.refreshWatched();
    const d = decodeDetail(live.detail(m.id)!).details;
    expect(d.alive).toBe(true);
    expect(d.energy).toBeCloseTo(m.creature.state.energy, 2);
    expect(d.rayKinds.length).toBe(m.creature.plan.rayCount);
    const g = decodeGenome(live.genome(m.id)!);
    expect(g.genome.length).toBe(m.creature.brain.genome.length);
    expect(decodeDetail(live.detail(999_999)!).details.alive).toBe(false);
    live.unwatch(m.id);
    expect(live.watchedCount).toBe(0);
  });
});

describe("history and records", () => {
  it("keeps the population and lineage history bounded however long the world runs", () => {
    const live = new LiveWorld(smallConfig(), null);
    const ch = new Chronicle();
    const stats = (): Stats => cleanStats({ t: "stats" } as Stats);
    for (let i = 0; i < MAX_HISTORY + 200; i++) {
      live.eco.tick += Math.round(20 / live.config.dt); // 20 simulated seconds on
      ch.observe(live.eco, stats(), false);
    }
    const h = JSON.parse(ch.history());
    expect(h.samples.length).toBe(MAX_HISTORY * HISTORY_FIELDS);
    expect(h.lineage.length).toBe(MAX_LINEAGE_HISTORY * LINEAGE_FIELDS);
    expect(h.samples.at(-HISTORY_FIELDS)).toBe(Math.round(live.eco.tick * live.config.dt)); // the newest kept, the oldest dropped
    expect(ch.history().length).toBeLessThan(80_000);
  });

  // Across seeds, so it does not hang on one random stream. A world that dies out starts over with fresh records, so the dead counted restart too.
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`finds the oldest and most-children creatures and keeps the top records, dead ones included, seed ${seed}`, () => {
      const c = smallConfig();
      c.seed = seed;
      const live = new LiveWorld(c, null);
      let s: Stats | null = null;
      const deadAges: number[] = [];
      const countDeaths = (): void => {
        deadAges.length = 0;
        live.eco.onDeath = ((prev) => (m) => { deadAges.push(m.ageTicks * live.config.dt); prev?.(m); })(live.eco.onDeath);
      };
      countDeaths();
      live.onReseed = countDeaths;
      for (let t = 0; t < 2000; t++) {
        live.step();
        if (t % 30 === 0) s = live.stats(1, true);
      }
      s = live.stats(1, true);
      const members = live.eco.members;
      const oldest = members.reduce((a, b) => (b.ageTicks > a.ageTicks || (b.ageTicks === a.ageTicks && b.id < a.id) ? b : a));
      const parent = members.reduce((a, b) => (b.children > a.children || (b.children === a.children && b.id < a.id) ? b : a));
      expect(s.best).toEqual({ age: oldest.id, children: parent.id });
      const age = s.records!.find((r) => r.board === "age")!.entries;
      expect(age.length).toBe(3);
      expect(age[0]!.value).toBeGreaterThanOrEqual(Math.round(Math.max(oldest.ageTicks * live.config.dt, ...deadAges)) - 1);
      expect(age.map((e) => e.value)).toEqual([...age.map((e) => e.value)].sort((a, b) => b - a));
      const kids = s.records!.find((r) => r.board === "children")?.entries ?? [];
      expect(kids[0]?.value ?? 0).toBeGreaterThanOrEqual(parent.children);
      expect(s.lineages!.length).toBeLessThanOrEqual(8);
      expect(s.season).toEqual({ yearMinutes: liveConfig.eco.yearMinutes, winterFood: liveConfig.eco.winterFood });
    });
  }
});

describe("selection cost", () => {
  // 100 viewers each following a different creature: the server's per-frame work for them (refreshing their rays and brain inputs,
  // encoding 100 details a frame and each genome once) stays under 10% of the time the ticks take. Timed inside one run, interleaved
  // with the ticks, so other load on the machine affects both alike.
  it("100 viewers following different creatures add less than 10% to the tick time", () => {
    const c = smallConfig();
    c.world.width = 6000;
    c.world.height = 4000;
    c.eco.initialPopulation = 400;
    c.eco.wasm = true;
    const live = new LiveWorld(c, null);
    for (let t = 0; t < 60; t++) live.step();
    // Warm up the selection code on other creatures, so its one-off compile time does not count as per-frame cost.
    const warm = live.eco.members.slice(100, 200).map((m) => m.id);
    for (const id of warm) live.watch(id);
    live.refreshWatched();
    for (const id of warm) {
      live.detail(id);
      live.genome(id);
      live.unwatch(id);
    }
    const ids = live.eco.members.slice(0, 100).map((m) => m.id);
    for (const id of ids) live.watch(id);
    // The refresh allowance runs on the server's real clock, which ticks LIVE.speed simulated seconds a second. Run it on the
    // simulated clock at that pace, so a slow machine does not hand out more refreshes per tick than the server would.
    let ticks = 0;
    expect(Reflect.has(live, "refreshes")).toBe(true); // the bucket replaced below must be the one the server reads
    (live as unknown as { refreshes: TokenBucket }).refreshes = new TokenBucket(LIMITS.detailRefreshesPerSecond, LIMITS.detailRefreshesPerSecond, () => (ticks * live.config.dt) / LIVE.speed);
    // CPU time of this process, not wall time, so time the scheduler gives other processes counts for neither side.
    const cpuMs = (): number => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const sent = new Set<number>();
    let ticking = 0;
    let selecting = 0;
    // A fixed number of ticks, not a fixed time: the same world each run (it thins out from about 600 ticks on and later starts over).
    for (let frame = 0; frame < 20; frame++) {
      let t0 = cpuMs();
      for (let t = 0; t < 24; t++, ticks++) live.step(); // a frame every 24 ticks, as at 4x
      ticking += cpuMs() - t0;
      live.creatureFrame();
      live.takeDelta();
      t0 = cpuMs();
      live.refreshWatched();
      for (const id of ids) {
        live.detail(id);
        if (!sent.has(id)) {
          sent.add(id);
          live.genome(id);
        }
      }
      selecting += cpuMs() - t0;
    }
    const share = selecting / ticking;
    console.log(`${ticks} ticks at ${(ticking / ticks).toFixed(3)} ms, following 100 adds ${(selecting / ticks).toFixed(4)} ms a tick, ${(100 * share).toFixed(2)}%, population ${live.eco.population}`);
    expect(live.eco.population).toBeGreaterThan(100);
    expect(share).toBeLessThan(0.1);
  });
});

describe("helper threads", () => {
  it("run the live world the same as one thread, through a restore, and keep outside work between ticks", async () => {
    const { createNodeThinkPool } = await import("../../src/typescript/src/worker/nodePool.ts");
    const prints: number[][] = [];
    for (const threads of [0, 2]) {
      const live = new LiveWorld(smallConfig(), null, threads ? createNodeThinkPool(threads) : null);
      for (let t = 0; t < 100; t++) await live.tick();
      const saved = JSON.parse(JSON.stringify(await live.whenIdle(() => live.saveState())));
      for (let t = 0; t < 100; t++) await live.tick();
      const a = live.eco.fingerprint();
      await live.whenIdle(() => live.restoreState(saved));
      await live.tick(); // the helpers take up the restored world
      // A frame asked for while a tick waits for the helpers runs after that tick, never inside it.
      const ticking = live.tick();
      const seen = live.whenIdle(() => live.eco.tick);
      await ticking;
      expect(await seen).toBe(live.eco.tick);
      for (let t = 0; t < 98; t++) await live.tick();
      prints.push([a, live.eco.fingerprint(), live.threads]);
      live.close();
    }
    expect(prints[1]![0]).toBe(prints[0]![0]);
    expect(prints[1]![1]).toBe(prints[0]![1]);
    expect(prints[1]![2]).toBe(2);
  });

  it("leave an extinct world still, as one thread does, when reseed is off", async () => {
    const { createNodeThinkPool } = await import("../../src/typescript/src/worker/nodePool.ts");
    LIVE.reseed = 0;
    const config = smallConfig();
    config.eco.initialPopulation = 0;
    const live = new LiveWorld(config, null, createNodeThinkPool(1));
    try {
      const tick = live.eco.tick;
      for (let t = 0; t < 5; t++) await live.tick();
      expect([live.eco.tick, live.threads, live.failedTicks]).toEqual([tick, 1, 0]);
    } finally {
      LIVE.reseed = 1;
      live.close();
    }
  });
});
