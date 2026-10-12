import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { runEpisode } from "../../src/typescript/src/sim/episode.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "../../src/typescript/src/sim/types.ts";
import type { World } from "../../src/typescript/src/sim/world.ts";
import { ECO_FORM } from "../../src/typescript/src/ui/ecoSettingsForm.ts";
import type { FormSpec } from "../../src/typescript/src/ui/settingsForm.ts";
import { TRIALS_FORM } from "../../src/typescript/src/ui/trialsForm.ts";
import { ThinkPool, serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";
import { testRng } from "./helpers.ts";

// parameters
const SEED = 20260;
const ECO_CASES = 8;
const HUNT_CASES = 6;
const POOL_EVERY = 4; // every 4th case also runs on 2 in-process helpers
const TICKS = 120;
const GRID_EVERY = 5; // ticks between full item grid walks; the creature and counter checks run every tick
const TRIAL_CASES = 12;

type R = ReturnType<typeof testRng>;

// A random config from the sliders of a form: every range gets a uniform step of its allowed range, every toggle and choice a random value.
// shrink then makes the world small and the run short, since the sliders reach 30000-wide worlds and 10000 creatures.
function draw<C extends object>(form: FormSpec<C>, rng: R, shrink: (c: C) => void): C {
  const c = structuredClone(form.defaults);
  for (const section of form.sections) {
    for (const f of section.fields) {
      if (f.kind === "range") f.set(c, Math.min(f.max, f.min + f.step * rng.int(Math.floor((f.max - f.min) / f.step + 1e-9) + 1)));
      else if (f.kind === "toggle") f.set(c, rng.next() < 0.5);
      else if (f.kind === "choice") f.set(c, f.options[rng.int(f.options.length)]![0]);
    }
  }
  shrink(c);
  return c;
}

function smallWorld(c: EcoConfig, rng: R): void {
  c.world.width = 500 + 50 * rng.int(19);
  c.world.height = 500 + 50 * rng.int(19);
  c.eco.maxPopulation = 100 + 10 * rng.int(7);
  c.eco.initialPopulation = 10 + rng.int(80);
  if (c.eco.aging) c.eco.agingStart = 1 + rng.int(4); // below the slider's 30 s, so ageing acts within a short run
  // Most slider combinations never breed within a short run, so 2 of 3 get cheap, quick births and hunts.
  if (rng.int(3) === 0) return;
  const lively = (x: { birthEnergyRange?: number[]; birthCostRange?: number[]; birthCooldownRange?: number[]; startEnergy?: number }): void => {
    x.birthEnergyRange = [40, 90];
    x.birthCostRange = [25, 35];
    x.birthCooldownRange = [0.5, 3];
    x.startEnergy = 60;
  };
  lively(c.eco);
  c.creature.startEnergy = 60;
  for (const sp of c.species ?? []) lively(sp);
}

function ecoConfig(rng: R, seed: number): EcoConfig {
  const c = draw(ECO_FORM, rng, (x) => smallWorld(x, rng));
  c.seed = seed;
  return c;
}

function huntConfig(rng: R, seed: number): EcoConfig {
  // The Ecosystem sliders for the shared settings, the two default species with drawn founders, speed and catch gains.
  const c = draw(ECO_FORM, rng, (x) => {
    x.species = structuredClone(DEFAULT_PREDATOR_CONFIG.species!);
    smallWorld(x, rng);
    for (const sp of x.species) {
      sp.founders = 3 + rng.int(40);
      sp.speed = 0.5 + 0.1 * rng.int(16);
    }
    x.species[1]!.eatEfficiency = 0.1 * rng.int(11);
    x.species[1]!.eatBaseline = 10 * rng.int(21);
  });
  c.seed = seed;
  return c;
}

// In-process helpers over cloned messages, as in the ecoPool tests.
function fakePorts(n: number): HelperPort[] {
  return Array.from({ length: n }, () => {
    let reply: (msg: HelperOut) => void = () => {};
    const handle = serveHelper((msg, transfer) => queueMicrotask(() => reply(structuredClone(msg, { transfer: transfer as ArrayBuffer[] }))));
    return {
      post: (msg: HelperIn, transfer?: Transferable[]) => {
        const copy = structuredClone(msg, { transfer: (transfer ?? []) as ArrayBuffer[] });
        queueMicrotask(() => handle(copy));
      },
      onMessage: (callback) => { reply = callback; },
      onError: () => {},
      terminate: () => {},
    };
  });
}

// The first broken invariant of the item grid, or "".
function itemProblem(eco: Ecosystem, start: { food: number; poison: number }): string {
  const w = eco.world as World;
  const s = w.snapshot();
  const seen = new Uint8Array(w.count);
  for (let c = 0; c < s.cellHead.length; c++) {
    for (let i = s.cellHead[c]!, n = 0; i >= 0; i = s.nextItem[i]!, n++) {
      if (n > w.count || i >= w.count) return `cell ${c} list loops or leaves the slots`;
      if (seen[i]!++) return `item ${i} is in two cell lists`;
      if (s.kinds[i] === HIT_NONE) return `free item ${i} is in cell ${c}`;
      const cx = Math.min(w.cols - 1, Math.max(0, Math.floor(s.xs[i]! / w.cell)));
      const cy = Math.min(w.rows - 1, Math.max(0, Math.floor(s.ys[i]! / w.cell)));
      if (cy * w.cols + cx !== c) return `item ${i} is in the wrong cell`;
    }
  }
  let food = 0;
  let poison = 0;
  for (let i = 0; i < w.count; i++) {
    const k = s.kinds[i];
    if (k === HIT_NONE) {
      if (seen[i]) return `free slot ${i} is listed`;
      continue;
    }
    if (!seen[i]) return `live item ${i} is in no cell list`;
    if (!(s.xs[i]! >= 0 && s.xs[i]! <= w.width && s.ys[i]! >= 0 && s.ys[i]! <= w.height)) return `item ${i} left the world`;
    if (k === HIT_FOOD) food++;
    else if (k === HIT_POISON) poison++;
    else return `item ${i} has kind ${k}`;
  }
  if (w.used !== food + poison) return `used ${w.used} but ${food + poison} live items`;
  if (s.freeCount !== w.count - w.used) return "free stack size";
  const onStack = new Set(Array.from(s.freeSlots.subarray(0, s.freeCount)));
  if (onStack.size !== s.freeCount) return "free stack repeats a slot";
  for (const i of onStack) if (s.kinds[i] !== HIT_NONE || seen[i]) return `slot ${i} is free and used`;
  if (food !== eco.food || poison !== eco.poison) return `counters food ${eco.food}/${food} poison ${eco.poison}/${poison}`;
  const cap = (density: number, started: number) => Math.max(started, Math.round(density * ((w.width * w.height) / 100 ** 2)));
  if (food > cap(eco.config.eco.foodMaxDensity, start.food)) return `food ${food} over its cap`;
  if (poison > cap(eco.config.eco.poisonMaxDensity, start.poison)) return `poison ${poison} over its cap`;
  return "";
}

// The first broken invariant of creatures, counters and families, or "".
function problem(eco: Ecosystem, before: { pop: number; births: number; deaths: number }): string {
  const { width, height } = eco.config.world;
  const ids = new Set<number>();
  const perSpecies = eco.speciesCounts.map(() => 0);
  const family = new Map<number, number>();
  for (const m of eco.members) {
    const s = m.creature.state;
    for (const [k, v] of Object.entries({ x: s.x, y: s.y, heading: s.heading, vx: s.vx, vy: s.vy, turnRate: s.turnRate, energy: s.energy })) {
      if (!Number.isFinite(v)) return `creature ${m.id} ${k} is ${v}`;
    }
    const r = eco.config.creature.radius; // the wall keeps the body, not only the centre, inside
    if (!(s.x >= r - 1e-6 && s.x <= width - r + 1e-6 && s.y >= r - 1e-6 && s.y <= height - r + 1e-6)) return `creature ${m.id} at ${s.x},${s.y} outside ${width}x${height}`;
    if (!s.alive) return `dead creature ${m.id} still a member`;
    if (ids.has(m.id)) return `id ${m.id} twice`;
    ids.add(m.id);
    perSpecies[m.species]!++;
    family.set(m.founderId, (family.get(m.founderId) ?? 0) + 1);
  }
  const pop = eco.population;
  if (pop > eco.config.eco.maxPopulation && pop > before.pop) return `population ${pop} over the limit ${eco.config.eco.maxPopulation}`;
  if (pop - before.pop !== eco.births - before.births - (eco.deaths - before.deaths)) return `population moved ${pop - before.pop} but births +${eco.births - before.births} deaths +${eco.deaths - before.deaths}`;
  const counts = eco.speciesCounts;
  if (counts.reduce((a, c) => a + c.births, 0) !== eco.births) return "species births do not sum to births";
  if (counts.reduce((a, c) => a + c.deaths, 0) !== eco.deaths) return "species deaths do not sum to deaths";
  if (counts.reduce((a, c) => a + c.population, 0) !== pop) return "species populations do not sum to the population";
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]!.population !== perSpecies[i]) return `species ${i} count ${counts[i]!.population} but ${perSpecies[i]} members`;
    if (counts[i]!.eaten > counts[i]!.deaths) return `species ${i} eaten ${counts[i]!.eaten} over deaths ${counts[i]!.deaths}`;
  }
  const off = eco.lineages.firstMismatch(family);
  if (off !== -1) return `lineage ${off} size differs from its living members`;
  let lineageTotal = 0;
  for (const l of eco.lineages.top(1e9)) lineageTotal += l.count;
  if (lineageTotal !== pop) return `lineages total ${lineageTotal} but population ${pop}`;
  return "";
}

