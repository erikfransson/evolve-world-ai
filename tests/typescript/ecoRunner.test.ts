import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoOutMessage, EcoSnapshot } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { LINEAGE_STRIDE, LINEAGE_TOP, snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { inputLayout, planUpkeep, rayAngleOffsets } from "../../src/typescript/src/sim/sensors.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { DutyController } from "../../src/typescript/src/worker/pacer.ts";
import { EcoRunner } from "../../src/typescript/src/worker/ecoRunner.ts";

function cfg(over: { creature?: Partial<EcoConfig["creature"]>; eco?: Partial<EcoConfig["eco"]> } = {}): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    world: { ...d.world, width: 600, height: 600 },
    creature: { ...d.creature, ...over.creature },
    eco: { ...d.eco, initialPopulation: 20, foundersVary: false, planDrift: 0, structuralRate: 0, ...over.eco },
  };
}

// A manual clock; step makes every reading advance, so "max" slices end.
function setup(step = 0) {
  const clock = { t: 0 };
  const sent: EcoSnapshot[] = [];
  const post = (msg: EcoOutMessage) => { if (msg.type === "snapshot") sent.push(msg); };
  const runner = new EcoRunner(post, () => (clock.t += step));
  const last = () => sent[sent.length - 1]!;
  return { clock, sent, runner, last };
}

