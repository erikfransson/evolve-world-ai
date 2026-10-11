// @vitest-environment happy-dom
import { Leaderboard } from "../../src/typescript/src/sim/leaderboard.ts";
import type { LeaderEntry } from "../../src/typescript/src/sim/leaderboard.ts";
import { TRAITS, traitStats } from "../../src/typescript/src/sim/popStats.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { planOf, planUpkeep } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import type { EcoOutMessage, EcoSnapshot } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { EcoRunner } from "../../src/typescript/src/worker/ecoRunner.ts";
import { creatureSvg, fanScale, lifeSpan, LeaderPanel } from "../../src/typescript/src/ui/leaderPanel.ts";
import { TraitPanel, traitText } from "../../src/typescript/src/ui/traitPanel.ts";
import { TRIALS_SECTIONS } from "../../src/typescript/src/ui/trialsForm.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";

const BIRTH = { energy: 150, cost: 75, cooldown: 10 };
const births = (plans: readonly unknown[]) => plans.map(() => BIRTH);
const plan = (over: Partial<BodyPlan> = {}): BodyPlan => ({ rayCount: 5, raySpread: Math.PI / 2, rayLength: 100, hiddenLayers: [8], memoryShort: 1, memoryLong: 1, ...over });

describe("traitStats", () => {
  it("counts integer traits per value and gives mean, min and max", () => {
    const three = [plan({ rayCount: 3 }), plan({ rayCount: 3 }), plan({ rayCount: 6 })];
    const h = traitStats(three, births(three))!;
    expect(h.length).toBe(TRAITS.length);
    expect(h[0]).toEqual({ min: 3, max: 6, mean: 4, bins: [2, 0, 0, 1] });
  });

  it("bins wide ranges into equal parts, with the maximum in the last bin, and reports angle in degrees", () => {
    const plans = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((rayLength) => plan({ rayLength, raySpread: Math.PI }));
    const h = traitStats(plans, births(plans))!;
    expect(h[1]!.bins.reduce((a, b) => a + b, 0)).toBe(10);
    expect(h[1]!.bins.length).toBe(8);
    expect(h[1]!.bins[7]).toBeGreaterThan(0);
    expect(h[2]).toEqual({ min: 180, max: 180, mean: 180, bins: [10] });
  });

  it("sums hidden layers into neurons and has no stats for nobody", () => {
    expect(traitStats([plan({ hiddenLayers: [8, 4] })], [BIRTH])![3]!.mean).toBe(12);
    expect(traitStats([], [])).toBeNull();
    const t = traitStats([plan(), plan()], [BIRTH, { energy: 300, cost: 90, cooldown: 4 }])!;
    expect(TRAITS.slice(-3).map((x) => x.key)).toEqual(["birthEnergy", "birthCost", "cooldown"]);
    expect(t.slice(-3).map((x) => x.mean)).toEqual([225, 82.5, 7]);
  });
});

const entry = (id: number, over: Partial<LeaderEntry> = {}): Omit<LeaderEntry, "value" | "to" | "alive"> => ({ id, species: 0, hue: 120, from: 0, plan: plan(), ...over });

