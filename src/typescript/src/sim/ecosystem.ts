import { genomeLength, layerSizes, randomGenome, refit } from "./brain.ts";
import { itemCounts, itemsPerDensity } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { Creature, SenseBatch, senseThinkBatch } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { mutate } from "./ga.ts";
import { driftPlan, mutateStructure, randomPlan, remapWeights } from "./planMutation.ts";
import { collide, hurt, keepInside, settle } from "./physics.ts";
import type { Aging, Contact } from "./physics.ts";
import { createRng, deriveSeed } from "./rng.ts";
import type { StatefulRng } from "./rng.ts";
import { copyPlan, inputLayout, planOf } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { trialsToEcoGenome } from "./seedPool.ts";
import type { PoolEntry } from "./seedPool.ts";
import { bandHue, speciesEngine, speciesList, speciesRanges } from "./species.ts";
import type { SpeciesConfig } from "./species.ts";
import { HIT_FOOD, HIT_POISON } from "./types.ts";
import type { CreatureState, Genome, HitKind, WorldView } from "./types.ts";
import { World } from "./world.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";

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

// One founder's family among the living.
export interface Lineage {
  founder: number;
  hue: number; // the founder's own colour, degrees
  pool: boolean; // the founder came from the seed pool
  count: number; // living descendants, the founder included
  species: number; // the founder's species, so all its descendants'
}

// All creatures in one shared world. Each tick has two phases:
// 1. sensePhase: every creature senses a snapshot (items, and creatures as gridded at the tick start) and thinks; then each
//    updates its memory and moves. Sensing and thinking write only the creature's own rays and outputs, so creature order
//    cannot matter and helper threads can run them (ecoShare.ts).
// 2. sharedPhase: eating, hunting, collisions (with optional damage), deaths, births and regrowth, serially. Eating, hunting and births
//    walk the creatures from a random start each tick, so no creature wins contested food, prey or the last free place by its list position.
// With a species list (Predators & prey) every creature belongs to one species, with that species' body, costs, births and
// diet; a hunter eats a touching creature of a species it preys on. Without one there is a single implicit species.
export class Ecosystem {
  readonly config: EcoConfig;
  readonly world: WorldView;
  tick = 0;
  births = 0;
  deaths = 0;
  readonly poolFounders: number; // founders taken from the seed pool, the first ones of each species in id order
  readonly founders: number; // founders are ids 0 .. founders-1, species by species
  readonly species: readonly SpeciesConfig[];
  food = 0;
  poison = 0;
  // Living creatures in list order; states[i] is members[i].creature.state.
  readonly members: EcoCreature[] = [];
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
  private readonly cooldowns: number[]; // per species, in ticks
  private readonly counts: SpeciesCount[];
  private readonly kinds: number[] = []; // kinds[i] is members[i].species
  private readonly multi: boolean; // more than one species, so rays tell species apart
  private readonly hunters: boolean; // some species eats another
  private readonly rng: StatefulRng;
  // Scratch of one birth, grown as plans need: the child's plan, its genome, and the parent's weights remapped to a new shape.
  private readonly childPlan: BodyPlan;
  private childGenome = new Float32Array(0);
  private remapped = new Float32Array(0);
  private readonly mutation: { mutationRate: number; mutationStd: number };
  private readonly foodCap: number;
  private readonly poisonCap: number;
  private readonly foodPerTick: number;
  private readonly poisonPerTick: number;
  private foodDue = 0; // fractional items accumulated by regrowth
  private poisonDue = 0;
  private nextId = 0;
  // Living creatures per founder and each founder's colour, indexed by founder id; updated on birth and death only.
  private readonly lineageLive: Int32Array;
  private readonly founderHue: Float32Array;
  private readonly founderSpecies: Int32Array;
  private readonly founderPool: Uint8Array;
  private readonly aging: Aging | null;
  private readonly contact: Contact = { speed: 0 };

