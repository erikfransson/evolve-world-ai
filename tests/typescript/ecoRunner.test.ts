import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoOutMessage, EcoSnapshot } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { EcoRunner } from "../../src/typescript/src/worker/ecoRunner.ts";

function cfg(over: { creature?: Partial<EcoConfig["creature"]>; eco?: Partial<EcoConfig["eco"]> } = {}): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    world: { ...d.world, width: 600, height: 600 },
    creature: { ...d.creature, ...over.creature },
    eco: { ...d.eco, initialPopulation: 20, ...over.eco },
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

  it("paces ticks to real time times speed", () => {
    const { runner, clock, last } = setup();
    runner.handle({ type: "start", config: cfg(), run: 1 });
    runner.handle({ type: "speed", speed: 4 });
    clock.t = 200; // 0.2 s real = 0.8 s simulated = 24 ticks
    runner.pump();
    expect(last().tick).toBeGreaterThanOrEqual(23);
    expect(last().tick).toBeLessThanOrEqual(25);
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
    expect(a.inputs.length).toBe(8 * 6 + 4 + 8); // rays x features, extras, memory
    expect(a.genome).not.toBeNull();
    runner.handle({ type: "select", id: 123456 });
    expect(last().selected).toMatchObject({ id: 123456, alive: false });
    runner.handle({ type: "select", id: null });
    expect(last().selected).toBeNull();
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
});