describe("Leaderboard", () => {
  it("keeps the best few, best first, and builds an entry only when it gets in", () => {
    const board = new Leaderboard(3);
    let built = 0;
    const offer = (id: number, value: number) => board.offer("age", 0, id, value, 10, false, () => { built++; return entry(id); });
    [5, 9, 7, 1, 8].forEach((v, i) => offer(i, v));
    expect(built).toBe(4); // value 1 never got in
    expect(board.snapshot()[0]!.entries.map((e) => [e.id, e.value])).toEqual([[1, 9], [4, 8], [2, 7]]);
  });

  it("updates a listed creature in place as it lives on, and ignores zeros", () => {
    const board = new Leaderboard(2);
    board.offer("children", 0, 1, 1, 5, true, () => entry(1));
    board.offer("children", 0, 2, 2, 5, true, () => entry(2));
    board.offer("children", 0, 1, 3, 9, false, () => { throw new Error("already listed"); });
    board.offer("children", 0, 3, 0, 9, true, () => entry(3));
    const list = board.snapshot()[0]!.entries;
    expect(list.map((e) => [e.id, e.value, e.to, e.alive])).toEqual([[1, 3, 9, false], [2, 2, 5, true]]);
  });

  it("keeps species and boards apart and hands out copies", () => {
    const board = new Leaderboard();
    board.offer("age", 0, 1, 5, 5, true, () => entry(1));
    board.offer("age", 1, 2, 5, 5, true, () => entry(2, { species: 1 }));
    board.offer("kills", 1, 2, 4, 5, true, () => entry(2, { species: 1 }));
    const snap = board.snapshot();
    expect(snap.map((l) => `${l.species}:${l.board}`).sort()).toEqual(["0:age", "1:age", "1:kills"]);
    snap[0]!.entries[0]!.plan.hiddenLayers.push(99);
    expect(board.snapshot()[0]!.entries[0]!.plan.hiddenLayers).toEqual([8]);
  });
});

function setup(config: EcoConfig) {
  const clock = { t: 0 };
  const sent: EcoSnapshot[] = [];
  const post = (msg: EcoOutMessage) => {
    if (msg.type !== "snapshot") return;
    sent.push(msg);
    runner.handle({ type: "recycle", buffer: msg.buffer, run: msg.run }); // the page keeps up
  };
  const runner: EcoRunner = new EcoRunner(post, () => (clock.t += 5));
  runner.handle({ type: "start", config, run: 1 });
  runner.handle({ type: "speed", speed: "max" });
  return { runner, sent };
}

describe("EcoRunner statistics", () => {
  it("sends trait histograms and the run's records, dead creatures included, with a bounded list", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const config: EcoConfig = { ...d, world: { ...d.world, width: 400, height: 400 }, eco: { ...d.eco, initialPopulation: 30 } };
    const { runner, sent } = setup(config);
    for (let i = 0; i < 700; i++) runner.pump();
    const withLeaders = sent.filter((m) => m.leaders);
    const m = withLeaders[withLeaders.length - 1]!;
    const age = m.leaders!.find((l) => l.board === "age")!;
    expect(age.entries.length).toBeLessThanOrEqual(3);
    expect(age.entries.map((e) => e.value)).toEqual([...age.entries.map((e) => e.value)].sort((a, b) => b - a));
    expect(m.traits!.length).toBe(1);
    expect(withLeaders.find((x) => x.traits![0])!.traits![0]!.length).toBe(TRAITS.length); // null once the world is extinct
    expect(m.leaders!.some((l) => l.board === "kills")).toBe(false);
    expect(m.deaths).toBeGreaterThan(0);
    const all = runner.ecosystem!;
    expect(age.entries[0]!.value).toBeGreaterThanOrEqual(Math.max(...all.members.map((c) => c.ageTicks * config.dt)));
  });

  it("keeps a record per species and prey kills for hunters", () => {
    const d = structuredClone(DEFAULT_PREDATOR_CONFIG);
    const config: EcoConfig = { ...d, world: { ...d.world, width: 300, height: 300 }, species: d.species!.map((sp, i) => ({ ...sp, founders: i === 0 ? 60 : 15 })) };
    const { runner, sent } = setup(config);
    for (let i = 0; i < 600; i++) runner.pump();
    const m = sent.filter((x) => x.leaders).pop()!;
    expect(m.traits!.length).toBe(2);
    expect(new Set(m.leaders!.map((l) => l.species))).toEqual(new Set([0, 1]));
    expect(m.leaders!.filter((l) => l.board === "eaten").every((l) => l.species === 0)).toBe(true);
    expect(m.leaders!.filter((l) => l.board === "kills").every((l) => l.species === 1)).toBe(true);
  });

  it("reports the current energy use with movement on top of the base", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const config: EcoConfig = { ...d, world: { ...d.world, width: 400, height: 400 }, eco: { ...d.eco, initialPopulation: 10, aging: false } };
    const { runner, sent } = setup(config);
    runner.handle({ type: "select", id: 0 });
    for (let i = 0; i < 20; i++) runner.pump();
    runner.handle({ type: "select", id: 0 }); // posts a fresh snapshot
    const s = sent[sent.length - 1]!.selected!;
    expect(s.upkeep).toBeCloseTo(planUpkeep(s.plan, config));
    expect(s.drain).toBeGreaterThanOrEqual(s.upkeep);
    const c = runner.ecosystem!.get(0)!.creature;
    expect(c.drain).toBeCloseTo(s.drain, 6);
  });
});

