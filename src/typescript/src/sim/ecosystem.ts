import { genomeLength, layerSizes, randomGenome, refit } from "./brain.ts";
import { itemCounts, itemsPerDensity } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { Creature, SenseBatch, senseThinkBatch } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import { seasonFactor, startRng } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { mutate } from "./ga.ts";
import { driftBirth, driftPlan, mutateStructure, randomBirth, randomPlan, remapWeights } from "./planMutation.ts";
import type { BirthTraits } from "./planMutation.ts";
import { agingOf, collide, hurt, keepInside, settle } from "./physics.ts";
import type { Aging, Contact } from "./physics.ts";
import type { StatefulRng } from "./rng.ts";
import { copyPlan, inputLayout, planOf } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { Lineages } from "./lineages.ts";
import type { Lineage } from "./lineages.ts";
import { trialsToEcoGenome } from "./seedPool.ts";
import type { PoolEntry } from "./seedPool.ts";
import { bandHue, founderCounts, seenEnergyScale, speciesEngine, speciesList, speciesRanges } from "./species.ts";
import type { Species } from "./species.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "./types.ts";
import type { CreatureState, Genome, HitKind, WorldView } from "./types.ts";
import { World } from "./world.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";

export type { Lineage } from "./lineages.ts";

// A founder placed as given; genome in the config's input layout for its species.
export interface CastMember {
  species: number;
  plan: PlanView;
  genome: Genome;
  x: number;
  y: number;
  heading: number;
  hue: number;
  energy?: number; // the species' start energy when left out
}

// Collision events for the page's effects, collected since the last drain and bounded: a Float32Array of EVENT_STRIDE numbers each, kind, x, y, value.
// An impact (kind 0, value = energy each lost) is reported at BIG_IMPACT or more; a death (kind 1, value = hue) from a bump or a hunt. Reporting changes no results.
export const EVENT_IMPACT = 0;
export const EVENT_DEATH = 1;
export const EVENT_STRIDE = 4;
export const EVENT_CAP = 32;
export const BIG_IMPACT = 15;

// One creature of the ecosystem with its family record. Objects are recycled after death, so hold ids, not references.
export class EcoCreature {
  id = 0;
  parentId = -1; // -1 for a founder
  depth = 0; // generations since its founder
  birthTick = 0;
  children = 0;
  eaten = 0; // food items eaten, poison not counted
  kills = 0; // prey eaten
  species = 0; // index into the config's species; children keep their parent's
  hue = 0; // degrees
  founderId = 0; // id of the founder this family descends from; a founder is its own
  lastBirthTick = -Infinity;
  // Heritable birth traits (#31): energy at which it has a child, energy it pays (the child's start energy), seconds between births.
  birth: BirthTraits = { energy: 0, cost: 0, cooldown: 0 };
  cooldownTicks = 0;
  owner = 0; // helper thread that thinks for it, set by the coordinator of helper threads
  readonly creature: Creature; // state, rays, rayOffsets and brain.layerActivations() of the last tick

  constructor(creature: Creature) {
    this.creature = creature;
  }

  get ageTicks(): number {
    return this.creature.state.ticksAlive;
  }
}

// Per-creature arrays for drawing, reused and grown by Ecosystem.readCreatures; entries 0 .. count-1 are valid.
export interface CreatureFrame {
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  energy: Float32Array;
  hue: Float32Array;
  founder: Int32Array;
  species: Int32Array;
}

// Counts of one species: living, born and died since the start, and how many of the deaths were eaten by hunters.
export interface SpeciesCount {
  population: number;
  births: number;
  deaths: number;
  eaten: number;
}

export interface EcoJournal {
  born: number[];
  died: number[];
  items: number[];
}