function runChecked(config: EcoConfig): Ecosystem {
  const eco = new Ecosystem(config);
  const start = { food: eco.food, poison: eco.poison };
  for (let t = 0; t < TICKS; t++) {
    const before = { pop: eco.population, births: eco.births, deaths: eco.deaths };
    eco.step();
    const bad = problem(eco, before) || (t % GRID_EVERY === 0 ? itemProblem(eco, start) : "");
    if (bad) throw new Error(`seed ${config.seed} tick ${eco.tick}: ${bad}`);
  }
  return eco;
}

async function pooled(config: EcoConfig): Promise<Ecosystem> {
  const pool = new ThinkPool(fakePorts(2));
  try {
    const eco = new Ecosystem(config, null, { journal: true });
    await pool.start(eco);
    for (let t = 0; t < TICKS; t++) await pool.step(eco);
    return eco;
  } finally {
    pool.close();
  }
}

const summary = (e: Ecosystem): string => JSON.stringify([e.fingerprint(), e.births, e.deaths, e.speciesCounts.map((s) => s.eaten)]);

describe("simulation invariants under random settings", () => {
  const cases: [string, EcoConfig][] = [];
  const rng = testRng(SEED);
  for (let i = 0; i < ECO_CASES; i++) cases.push([`Ecosystem ${i}`, ecoConfig(rng, 100 + i)]);
  for (let i = 0; i < HUNT_CASES; i++) cases.push([`Hunting ${i}`, huntConfig(rng, 200 + i)]);
  const done = new Map<string, Ecosystem>();

  it.each(cases)("%s keeps its invariants every tick and repeats exactly", (name, config) => {
    const first = runChecked(structuredClone(config));
    done.set(name, first);
    const again = new Ecosystem(structuredClone(config));
    for (let t = 0; t < TICKS; t++) again.step();
    expect(summary(again)).toBe(summary(first));
  }, 30_000);

  it.each(cases.filter((_c, i) => i % POOL_EVERY === 0))("%s gives the same run on 2 helpers as in one thread", async (name, config) => {
    const serial = done.get(name) ?? runChecked(structuredClone(config));
    expect(summary(await pooled(structuredClone(config)))).toBe(summary(serial));
  }, 30_000);

  it("the random configs reach births, deaths and kills, so the checks have something to see", () => {
    const total = { births: 0, deaths: 0, eaten: 0 };
    for (const e of done.values()) {
      total.births += e.births;
      total.deaths += e.deaths;
      total.eaten += e.speciesCounts.reduce((a, s) => a + s.eaten, 0);
    }
    expect(done.size).toBe(cases.length);
    expect(total.births).toBeGreaterThan(0);
    expect(total.deaths).toBeGreaterThan(0);
    expect(total.eaten).toBeGreaterThan(0);
  });
});

describe("Trials episodes under random settings", () => {
  const rng = testRng(SEED + 1);
  const configs: SimConfig[] = [];
  for (let i = 0; i < TRIAL_CASES; i++) {
    const c = draw(TRIALS_FORM, rng, (x) => {
      x.world.width = 200 + 20 * rng.int(26);
      x.world.height = 200 + 20 * rng.int(26);
      x.creature.maxLifeSeconds = 6;
    });
    c.seed = 300 + i;
    configs.push(c);
  }

  it("gives a finite, repeatable fitness", () => {
    for (const c of configs) {
      const genome = randomGenome(layerSizes(c), createRng(c.seed));
      const f = runEpisode(c, genome, c.seed, 0);
      expect(Number.isFinite(f), `seed ${c.seed}`).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(runEpisode(c, genome.slice(), c.seed, 0), `seed ${c.seed}`).toBe(f);
    }
  });
});