describe("EcoRunner", () => {
  it("posts an initial snapshot with the creatures, items and one history sample", () => {
    const { runner, sent, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 7 });
    expect(sent.length).toBe(1);
    const m = last();
    expect(m.run).toBe(7);
    expect(m.tick).toBe(0);
    expect(m.count).toBe(20);
    expect(m.population).toBe(20);
    expect(m.history).toEqual(Float64Array.of(0, 20, m.food));
    const v = snapshotViews(m.buffer, m.count, m.itemCount, m.creatureCap, m.itemCap);
    expect(new Set(v.ids.subarray(0, 20)).size).toBe(20);
    expect(v.x[0]).toBeGreaterThan(0);
    expect(v.age[0]).toBe(0);
    expect(m.itemCount).toBe(m.food + m.poison);
    expect(v.itemKind[0]).toBeGreaterThan(0);
  });

  it("sends the top lineages about once a second, with the founder of every creature", () => {
    const { runner, clock, sent, last } = setup();
    runner.handle({ type: "start", config: cfg({ eco: { initialPopulation: 20 } }), run: 1 });
    const first = last();
    expect(first.lineages!.length).toBe(LINEAGE_TOP);
    expect(first.lineages!.map((l) => l.count)).toEqual(new Array(LINEAGE_TOP).fill(1));
    expect(first.lineageHistory!.length).toBe(LINEAGE_STRIDE);
    expect(Array.from(first.lineageHistory!.subarray(0, 3))).toEqual([0, 20 - LINEAGE_TOP, 0]);
    const v = snapshotViews(first.buffer, first.count, first.itemCount, first.creatureCap, first.itemCap);
    expect(Array.from(v.founder.subarray(0, 20))).toEqual(Array.from(v.ids.subarray(0, 20)));
    runner.handle({ type: "speed", speed: 4 });
    clock.t = 400;
    runner.pump();
    runner.handle({ type: "select", id: null }); // another snapshot inside the second
    expect(sent.length).toBeGreaterThan(2);
    expect(last().lineages).toBeUndefined();
    clock.t = 1100;
    runner.pump();
    runner.handle({ type: "select", id: null });
    expect(last().lineages!.length).toBeGreaterThan(0);
    expect(last().lineageHistory!.length % LINEAGE_STRIDE).toBe(0);
    expect(last().lineageHistory!.length).toBeGreaterThan(LINEAGE_STRIDE);
  });

  it("reports the selected creature's founder", () => {
    const { runner, last } = setup();
    runner.handle({ type: "start", config: cfg({ eco: { initialPopulation: 20, poolFraction: 0 } }), run: 1 });
    runner.handle({ type: "select", id: 5 });
    expect(last().selected).toMatchObject({ id: 5, founderId: 5, founderPool: false });
  });

  it("paces ticks to real time times speed", () => {
    const { runner, clock, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: 4 });
    clock.t = 200; // 0.2 s real = 0.8 s simulated = 24 ticks
    runner.pump();
    expect(last().tick).toBeGreaterThanOrEqual(23);
    expect(last().tick).toBeLessThanOrEqual(25);
  });

  it("counts a snapshot as handled only when the page acknowledges it, not when a render worker returns the buffer", () => {
    const { runner, sent } = setup(0.5);
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: "max" });
    const pumpFor = (rounds: number): void => { for (let i = 0; i < rounds; i++) runner.pump(); };
    pumpFor(12);
    expect(sent.length).toBe(3); // three in flight, then it waits
    for (const m of sent) runner.handle({ type: "refill", buffer: m.buffer });
    pumpFor(12);
    expect(sent.length).toBe(3); // returned buffers do not count as the page keeping up
    runner.handle({ type: "recycle", run: 1 }); // the page's acknowledgement carries no buffer
    pumpFor(12);
    expect(sent.length).toBe(4);
  });

  it("runs as many ticks as fit in a slice at max speed and posts about 30 snapshots per second", () => {
    const { runner, clock, sent } = setup(0.5);
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: "max" });
    const first = clock.t;
    while (clock.t - first < 200) {
      runner.pump();
      for (const m of sent) runner.handle({ type: "recycle", buffer: m.buffer });
    }
    expect(sent[sent.length - 1]!.tick).toBeGreaterThan(100);
    expect(sent.length).toBeGreaterThan(4);
    expect(sent.length).toBeLessThan(10);
  });

  it("stops while paused and carries on after resume without a burst", () => {
    const { runner, clock, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "pause" });
    clock.t = 5000;
    expect(runner.pump()).toBe(-1);
    expect(last().tick).toBe(0);
    runner.handle({ type: "resume" });
    clock.t = 5100;
    runner.pump();
    expect(last().tick).toBeLessThanOrEqual(4); // 0.1 s of ticks at 1x
  });

  it("stops posting when the page does not return buffers, and posts again after a recycle", () => {
    const { runner, clock, sent } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: 32 });
    for (let i = 1; i <= 8; i++) {
      clock.t = i * 40;
      runner.pump();
    }
    expect(sent.length).toBe(3);
    runner.handle({ type: "recycle", buffer: sent[0]!.buffer });
    clock.t += 40;
    runner.pump();
    expect(sent.length).toBe(4);
    expect(sent[3]!.buffer).toBe(sent[0]!.buffer);
  });

  it("does not count recycled buffers of an earlier run against the new run", () => {
    const { runner, clock, sent } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: 32 });
    for (let i = 1; i <= 8; i++) {
      clock.t = i * 40;
      runner.pump();
    }
    const old = sent.splice(0, sent.length);
    runner.handle({ type: "start", config: cfg(), run: 2 });
    for (const m of old) runner.handle({ type: "recycle", buffer: m.buffer, run: 1 });
    for (let i = 9; i <= 20; i++) {
      clock.t = i * 40;
      runner.pump();
    }
    expect(sent.length).toBe(3); // still limited to three unreturned snapshots of run 2
  });

  it("describes the selected creature, sends its genome on selecting, and reports it dead when it is gone", () => {
    const { runner, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    const v = snapshotViews(last().buffer, 20, 0, last().creatureCap, last().itemCap);
    const id = v.ids[3]!;
    runner.handle({ type: "select", id });
    const a = last().selected!;
    expect(a.alive).toBe(true);
    expect(a.id).toBe(id);
    expect(a.x).toBeCloseTo(v.x[3]!);
    expect(a.rayKinds.length).toBe(8);
    expect(a.rayOffsets.length).toBe(8);
    expect(a.inputs.length).toBe(8 * 6 + 5 + 4); // rays x features, extras, memory (0.25: 2 + 2 units)
    expect(a.genome).not.toBeNull();
    runner.handle({ type: "select", id: 123456 });
    expect(last().selected).toMatchObject({ id: 123456, alive: false });
    runner.handle({ type: "select", id: null });
    expect(last().selected).toBeNull();
  });

  it("shows current rays and inputs for a creature selected while paused, before any tick ran", () => {
    const { runner, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "pause" });
    const v = snapshotViews(last().buffer, 20, 0, last().creatureCap, last().itemCap);
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      runner.handle({ type: "select", id: v.ids[i]! });
      const a = last().selected!;
      const stride = 6;
      for (let k = 0; k < a.rayKinds.length; k++) {
        expect(a.inputs[k * stride]).toBe(Math.fround(a.rayCloseness[k]!));
        if (a.rayKinds[k] !== 0) seen++;
      }
      expect(a.inputs[a.rayKinds.length * stride]).toBeCloseTo(1 - Math.exp(-a.energy / DEFAULT_ECO_CONFIG.creature.startEnergy), 5);
    }
    expect(seen).toBeGreaterThan(5); // walls or items in sight, so the rays were really computed
  });

  it("sends the selected creature's own plan, matching its rays, inputs and genome", () => {
    const { runner, last } = setup();
    runner.handle({ type: "start", config: cfg({ eco: { foundersVary: true } }), run: 1 });
    const shapes = new Set<string>();
    const v = snapshotViews(last().buffer, 20, 0, last().creatureCap, last().itemCap);
    for (let i = 0; i < 20; i++) {
      runner.handle({ type: "select", id: v.ids[i]! });
      const a = last().selected!;
      const layout = inputLayout(DEFAULT_ECO_CONFIG, a.plan);
      expect(a.rayKinds.length).toBe(a.plan.rayCount);
      expect(Array.from(a.rayOffsets)).toEqual(Array.from(rayAngleOffsets(a.plan)));
      expect(a.inputs.length).toBe(layout.size);
      expect(a.genome!.length).toBe(genomeLength(layerSizes(DEFAULT_ECO_CONFIG, a.plan)));
      expect(a.upkeep).toBeCloseTo(planUpkeep(a.plan, DEFAULT_ECO_CONFIG));
      shapes.add(`${a.plan.rayCount}/${layout.size}`);
    }
    expect(shapes.size).toBeGreaterThan(3); // the scratch arrays follow the selected creature's shape
  });

  it("sends the genome only in the first snapshot after selecting", () => {
    const { runner, clock, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "select", id: 0 });
    expect(last().selected!.genome).not.toBeNull();
    clock.t = 100;
    runner.pump();
    expect(last().tick).toBeGreaterThan(0);
    expect(last().selected!.genome).toBeNull();
  });

  it("flags extinction, stops, and a new start begins a new run", () => {
    const { runner, sent, last } = setup(0.5);
    const dying = cfg({ creature: { livingCost: 500 }, eco: { initialPopulation: 5 } });
    runner.handle({ type: "start", config: dying, run: 1 });
    runner.handle({ type: "speed", speed: "max" });
    let guard = 0;
    while (runner.pump() >= 0 && guard++ < 1000) for (const m of sent) runner.handle({ type: "recycle", buffer: m.buffer });
    expect(last().extinct).toBe(true);
    expect(last().population).toBe(0);
    expect(last().deaths).toBe(5);
    runner.handle({ type: "start", config: cfg(), run: 2 });
    expect(last().run).toBe(2);
    expect(last().extinct).toBe(false);
    expect(last().tick).toBe(0);
  });

  it("thins the history by halving the sampling when it is full", () => {
    const { runner, sent, last } = setup(0.5);
    const immortal = cfg({ creature: { livingCost: 0, thrustCost: 0, turnCost: 0, rayCost: 0, neuronCost: 0 }, eco: { initialPopulation: 3, foodRegrow: 0 } });
    runner.handle({ type: "start", config: immortal, run: 1 });
    runner.handle({ type: "speed", speed: "max" });
    let history = last().history!;
    let guard = 0;
    while (last().simTime < 700 && guard++ < 100000) {
      runner.pump();
      for (const m of sent.splice(0, sent.length - 1)) runner.handle({ type: "recycle", buffer: m.buffer });
      history = last().history ?? history;
    }
    const n = history.length / 3;
    expect(n).toBeLessThan(600);
    expect(n).toBeGreaterThan(300);
    expect(history[3]! - history[0]!).toBe(2); // spacing doubled once
    for (let i = 1; i < n; i++) expect(history[3 * i]!).toBeGreaterThan(history[3 * (i - 1)]!);
  });

  it("selectBest picks the highest age, children or eaten, ties to the lowest id, and sends the genome", () => {
    const { runner, last, sent } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    const members = runner.ecosystem!.members;
    const set = (id: number, over: { children?: number; eaten?: number; ticks?: number }) => {
      const m = members.find((c) => c.id === id)!;
      if (over.children !== undefined) m.children = over.children;
      if (over.eaten !== undefined) m.eaten = over.eaten;
      if (over.ticks !== undefined) m.creature.state.ticksAlive = over.ticks;
    };
    for (const m of members) m.creature.state.ticksAlive = 5;
    set(9, { children: 3, eaten: 7, ticks: 50 });
    set(4, { children: 3, eaten: 7, ticks: 50 });
    set(12, { children: 2, eaten: 8, ticks: 40 });
    const before = sent.length;
    runner.handle({ type: "selectBest", by: "age", request: 1 });
    expect(sent.length).toBe(before + 1);
    expect(last().selected).toMatchObject({ id: 4, alive: true });
    expect(last().selected!.genome).not.toBeNull();
    expect(last().bestRequest).toBe(1);
    runner.handle({ type: "selectBest", by: "children", request: 2 });
    expect(last().selected!.id).toBe(4);
    expect(last().selected!.children).toBe(3);
    runner.handle({ type: "selectBest", by: "eaten", request: 3 });
    expect(last().selected).toMatchObject({ id: 12, eaten: 8 });
    expect(last().bestRequest).toBe(3);
  });
});