// All creatures in one shared world. Each tick has two phases:
// 1. sensePhase: every creature senses a snapshot (items, and creatures as gridded at the tick start) and thinks; then each
//    updates its memory and moves. Sensing and thinking write only the creature's own rays and outputs, so creature order
//    cannot matter and helper threads can run them (ecoShare.ts).
// 2. sharedPhase: eating, hunting, collisions (with optional damage), deaths, births and regrowth, serially. Eating, hunting and births
//    walk the creatures from a random start each tick, so no creature wins contested food, prey or the last free place by its list position.
// With a species list (The Great Hunt) every creature belongs to one species, with that species' body, costs, births and
// diet; a hunter eats a touching creature of a species it preys on. Without one there is a single species with the shared settings.
export class Ecosystem {
  readonly config: EcoConfig;
  readonly world: WorldView;
  tick = 0;
  births = 0;
  deaths = 0;
  foodEaten = 0;
  poisonEaten = 0;
  readonly poolFounders: number; // founders taken from the seed pool, the first ones of each species in id order
  readonly founders: number; // founders are ids 0 .. founders-1, species by species
  readonly species: readonly Species[];
  food = 0;
  poison = 0;
  // Living creatures in list order; states[i] is members[i].creature.state.
  readonly members: EcoCreature[] = [];
  // Id of a creature whose rays and brain input must be current after each tick (the selected one); the WASM sense leaves everyone else's stale.
  detail: number | null = null;
  // With the journal option: changes not yet drained by a helper coordinator (ecoShare.ts). born and died hold ids, items World.log records.
  journal: EcoJournal | null;

  private readonly items: World;
  private readonly crowd: Crowd;
  private readonly batch = new SenseBatch();
  private readonly kernels: SenseKernels | null; // with eco.wasm when WebAssembly SIMD is available
  private readonly states: CreatureState[] = [];
  private readonly byId = new Map<number, EcoCreature>();
  private readonly spare: EcoCreature[][]; // per species, since a creature keeps its species' engine config
  private readonly engines: EngineConfig[]; // per species
  private readonly ranges: EcoConfig["eco"][]; // per species, for plan variation
  private readonly counts: SpeciesCount[];
  private readonly kinds: number[] = []; // kinds[i] is members[i].species
  private readonly multi: boolean; // more than one species, so rays tell species apart
  private readonly hunters: boolean; // some species eats another
  private readonly slain = new Set<CreatureState>(); // killed by a bump or a hunt this tick
  private readonly events = new Float32Array(EVENT_CAP * EVENT_STRIDE);
  private eventCount = 0;
  private readonly rng: StatefulRng;
  // Scratch of one birth, grown as plans need: the child's plan, its genome, and the parent's weights remapped to a new shape.
  private readonly childPlan: BodyPlan;
  private childGenome = new Float32Array(0);
  private remapped = new Float32Array(0);
  private readonly foodCap: number;
  private readonly poisonCap: number;
  private readonly foodPerTick: number;
  private readonly poisonPerTick: number;
  private foodDue = 0; // fractional items accumulated by regrowth
  private poisonDue = 0;
  private nextId = 0;
  private readonly spot = { x: 0, y: 0, vx: 0, vy: 0 }; // scratch of a newborn's place
  private spent = false; // a parent gave its last energy to a child this tick
  private readonly traits: BirthTraits = { energy: 0, cost: 0, cooldown: 0 }; // scratch of one birth
  private readonly lineages: Lineages;
  private readonly aging: Aging | null;
  private readonly contact: Contact = { speed: 0 };
  onDeath: ((m: EcoCreature) => void) | null = null; // called with each creature as it leaves, before its object is recycled