describe("leader panel", () => {
  const e: LeaderEntry = { ...entry(7), value: 90, to: 130, alive: false };

  it("draws every ray to scale and the fan edge, facing right", () => {
    const svg = creatureSvg({ ...e, plan: plan({ rayCount: 4, rayLength: 100, raySpread: Math.PI / 2 }) }, 6, fanScale([e]));
    expect(svg.match(/M23 23L/g)!.length).toBe(4 + 1); // four rays and the wedge edge
    expect(svg).toContain("<circle");
    const long = fanScale([e, { ...e, plan: plan({ rayLength: 200 }) }]);
    expect(long).toBeCloseTo(fanScale([e]) / 2);
  });

  it("draws a full circle fan without a wedge", () => {
    const svg = creatureSvg({ ...e, plan: plan({ raySpread: 2 * Math.PI, rayCount: 6 }) }, 6, 0.1);
    expect(svg.match(/<circle/g)!.length).toBe(2);
  });

  it("writes lifetimes and renders boards per species", () => {
    expect(lifeSpan({ from: 12, to: 74, alive: false })).toBe("12.0 s to 1m 14s");
    expect(lifeSpan({ from: 12, to: 74, alive: true })).toBe("12.0 s to now");
    document.body.innerHTML = `<section><div class="ov-body"><ul class="lead-list"></ul></div></section>`;
    const panel = new LeaderPanel(document.querySelector("section")!, ["Prey", "Predators"], 6);
    panel.set([
      { species: 0, board: "age", entries: [e] },
      { species: 1, board: "kills", entries: [{ ...e, species: 1, value: 4 }] },
    ]);
    const text = () => document.querySelector(".lead-list")!.textContent;
    expect(text()).toContain("Longest-lived");
    expect(document.querySelectorAll(".lead-cell svg").length).toBe(1);
    document.querySelector<HTMLInputElement>('input[value="1"]')!.click();
    expect(text()).toContain("Most prey eaten");
    expect(text()).not.toContain("Longest-lived");
  });
});

describe("trait panel", () => {
  it("shows mean and range per trait and a bar per bin", () => {
    expect(traitText({ min: 3, max: 12, mean: 8.25, bins: [] }, "")).toEqual({ mean: "8.3", range: "3 to 12" });
    expect(traitText({ min: 90, max: 90, mean: 90, bins: [4] }, "°")).toEqual({ mean: "90°", range: "all equal" });
    document.body.innerHTML = `<section><div class="ov-body"><ul class="trait-list"></ul></div></section>`;
    const panel = new TraitPanel(document.querySelector("section")!, []);
    panel.set([traitStats([plan(), plan({ rayCount: 8 })], [BIRTH, BIRTH])!]);
    expect(document.querySelectorAll(".trait-row").length).toBe(TRAITS.length);
    expect(document.querySelectorAll(".trait-row")[0]!.querySelectorAll("i").length).toBe(4);
    panel.clear();
    expect(document.querySelectorAll(".trait-row").length).toBe(0);
  });
});

describe("Trials base energy note", () => {
  it("states the base energy per second of the settings", () => {
    const brain = TRIALS_SECTIONS.find((s) => s.title === "Brain")!;
    const cheap = brain.note!(DEFAULT_CONFIG);
    expect(cheap).toContain(planUpkeep(planOf(DEFAULT_CONFIG), DEFAULT_CONFIG).toFixed(2));
    const more = brain.note!({ ...DEFAULT_CONFIG, brain: { ...DEFAULT_CONFIG.brain, hiddenLayers: [32, 32, 32] } });
    expect(more).not.toBe(cheap);
  });
});