  // pool: trained founders (see seedPool.ts); without one, or at poolFraction 0, every founder is random.
  constructor(config: EcoConfig, pool: readonly PoolEntry[] | null = null, options: { journal?: boolean } = {}) {
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
    this.engines = this.species.map((_, s) => speciesEngine(config, s));
    this.ranges = this.species.map((sp) => (config.species?.length ? speciesRanges(config, sp) : eco));
    this.cooldowns = this.species.map((sp) => Math.round(sp.birthCooldown / dt));
    this.counts = this.species.map(() => ({ population: 0, births: 0, deaths: 0, eaten: 0 }));
    this.spare = this.species.map(() => []);
    this.rng = createRng(deriveSeed(config.seed, 0xec0));
    this.aging = eco.aging ? { startTicks: Math.round(eco.agingStart / dt), perTick: (eco.agingRate * dt) / 60 } : null;
    this.items = new World(config, Math.max(start.food, this.foodCap) + Math.max(start.poison, this.poisonCap));
    this.world = this.items;
    this.journal = options.journal ? { born: [], died: [], items: [] } : null;
    this.items.log = this.journal?.items ?? null;
    this.items.scatter(start.food, start.poison, this.rng);
    this.food = start.food;
    this.poison = start.poison;
    const wanted = this.species.reduce((n, sp) => n + Math.max(0, sp.founders), 0);
    this.crowd = new Crowd(config, Math.min(wanted, eco.maxPopulation));
    this.kernels = eco.wasm ? SenseKernels.create() : null;
    this.childPlan = planOf(config);
    this.mutation = { mutationRate: config.mutation.rate, mutationStd: config.mutation.std };

    const { width, height } = config.world;
    const r = config.creature.radius;
    const founders = Math.max(0, Math.min(wanted, eco.maxPopulation));
    const seeds = pool?.length ? pool.map((e) => (config.creature.seesCreatures ? trialsToEcoGenome(e.plan, e.genome, config) : e.genome)) : [];
    const randomPlanScratch = this.childPlan;
    this.founders = founders;
    this.lineageLive = new Int32Array(founders);
    this.founderHue = new Float32Array(founders);
    this.founderSpecies = new Int32Array(founders);
    this.founderPool = new Uint8Array(founders);
    let poolFounders = 0;
    let i = 0;
    for (let sp = 0; sp < this.species.length; sp++) {
      const spec = this.species[sp]!;
      const count = Math.min(Math.max(0, spec.founders), founders - i);
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
          mutate(genome, this.mutation, this.rng);
          this.founderPool[i] = 1;
        } else {
          if (eco.foundersVary) randomPlan(this.ranges[sp]!, this.rng, randomPlanScratch);
          genome = randomGenome(layerSizes(config, plan), this.rng);
        }
        const x = this.rng.range(r, width - r);
        const y = this.rng.range(r, height - r);
        const m = this.spawn(genome, plan, x, y, this.rng.next() * 2 * Math.PI, spec.startEnergy, sp);
        const hue = spec.hue < 0 ? this.rng.next() * 360 : bandHue(spec, spec.hue + (this.rng.next() - 0.5) * spec.hueSpread);
        m.hue = this.founderHue[i] = hue;
        this.founderSpecies[i] = sp;
      }
      poolFounders += fromPool;
    }
    this.poolFounders = poolFounders;
    // Poison moves only once every founder stands, and never onto one, so none ends up on a founder placed earlier.
    const reach = r + config.world.itemRadius;
    const states = this.states;
    const onFounder = (px: number, py: number): boolean => states.some((s) => (s.x - px) ** 2 + (s.y - py) ** 2 < reach * reach);
    for (const s of states) this.items.clearPoison(s.x, s.y, r, this.rng, onFounder);
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
    this.crowd.rebuild(this.states, this.states.length, this.multi ? this.kinds : undefined);
  }

  // Phase 1a for members start .. end-1, after prepareTick: sense and think into each creature's outputs.
  sensePhase(start: number, end: number): void {
    const batch = this.batch;
    batch.clear();
    for (let i = start; i < end; i++) batch.add(this.members[i].creature, i);
    this.senseBatch(batch);
  }

  // Phase 1a for a batch of members, each at its list index, after prepareTick.
  senseBatch(batch: SenseBatch): void {
    senseThinkBatch(this.items, this.crowd, batch, this.kernels);
  }

  // Phase 1b and 2, once every creature has its outputs (from sensePhase or helper threads): memory and motion, then sharedPhase.
  finishTick(): void {
    for (const m of this.members) {
      m.creature.remember();
      m.creature.steer();
    }
    this.sharedPhase();
  }

  // Phase 2, after every creature moved.
  private sharedPhase(): void {
    const members = this.members;
    let n = members.length;
    let first = this.rng.int(n);
    for (let k = 0; k < n; k++) {
      const m = members[(first + k) % n];
      if (!this.species[m.species]!.plants) continue;
      const eaten = m.creature.eat(this.items);
      if (eaten < 0) continue;
      if (this.items.kinds[eaten] === HIT_FOOD) {
        this.food--;
        m.eaten++;
      } else this.poison--;
      this.items.removeItem(eaten); // so no one else eats it this tick
    }

    if (this.hunters) this.hunt();
    if (this.config.eco.collisions) this.collideAll();

    for (let i = n - 1; i >= 0; i--) {
      settle(this.states[i]);
      if (!this.states[i].alive) this.remove(i);
    }

    n = members.length;
    first = n > 0 ? this.rng.int(n) : 0;
    const eco = this.config.eco;
    for (let k = 0; k < n && members.length < eco.maxPopulation; k++) {
      const parent = members[(first + k) % n];
      const energy = parent.creature.state.energy;
      const sp = this.species[parent.species]!;
      // Above birthCost too, so a birth never kills the parent whatever the settings.
      if (energy >= sp.birthEnergy && energy > sp.birthCost && this.tick - parent.lastBirthTick >= this.cooldowns[parent.species]!) this.giveBirth(parent);
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
      hunter.kills++;
      this.counts[members[best]!.species]!.eaten++;
    }
  }

  // Pushes overlapping pairs apart with a bounce, using a grid of the moved positions. Pairs resolve in grid order.
  private collideAll(): void {
    const crowd = this.crowd;
    const states = this.states;
    crowd.rebuild(states, states.length);
    const { cols, rows, cellStart, owners } = crowd;
    const { radius } = this.config.creature;
    const { width, height } = this.config.world;
    const e = 1; // restitution
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
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
  }

  private bumpCell(a: CreatureState, cell: number, radius: number, e: number, width: number, height: number): void {
    const { cellStart, owners } = this.crowd;
    for (let t = cellStart[cell]; t < cellStart[cell + 1]; t++) this.bump(a, this.states[owners[t]], radius, e, width, height);
  }

  private bump(a: CreatureState, b: CreatureState, radius: number, e: number, width: number, height: number): void {
    const eco = this.config.eco;
    if (!collide(a, b, radius, e, this.contact)) return;
    if (eco.collisionDamage) hurt(a, b, this.contact.speed, eco.damagePerSpeed);
    keepInside(a, radius, width, height, this.config.creature.wallBounce);
    keepInside(b, radius, width, height, this.config.creature.wallBounce);
  }

  private giveBirth(parent: EcoCreature): void {
    const { eco, creature: cc, world: w } = this.config;
    const sp = this.species[parent.species]!;
    const ranges = this.ranges[parent.species]!;
    const ps = parent.creature.state;
    ps.energy -= sp.birthCost;
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
    mutate(genome, this.mutation, this.rng);
    const angle = this.rng.next() * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const gap = 2 * cc.radius + 1; // just clear of the parent
    const child = this.spawn(genome, plan, ps.x + cos * gap, ps.y + sin * gap, angle, sp.childEnergy, parent.species);
    const s = child.creature.state;
    s.vx = cos * eco.birthSpeed;
    s.vy = sin * eco.birthSpeed;
    keepInside(s, cc.radius, w.width, w.height, cc.wallBounce);
    child.parentId = parent.id;
    child.founderId = parent.founderId;
    this.lineageLive[child.founderId]!++;
    child.depth = parent.depth + 1;
    child.hue = bandHue(sp, parent.hue + this.rng.normal() * eco.hueDrift);
    this.births++;
    this.counts[parent.species]!.births++;
  }

  // Adds a creature, reusing a dead one's storage when there is one; genome and plan are copied, except a founder's genome for a new creature.
  private spawn(genome: Genome, plan: PlanView, x: number, y: number, heading: number, energy: number, species: number): EcoCreature {
    let m = this.spare[species]!.pop();
    if (m) m.creature.reset(genome, x, y, heading, energy, plan);
    else {
      m = new EcoCreature(new Creature(this.engines[species]!, genome === this.childGenome ? genome.slice() : genome, x, y, heading, plan));
      m.creature.state.energy = energy;
    }
    m.species = species;
    this.counts[species]!.population++;
    m.id = this.nextId++;
    m.founderId = m.id; // a child overwrites this
    m.creature.aging = this.aging;
    if (m.id < this.founders) this.lineageLive[m.id] = 1;
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
    this.lineageLive[m.founderId]!--;
    this.journal?.died.push(m.id);
    this.spare[m.species]!.push(m);
    this.deaths++;
    const count = this.counts[m.species]!;
    count.population--;
    count.deaths++;
  }

  private regrow(): void {
    this.foodDue += this.foodPerTick;
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
    return this.founderHue[founder] ?? 0;
  }

  // True when the founder came from the seed pool.
  fromPool(founder: number): boolean {
    return this.founderPool[founder] === 1;
  }

  // Living creatures descended from this founder.
  lineageSize(founder: number): number {
    return this.lineageLive[founder] ?? 0;
  }

  // The k largest living lineages, of one species or of all (-1), biggest first, ties to the lowest founder id. Scans the founders, not the creatures.
  topLineages(k: number, species = -1): Lineage[] {
    const top: Lineage[] = [];
    for (let f = 0; f < this.founders; f++) {
      const count = this.lineageLive[f]!;
      if (count === 0 || (species >= 0 && this.founderSpecies[f] !== species) || (top.length === k && count <= top[k - 1]!.count)) continue;
      const entry = { founder: f, hue: this.founderHue[f]!, pool: this.founderPool[f] === 1, count, species: this.founderSpecies[f]! };
      let at = top.length;
      while (at > 0 && top[at - 1]!.count < count) at--;
      top.splice(at, 0, entry);
      if (top.length > k) top.pop();
    }
    return top;
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