  // pool: trained founders (see seedPool.ts); without one, or at poolFraction 0, every founder is random.
  // cast: exactly these founders instead of the species' founder counts (RL environments, see rl/env.ts).
  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null = null, options: { journal?: boolean; cast?: readonly CastMember[] } = {}) {
    this.config = config;
    const { eco, dt } = config;
    const perDensity = itemsPerDensity(config);
    const start = itemCounts(config);
    this.foodCap = Math.round(eco.foodMaxDensity * perDensity);
    this.poisonCap = Math.round(eco.poisonMaxDensity * perDensity);
    this.foodPerTick = eco.foodRegrow * perDensity * dt;
    this.poisonPerTick = eco.poisonRegrow * perDensity * dt;
    this.species = speciesList(config);
    this.multi = this.species.length > 1;
    this.hunters = this.species.some((sp) => sp.prey.length > 0);
    const scale = seenEnergyScale(this.species);
    this.engines = this.species.map((sp) => speciesEngine(config, sp, scale));
    this.ranges = this.species.map((sp) => speciesRanges(config, sp));
    this.counts = this.species.map(() => ({ population: 0, births: 0, deaths: 0, eaten: 0 }));
    this.spare = this.species.map(() => []);
    this.rng = startRng(config);
    this.aging = agingOf(eco, dt);
    this.items = new World(config, Math.max(start.food, this.foodCap) + Math.max(start.poison, this.poisonCap));
    this.world = this.items;
    this.journal = options.journal ? { born: [], died: [], items: [] } : null;
    this.items.log = this.journal?.items ?? null;
    this.items.scatter(start.food, start.poison, this.rng);
    this.food = start.food;
    this.poison = start.poison;
    const cast = options.cast;
    const counts = cast ? this.species.map(() => 0) : founderCounts(this.species, eco.maxPopulation);
    const founders = cast ? cast.length : counts.reduce((a, b) => a + b, 0);
    this.crowd = new Crowd(config, founders);
    // Plans past the kernel's ray limit (a huge ray count setting or pool entry) run on the JS path.
    const maxRays = Math.max(config.creature.rayCount, ...this.ranges.map((r) => r.rayCountRange[1] ?? 0), ...(pool ?? []).map((e) => e.plan.rayCount), ...(cast ?? []).map((c) => c.plan.rayCount));
    this.kernels = eco.wasm ? SenseKernels.create(config, maxRays) : null;
    this.childPlan = planOf(config);

    const { width, height } = config.world;
    const r = config.creature.radius;
    const seeds = pool?.length ? pool.map((e) => (config.creature.seesCreatures ? trialsToEcoGenome(e.plan, e.genome, config) : e.genome)) : [];
    const randomPlanScratch = this.childPlan;
    this.founders = founders;
    this.lineages = new Lineages(founders);
    let poolFounders = 0;
    let i = 0;
    for (let sp = 0; sp < this.species.length; sp++) {
      const spec = this.species[sp]!;
      const count = counts[sp]!;
      const fromPool = seeds.length ? Math.round(Math.min(1, Math.max(0, spec.poolFraction)) * count) : 0;
      const first = fromPool ? this.rng.int(seeds.length) : 0;
      for (let k = 0; k < count; k++, i++) {
        let plan: PlanView = randomPlanScratch;
        let genome: Genome;
        if (k < fromPool) {
          // Round-robin over the pool from a random entry, each copy mutated like a child.
          const e = (first + k) % seeds.length;
          plan = pool![e]!.plan;
          genome = seeds[e]!.slice();
          mutate(genome, this.config.mutation.rate, this.config.mutation.std, this.rng);
        } else {
          if (eco.foundersVary) randomPlan(this.ranges[sp]!, this.rng, randomPlanScratch);
          genome = randomGenome(layerSizes(config, plan), this.rng);
        }
        randomBirth(this.ranges[sp]!, this.rng, this.traits);
        const x = this.rng.range(r, width - r);
        const y = this.rng.range(r, height - r);
        const heading = this.rng.next() * 2 * Math.PI;
        const hue = spec.hue < 0 ? this.rng.next() * 360 : bandHue(spec, spec.hue + (this.rng.next() - 0.5) * spec.hueSpread);
        this.found(i, { species: sp, plan, genome, x, y, heading, hue, energy: spec.startEnergy }, k < fromPool);
      }
      poolFounders += fromPool;
    }
    for (const c of cast ?? []) {
      randomBirth(this.ranges[c.species]!, this.rng, this.traits);
      this.found(i++, c, false);
    }
    this.poolFounders = poolFounders;
    // Poison moves only once every founder stands, and never onto one, so none ends up on a founder placed earlier.
    const reach = r + config.world.itemRadius;
    this.crowd.rebuild(this.states, this.states.length);
    const onFounder = (px: number, py: number): boolean => this.crowd.anyWithin(px, py, reach);
    for (const s of this.states) this.items.clearPoison(s.x, s.y, r, this.rng, onFounder);
  }

  get population(): number {
    return this.members.length;
  }

  // True when sense and think run on the WebAssembly kernels (eco.wasm, and available here).
  get wasm(): boolean {
    return this.kernels !== null;
  }

  get extinct(): boolean {
    return this.members.length === 0;
  }

  // Living, born, died and eaten per species, in the config's order; live objects, read only.
  get speciesCounts(): readonly SpeciesCount[] {
    return this.counts;
  }

  // The living creature with this id, or undefined once it has died.
  get(id: number): EcoCreature | undefined {
    return this.byId.get(id);
  }

  step(): void {
    if (this.extinct) return;
    this.prepareTick();
    this.sensePhase(0, this.members.length);
    this.finishTick();
  }

  // Empties the journal, once a helper coordinator has published it.
  drainJournal(): void {
    const j = this.journal;
    if (j) j.born.length = j.died.length = j.items.length = 0;
  }

  // Stops recording the journal, once no helper threads read it.
  dropJournal(): void {
    this.journal = null;
    this.items.log = null;
  }

  // Grids the creatures as they stand at the tick start, for sensePhase.
  prepareTick(): void {
    if (this.states.length < 2 && this.crowd.count < 2) return; // a lone creature, or none, only sees itself in a grid of at most itself
    this.crowd.rebuild(this.states, this.states.length, this.multi ? this.kinds : undefined);
  }

  // Phase 1a for members start .. end-1, after prepareTick: sense and think into each creature's outputs.
  sensePhase(start: number, end: number): void {
    const batch = this.batch;
    batch.clear();
    for (let i = start; i < end; i++) batch.add(this.members[i].creature, i);
    this.senseBatch(batch);
  }

  // Brings the detail creature's rays and brain input up to date outside a tick (display only, on the JS path): on selecting it,
  // or while paused. Rebuilds the crowd grid, which every tick does first anyway, and leaves the simulation state alone.
  refreshDetail(): void {
    const i = this.detail === null ? -1 : this.members.findIndex((m) => m.id === this.detail);
    if (i < 0) return;
    this.crowd.rebuild(this.states, this.states.length, this.multi ? this.kinds : undefined);
    const c = this.members[i]!.creature;
    c.sense(this.items, this.crowd, i);
    c.encode();
  }

  // Phase 1a for a batch of members, each at its list index, after prepareTick.
  senseBatch(batch: SenseBatch): void {
    if (this.kernels) this.kernels.detail = this.detail === null ? null : (this.byId.get(this.detail)?.creature ?? null);
    senseThinkBatch(this.items, this.crowd, batch, this.kernels);
  }

  // Phase 1b for one creature: memory and motion. Returns the item it touches there (Creature.touched), for finishTick.
  advance(creature: Creature): number {
    creature.remember();
    creature.steer();
    return creature.touched(this.items);
  }

  // Phase 1b and 2, once every creature has its outputs (from sensePhase or helper threads): memory and motion, then sharedPhase.
  // With touched, helper threads already did memory and motion and looked up what each creature touches (touched[i] for members[i],
  // see Creature.touched), so only the shared phase runs.
  finishTick(touched?: Int32Array): void {
    if (!touched) {
      for (const m of this.members) {
        m.creature.remember();
        m.creature.steer();
      }
    }
    this.sharedPhase(touched);
  }

  // Phase 2, after every creature moved.
  private sharedPhase(touched?: Int32Array): void {
    const members = this.members;
    let n = members.length;
    let first = this.rng.int(n);
    for (let k = 0; k < n; k++) {
      const at = (first + k) % n;
      const m = members[at];
      if (!this.species[m.species]!.plants) continue;
      let eaten: number;
      if (touched && (touched[at] < 0 || this.items.kinds[touched[at]] !== HIT_NONE)) {
        // Items are only removed in this loop, so a looked-up item still there is still the first touched, and none stays none.
        eaten = touched[at];
        if (eaten >= 0) m.creature.eatItem(this.items, eaten);
      } else eaten = m.creature.eat(this.items); // looked up item taken by an earlier creature, or no lookup
      if (eaten < 0) continue;
      if (this.items.kinds[eaten] === HIT_FOOD) {
        this.food--;
        m.eaten++;
        this.foodEaten++;
      } else {
        this.poison--;
        this.poisonEaten++;
      }
      this.items.removeItem(eaten); // so no one else eats it this tick
    }

    if (this.hunters) this.hunt(); // grids the moved positions, which collideAll reuses since hunting moves no one
    if (this.config.eco.collisions) this.collideAll(this.hunters);

    for (let i = n - 1; i >= 0; i--) {
      const state = this.states[i];
      settle(state);
      if (!state.alive) {
        if (this.slain.size > 0 && this.slain.delete(state)) this.report(EVENT_DEATH, state.x, state.y, this.members[i].hue);
        this.remove(i);
      }
    }
    this.slain.clear();

    n = members.length;
    first = n > 0 ? this.rng.int(n) : 0;
    const eco = this.config.eco;
    for (let k = 0; k < n && members.length < eco.maxPopulation; k++) {
      const parent = members[(first + k) % n];
      if (parent.creature.state.energy >= parent.birth.energy && this.tick - parent.lastBirthTick >= parent.cooldownTicks) this.giveBirth(parent);
    }
    if (this.spent) {
      // Parents that gave all they had are gone.
      for (let i = members.length - 1; i >= 0; i--) if (!this.states[i].alive) this.remove(i);
      this.spent = false;
    }

    this.regrow();
    this.tick++;
  }

  // Each living hunter, from a random start, eats the nearest touching creature of a species it preys on, at most one per
  // tick, using a grid of the moved positions. The prey dies (removed with the other deaths) and cannot be eaten twice.
  private hunt(): void {
    const crowd = this.crowd;
    const states = this.states;
    const members = this.members;
    const n = members.length;
    crowd.rebuild(states, n, this.kinds);
    const reach = 2 * this.config.creature.radius;
    const inv = 1 / crowd.cell;
    const first = n > 0 ? this.rng.int(n) : 0;
    for (let k = 0; k < n; k++) {
      const hunter = members[(first + k) % n]!;
      const sp = this.species[hunter.species]!;
      const s = states[(first + k) % n]!;
      if (sp.prey.length === 0 || s.energy <= 0) continue;
      const cx0 = Math.max(0, Math.floor((s.x - reach) * inv));
      const cx1 = Math.min(crowd.cols - 1, Math.floor((s.x + reach) * inv));
      const cy0 = Math.max(0, Math.floor((s.y - reach) * inv));
      const cy1 = Math.min(crowd.rows - 1, Math.floor((s.y + reach) * inv));
      let best = -1;
      let bestD2 = reach * reach;
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * crowd.cols;
        const end = crowd.cellStart[row + cx1 + 1]!;
        for (let t = crowd.cellStart[row + cx0]!; t < end; t++) {
          if (!sp.prey.includes(crowd.species[t]!)) continue;
          const o = crowd.owners[t]!;
          const p = states[o]!;
          if (!p.alive || p.energy <= 0) continue;
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && best >= 0 && members[o]!.id < members[best]!.id)) {
            best = o;
            bestD2 = d2;
          }
        }
      }
      if (best < 0) continue;
      const prey = states[best]!;
      s.energy += sp.eatEfficiency * prey.energy + sp.eatBaseline;
      prey.energy = 0;
      prey.alive = false;
      this.slain.add(prey);
      hunter.kills++;
      this.counts[members[best]!.species]!.eaten++;
    }
  }

  // Pushes overlapping pairs apart with a bounce, using a grid of the moved positions. Pairs resolve in grid order.
  // gridded: the crowd already holds the moved positions.
  private collideAll(gridded = false): void {
    const crowd = this.crowd;
    const states = this.states;
    if (states.length < 2) return; // no pairs
    if (!gridded) crowd.rebuild(states, states.length);
    const { cols, rows, cellStart, owners } = crowd;
    const { radius } = this.config.creature;
    const { width, height } = this.config.world;
    const e = 1; // restitution
    // Occupied cells in row-major order, the same order as sweeping every cell.
    for (let o = 0; o < crowd.occupiedCount; o++) {
      const c = crowd.occupied[o]!;
      const cy = Math.floor(c / cols);
      const cx = c - cy * cols;
      const end = cellStart[c + 1];
      for (let s = cellStart[c]; s < end; s++) {
        const a = states[owners[s]];
        // Later creatures of this cell, then the cells right, below-left, below and below-right, so each pair is seen once.
        for (let t = s + 1; t < end; t++) this.bump(a, states[owners[t]], radius, e, width, height);
        if (cx + 1 < cols) this.bumpCell(a, c + 1, radius, e, width, height);
        if (cy + 1 < rows) {
          const below = c + cols;
          if (cx > 0) this.bumpCell(a, below - 1, radius, e, width, height);
          this.bumpCell(a, below, radius, e, width, height);
          if (cx + 1 < cols) this.bumpCell(a, below + 1, radius, e, width, height);
        }
      }
    }
  }

  private bumpCell(a: CreatureState, cell: number, radius: number, e: number, width: number, height: number): void {
    const { cellStart, owners } = this.crowd;
    for (let t = cellStart[cell]; t < cellStart[cell + 1]; t++) this.bump(a, this.states[owners[t]], radius, e, width, height);
  }

  private bump(a: CreatureState, b: CreatureState, radius: number, e: number, width: number, height: number): void {
    const eco = this.config.eco;
    if (!a.alive || !b.alive) return; // an eaten prey; everyone else is alive until settle
    if (!collide(a, b, radius, e, this.contact)) return;
    if (eco.collisionDamage) {
      const fresh = a.energy > 0 && b.energy > 0 && this.contact.speed > 0; // else hurt does nothing
      hurt(a, b, this.contact.speed, eco.damagePerSpeed);
      if (fresh) this.noteHurt(a, b, eco.damagePerSpeed * this.contact.speed);
    }
    keepInside(a, radius, width, height, this.config.creature.wallBounce);
    keepInside(b, radius, width, height, this.config.creature.wallBounce);
  }

  private noteHurt(a: CreatureState, b: CreatureState, loss: number): void {
    if (loss >= BIG_IMPACT) this.report(EVENT_IMPACT, (a.x + b.x) / 2, (a.y + b.y) / 2, loss);
    if (a.energy <= 0) this.slain.add(a);
    if (b.energy <= 0) this.slain.add(b);
  }

  private report(kind: number, x: number, y: number, value: number): void {
    if (this.eventCount >= EVENT_CAP) return;
    this.events.set([kind, x, y, value], this.eventCount++ * EVENT_STRIDE);
  }

  // The events since the last call, or null for none.
  drainEvents(): Float32Array | null {
    if (this.eventCount === 0) return null;
    const out = this.events.slice(0, this.eventCount * EVENT_STRIDE);
    this.eventCount = 0;
    return out;
  }

  private giveBirth(parent: EcoCreature): void {
    const { eco, creature: cc, world: w } = this.config;
    const sp = this.species[parent.species]!;
    const ranges = this.ranges[parent.species]!;
    const ps = parent.creature.state;
    // Energy is conserved: the child starts with what the parent pays, and a cost of all its energy or more is its end.
    const paid = Math.min(parent.birth.cost, ps.energy);
    ps.energy -= paid;
    if (ps.energy <= 0) {
      ps.energy = 0;
      ps.alive = false;
      this.spent = true;
    }
    parent.lastBirthTick = this.tick;
    parent.children++;
    const pc = parent.creature;
    const plan = this.childPlan;
    copyPlan(pc.plan, plan);
    let source = pc.brain.genome;
    if (eco.planDrift > 0) driftPlan(plan, eco.planDrift, ranges, this.rng);
    if (eco.structuralRate > 0 && this.rng.next() < eco.structuralRate) {
      const maps = mutateStructure(plan, inputLayout(this.config, pc.plan), pc.brain.sizes, ranges, this.rng);
      if (maps) {
        this.remapped = refit(this.remapped, genomeLength(maps.map((m) => m.length)));
        remapWeights(pc.brain.sizes, source, maps, this.remapped, this.rng);
        source = this.remapped;
      }
    }
    const genome = (this.childGenome = refit(this.childGenome, source.length));
    genome.set(source);
    mutate(genome, this.config.mutation.rate, this.config.mutation.std, this.rng);
    const traits = this.traits;
    traits.energy = parent.birth.energy;
    traits.cost = parent.birth.cost;
    traits.cooldown = parent.birth.cooldown;
    if (eco.birthDrift > 0) driftBirth(traits, eco.birthDrift, ranges, this.rng);
    const angle = this.rng.next() * 2 * Math.PI;
    const gap = 2 * cc.radius + 1; // just clear of the parent
    // Next to the parent along the launch direction; against a wall the clamp can leave them touching, and collisions part them.
    const spot = this.spot;
    spot.x = ps.x + Math.cos(angle) * gap;
    spot.y = ps.y + Math.sin(angle) * gap;
    keepInside(spot, cc.radius, w.width, w.height, cc.wallBounce);
    const child = this.spawn(genome, plan, spot.x, spot.y, angle, paid, parent.species);
    this.setBirth(child, traits);
    const s = child.creature.state;
    // Parent and child part at birthSpeed relative to each other, half each way, so the parent's own motion cannot carry it back
    // into the child, and the pair's momentum stays what the parent had.
    const half = eco.birthSpeed / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    s.vx = ps.vx + cos * half;
    s.vy = ps.vy + sin * half;
    ps.vx -= cos * half;
    ps.vy -= sin * half;
    keepInside(s, cc.radius, w.width, w.height, cc.wallBounce);
    child.parentId = parent.id;
    child.founderId = parent.founderId;
    this.lineages.born(child.founderId);
    child.depth = parent.depth + 1;
    child.hue = bandHue(sp, parent.hue + this.rng.normal() * eco.hueDrift);
    this.births++;
    this.counts[parent.species]!.births++;
  }

  private setBirth(m: EcoCreature, t: BirthTraits): void {
    m.birth.energy = t.energy;
    m.birth.cost = t.cost;
    m.birth.cooldown = t.cooldown;
    m.cooldownTicks = Math.round(t.cooldown / this.config.dt);
  }

  // Places founder i with the birth traits in this.traits; the one path for drawn and cast founders.
  private found(i: number, c: CastMember, fromPool: boolean): void {
    const m = this.spawn(c.genome, c.plan, c.x, c.y, c.heading, c.energy ?? this.species[c.species]!.startEnergy, c.species);
    this.setBirth(m, this.traits);
    m.hue = c.hue;
    this.lineages.describe(i, c.hue, c.species, fromPool);
  }

  // Adds a creature, reusing a dead one's storage when there is one; genome and plan are copied.
  private spawn(genome: Genome, plan: PlanView, x: number, y: number, heading: number, energy: number, species: number): EcoCreature {
    let m = this.spare[species]!.pop();
    if (m) m.creature.reset(genome, x, y, heading, energy, plan);
    else {
      m = new EcoCreature(new Creature(this.engines[species]!, genome, x, y, heading, plan));
      m.creature.state.energy = energy;
    }
    m.species = species;
    this.counts[species]!.population++;
    m.id = this.nextId++;
    m.founderId = m.id; // a child overwrites this
    m.creature.aging = this.aging;
    if (m.id < this.founders) this.lineages.found(m.id);
    m.parentId = -1;
    m.depth = 0;
    m.birthTick = this.tick;
    m.children = 0;
    m.eaten = 0;
    m.kills = 0;
    m.lastBirthTick = -Infinity;
    this.journal?.born.push(m.id);
    this.members.push(m);
    this.kinds.push(species);
    this.states.push(m.creature.state);
    this.byId.set(m.id, m);
    return m;
  }

  // Swap-removes members[i].
  private remove(i: number): void {
    const m = this.members[i];
    const last = this.members.length - 1;
    this.members[i] = this.members[last];
    this.states[i] = this.states[last];
    this.kinds[i] = this.kinds[last]!;
    this.members.pop();
    this.states.pop();
    this.kinds.pop();
    this.byId.delete(m.id);
    this.onDeath?.(m);
    this.lineages.died(m.founderId);
    this.journal?.died.push(m.id);
    this.spare[m.species]!.push(m);
    this.deaths++;
    const count = this.counts[m.species]!;
    count.population--;
    count.deaths++;
  }

  private regrow(): void {
    this.foodDue += this.config.eco.seasons ? this.foodPerTick * seasonFactor(this.config.eco, this.tick * this.config.dt) : this.foodPerTick;
    this.poisonDue += this.poisonPerTick;
    for (; this.foodDue >= 1; this.foodDue--) if (this.food < this.foodCap) this.food += this.grow(HIT_FOOD);
    for (; this.poisonDue >= 1; this.poisonDue--) if (this.poison < this.poisonCap) this.poison += this.grow(HIT_POISON);
  }

  // Places one item at a uniform random position; returns 1, or 0 if no slot was free.
  private grow(kind: HitKind): number {
    const r = this.config.world.itemRadius;
    const { width, height } = this.config.world;
    return this.items.addItem(this.rng.range(r, width - r), this.rng.range(r, height - r), kind) >= 0 ? 1 : 0;
  }

  // Copies every living creature into frame, growing its arrays when needed.
  readCreatures(frame?: CreatureFrame): CreatureFrame {
    const n = this.members.length;
    if (!frame || frame.ids.length < n) {
      const size = Math.max(n, 64, frame ? 2 * frame.ids.length : 0);
      frame = {
        count: 0,
        ids: new Int32Array(size),
        x: new Float32Array(size),
        y: new Float32Array(size),
        heading: new Float32Array(size),
        energy: new Float32Array(size),
        hue: new Float32Array(size),
        founder: new Int32Array(size),
        species: new Int32Array(size),
      };
    }
    for (let i = 0; i < n; i++) {
      const m = this.members[i];
      const s = this.states[i];
      frame.ids[i] = m.id;
      frame.x[i] = s.x;
      frame.y[i] = s.y;
      frame.heading[i] = s.heading;
      frame.energy[i] = s.energy;
      frame.hue[i] = m.hue;
      frame.founder[i] = m.founderId;
      frame.species[i] = m.species;
    }
    frame.count = n;
    return frame;
  }

  // The founder's own colour, degrees.
  founderColour(founder: number): number {
    return this.lineages.colour(founder);
  }

  // True when the founder came from the seed pool.
  fromPool(founder: number): boolean {
    return this.lineages.fromPool(founder);
  }

  // Living creatures descended from this founder.
  lineageSize(founder: number): number {
    return this.lineages.size(founder);
  }

  // The k largest living lineages, of one species or of all (-1), biggest first.
  topLineages(k: number, species = -1): Lineage[] {
    return this.lineages.top(k, species);
  }

  // Hash of the counts and every creature's id, position and energy; equal runs give equal fingerprints.
  fingerprint(): number {
    const P = 1_000_000_007;
    let h = (this.tick * 31 + this.births) % P;
    for (const v of [this.deaths, this.food, this.poison, this.members.length]) h = (h * 31 + v) % P;
    for (let i = 0; i < this.members.length; i++) {
      const s = this.states[i];
      h = (h * 31 + this.members[i].id) % P;
      h = (h * 31 + (Math.round(s.x * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.y * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.energy * 1000) % P)) % P;
    }
    return h;
  }
}