describe("Gentle on CPU pacing", () => {
  const run = (pressure: "nominal" | "serious") => {
    // The clock is the tick count (1 ms a tick), so reading it does not change where slices end and both runs tick alike.
    const sent: EcoSnapshot[] = [];
    let runner!: EcoRunner;
    runner = new EcoRunner((msg: EcoOutMessage) => { if (msg.type === "snapshot") sent.push(msg); }, () => runner.ecosystem?.tick ?? 0);
    const last = () => sent[sent.length - 1]!;
    if (pressure === "serious") { runner.gentle = new DutyController(); runner.gentle.setPressure("serious"); }
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: "max" });
    const delays: number[] = [];
    for (let i = 0; i < 40; i++) delays.push(runner.pump());
    return { delays, fingerprint: runner.ecosystem!.fingerprint(), tick: runner.ecosystem!.tick, last: last(), sent };
  };

  it("leaves the simulation and the snapshots unchanged and only lengthens the delays", () => {
    const full = run("nominal");
    const gentle = run("serious");
    expect(gentle.tick).toBe(full.tick);
    expect(gentle.fingerprint).toBe(full.fingerprint);
    expect(gentle.sent.length).toBe(full.sent.length);
    expect(Array.from(new Uint8Array(gentle.last.buffer))).toEqual(Array.from(new Uint8Array(full.last.buffer)));
    expect(full.delays.every((d) => d === 0)).toBe(true);
    expect(gentle.delays.some((d) => d > 0)).toBe(true); // idle is owed in slices and slept in larger pieces
  });
});
