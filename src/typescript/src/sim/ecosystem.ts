import { wrapAngle } from "./angle.ts";
import { genomeLength, layerSizes, randomGenome, refit } from "./brain.ts";
import { itemCounts } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { Creature, SenseBatch, senseThinkBatch, thinkersOf } from "./creature.ts";
import { Crowd } from "./crowd.ts";
import { startRng } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import { mutate } from "./ga.ts";
import { driftBirth, driftPlan, mutateStructure, randomBirth, randomPlan, remapWeights } from "./planMutation.ts";
import type { BirthTraits } from "./planMutation.ts";
import { agingOf, settle } from "./physics.ts";
import { terrainOf } from "./terrain.ts";
import { SMALL_SORT } from "./crowd.ts";
import { WasmCrowd } from "./wasm/crowdKernel.ts";
import { WasmMembers } from "./wasm/membersKernel.ts";
import type { ResidentStore } from "./wasm/resident.ts";
import { advanceBodies, senseThinkRows } from "./wasm/residentStep.ts";
import type { Aging } from "./physics.ts";
import type { StatefulRng } from "./rng.ts";
import { copyPlan, inputLayout, planOf } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { Contacts } from "./contacts.ts";
import { checkInsert } from "./ecoInsert.ts";
import type { InsertResult, InsertSpec } from "./ecoInsert.ts";
import { ItemEconomy, capsOf } from "./itemEconomy.ts";
import { Lineages } from "./lineages.ts";
import { MemberTable } from "./memberTable.ts";
import { checkRetune } from "./retune.ts";
import type { RetunePatch, RetuneResult } from "./retune.ts";
import { trialsToEcoGenome } from "./seedPool.ts";
import type { PoolEntry } from "./seedPool.ts";
import { bandHue, founderCounts, seenEnergyScale, speciesEngine, speciesList, speciesRanges } from "./species.ts";
import type { Species } from "./species.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "./types.ts";
import type { CreatureState, Genome, HitKind, WorldView } from "./types.ts";
import { World } from "./world.ts";
import { SenseKernels } from "./wasm/senseKernels.ts";
import { MAX_RAYS } from "./wasm/senser.ts";
import type { PhaseTimer } from "./profile.ts";

const SMALL_SCAN = 32; // up to this many members the settle and birth scans run in JS: RL episodes have 1-31 creatures, so the kernel pays only for crowds
const SPARE_LOOK = 16; // dead creatures looked at for one whose brain has the newborn's size

export { BIG_IMPACT, EVENT_CAP, EVENT_DEATH, EVENT_IMPACT, EVENT_STRIDE } from "./contacts.ts";
export { MAX_INSERT_ENERGY, MAX_INSERT_LAYERS, MAX_INSERT_MEMORY, MAX_INSERT_NEURONS, MAX_INSERT_RAYS, MAX_INSERT_RAY_LENGTH, MAX_NAME_LENGTH, MUTATION_SCALE_RANGE } from "./ecoInsert.ts";
export type { InsertResult, InsertSpec } from "./ecoInsert.ts";
export type { Lineage } from "./lineages.ts";

// An item placed as given (RL environments with a layout), instead of the scattered start items.
export interface ItemSpot {
  x: number;
  y: number;
  kind: HitKind;
}

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

// One creature of the ecosystem with its family record. Objects are recycled after death, so hold ids, not references.
export class EcoCreature {
  id = 0;
  parentId = -1; // -1 for a founder
  depth = 0; // generations since its founder
  birthTick = 0;
  children = 0;
  eaten = 0; // food items eaten, poison not counted
  kills = 0; // prey eaten (hunts only, so an RL kill reward never pays a bump)
  bumpKills = 0; // creatures that died in a bump it survived (collision damage)
  species = 0; // index into the config's species; children keep their parent's
  hue = 0; // degrees
  founderId = 0; // id of the founder this family descends from; a founder is its own
  lastBirthTick = -Infinity;
  // Heritable birth traits (#31): energy at which it has a child, energy it pays (the child's start energy), seconds between births.
  birth: BirthTraits = { energy: 0, cost: 0, cooldown: 0 };
  cooldownTicks = 0;
  mutationScale = 1; // multiplies the mutation std of its children's genomes; a child keeps its parent's, only an insert sets another
  index = 0; // position in the ecosystem's member list
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

// Scalars of a run for saveState (ecoState.ts).
export interface EcoCore {
  tick: number; births: number; deaths: number; foodEaten: number; poisonEaten: number; food: number; poison: number;
  rngState: number; foodDue: number; poisonDue: number; nextId: number; founders: number; poolFounders: number; itemCapacity: number;
  counts: SpeciesCount[];
}

// Everything restoreMember needs of one creature.
export interface MemberRecord {
  id: number; parentId: number; depth: number; birthTick: number; children: number; eaten: number; kills: number; species: number; hue: number;
  founderId: number; lastBirthTick: number; birthEnergy: number; birthCost: number; birthCooldown: number; cooldownTicks: number;
  mutationScale?: number; // 1 when left out
  bumpKills?: number; // 0 when left out
  x: number; y: number; heading: number; vx: number; vy: number; turnRate: number; energy: number; ticksAlive: number; cos: number; sin: number;
  plan: PlanView; genome: Float32Array; memory: ArrayLike<number>;
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
// With a species list every creature belongs to one species, with that species' body, costs, births and
// diet; a hunter eats a touching creature of a species it preys on. Without one there is a single species with the shared settings.
const MAX_ROCK_TRIES = 200; // random founder spots tried before taking the nearest free one

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
  // Living creatures in list order.
  readonly members: EcoCreature[];
  // Genome weights of all living creatures, and the most births may bring it to: a birth waits while weights is above birthWeightCap.
  // Not a setting and not saved: Live World sets the cap so every save stays small enough to write and read back (server/src/config.ts).
  weights = 0;
  birthWeightCap = Infinity;
  // Id of a creature whose rays and brain input must be current after each tick (the selected one); the WASM sense leaves everyone else's stale.
  detail: number | null = null;
  // With the journal option: changes not yet drained by a helper coordinator (ecoShare.ts). born and died hold ids, items World.log records.
  journal: EcoJournal | null;

  private readonly items: World;
  private readonly crowd: Crowd;
  private hits = new Int32Array(0); // members touching an item this tick, ascending
  private readonly batch = new SenseBatch();
  private readonly thinkBatch = new SenseBatch(); // the part of a JS batch that thinks this tick (eco.thinkEvery)
  private readonly idOf = (self: number): number => this.members[self]!.id;
  private readonly kernels: SenseKernels | null; // with eco.wasm when WebAssembly SIMD is available
  private readonly wasmCrowd: WasmCrowd | null; // the crowd grid built in WebAssembly from the rows (crowdKernel.ts), when the rows are resident
  private gridVersion = -1; // table.version when wasmCrowd last built the grid
  private readonly wasmMembers: WasmMembers | null; // the settle and birth scans over the rows in WebAssembly (membersKernel.ts)
  private readonly resident: ResidentStore | null; // creature bodies as rows of the kernel memory, which the fill kernel reads
  private readonly table: MemberTable; // members and the columns kept with them
  private readonly economy: ItemEconomy; // food and poison: counts, caps, regrowth
  private readonly contacts: Contacts; // eating, hunting and collisions
  private readonly spare: EcoCreature[][]; // per species, since a creature keeps its species' engine config
  private readonly engines: EngineConfig[]; // per species
  private readonly ranges: EcoConfig["eco"][]; // per species, for plan variation
  private readonly counts: SpeciesCount[];
  private readonly multi: boolean; // more than one species, so rays tell species apart
  private readonly hunters: boolean; // some species eats another
  private lookups = new Int32Array(0); // the item each creature touches, by list index
  private readonly rng: StatefulRng;
  // Scratch of one birth, grown as plans need: the child's plan, its genome, and the parent's weights remapped to a new shape.
  private readonly childPlan: BodyPlan;
  private childGenome = new Float32Array(0);
  private remapped = new Float32Array(0);
  private nextId = 0;
  private readonly spot = { x: 0, y: 0, vx: 0, vy: 0 }; // scratch of a newborn's place
  private spent = false; // a parent gave its last energy to a child this tick
  private readonly traits: BirthTraits = { energy: 0, cost: 0, cooldown: 0 }; // scratch of one birth
  readonly lineages: Lineages;
  private aging: Aging | null;
  onDeath: ((m: EcoCreature) => void) | null = null; // called with each creature as it leaves, before its object is recycled
  // Called for each lethal bump that leaves one survivor, with both creature states (members' kills count hunts only).
  get onBumpKill(): ((survivor: CreatureState, victim: CreatureState) => void) | null {
    return this.contacts.onBumpKill;
  }
  set onBumpKill(f: ((survivor: CreatureState, victim: CreatureState) => void) | null) {
    this.contacts.onBumpKill = f;
  }
  profile: PhaseTimer | null = null; // per-phase CPU laps, set by ecoBench --profile

  // pool: trained founders (see seedPool.ts); without one, or at poolFraction 0, every founder is random.
  // cast: exactly these founders instead of the species' founder counts; items: exactly these start items (RL environments, see rl/env.ts).
  // restore: builds the world empty, for restoreState (ecoState.ts) to fill: no founders and no items, the founder count and item capacity of the saved run.
  constructor(
    config: EcoConfig,
    pool: readonly PoolEntry[] | null = null,
    options: { journal?: boolean; cast?: readonly CastMember[]; items?: readonly ItemSpot[]; restore?: { founders: number; poolFounders: number; itemCapacity: number }; kernels?: SenseKernels } = {},
  ) {
    const restore = options.restore;
    this.config = config;
    const { eco, dt } = config;
    const layout = options.items;
    const start = layout ? { food: layout.filter((it) => it.kind === HIT_FOOD).length, poison: layout.filter((it) => it.kind === HIT_POISON).length } : itemCounts(config);
    const { spawn } = terrainOf(config);
    if (!layout) {
      if (!spawn.usable(0)) start.food = 0; // a kind with no weight anywhere on the map starts and grows nowhere
      if (!spawn.usable(1)) start.poison = 0;
    }
    const caps = capsOf(config, eco);
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
    this.items = new World(config, restore?.itemCapacity ?? Math.max(start.food, caps.food) + Math.max(start.poison, caps.poison));
    this.world = this.items;
    this.economy = new ItemEconomy(config, this.items, this.rng, caps);
    this.journal = options.journal ? { born: [], died: [], items: [] } : null;
    this.items.log = this.journal?.items ?? null;
    if (layout && !restore) layout.forEach((it, i) => this.items.setItem(i, it.x, it.y, it.kind));
    else this.items.scatter(restore ? 0 : start.food, restore ? 0 : start.poison, this.rng);
    this.economy.food = start.food;
    this.economy.poison = start.poison;
    const cast = options.cast;
    const counts = cast || restore ? this.species.map(() => 0) : founderCounts(this.species, eco.maxPopulation);
    const founders = cast ? cast.length : counts.reduce((a, b) => a + b, 0);
    this.crowd = new Crowd(config, founders);
    // Plans past the kernel's ray limit (a huge ray count setting or pool entry) run on the JS path.
    const maxRays = Math.max(config.creature.rayCount, ...this.ranges.map((r) => r.rayCountRange[1] ?? 0), ...(pool ?? []).map((e) => e.plan.rayCount), ...(cast ?? []).map((c) => c.plan.rayCount));
    // options.kernels: instances to reuse (RL), reset here; the caller owns them and runs one Ecosystem on them at a time.
    this.kernels = !eco.wasm ? null : options.kernels && maxRays <= MAX_RAYS ? options.kernels.reset(config) : SenseKernels.create(config, maxRays);
    this.resident = this.kernels?.store ?? null;
    this.table = new MemberTable(this.resident !== null);
    this.members = this.table.members;
    this.contacts = new Contacts(config, this.items, this.crowd, this.table, this.species, this.counts, this.rng);
    if (this.resident) this.resident.species.push(...this.engines); // the configs the rows' species indices stand for
    this.wasmCrowd = this.resident ? WasmCrowd.create(this.resident, this.crowd) : null;
    this.wasmMembers = this.resident ? WasmMembers.create(this.resident) : null;
    this.childPlan = planOf(config);

    const { width, height } = config.world;
    const r = config.creature.radius;
    const seeds = pool?.length ? pool.map((e) => (config.creature.seesCreatures ? trialsToEcoGenome(e.plan, e.genome, config) : e.genome)) : [];
    const randomPlanScratch = this.childPlan;
    this.founders = restore?.founders ?? founders;
    this.lineages = new Lineages(this.founders);
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
        let x = this.rng.range(r, width - r);
        let y = this.rng.range(r, height - r);
        for (let tries = 0; !this.economy.startOk(x, y, r); tries++) {
          if (tries >= MAX_ROCK_TRIES) {
            ({ x, y } = this.items.terrain.nearestFree(x, y, r)); // a map that leaves no room is not allowed to hang the build
            break;
          }
          x = this.rng.range(r, width - r);
          y = this.rng.range(r, height - r);
        }
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
    this.poolFounders = restore?.poolFounders ?? poolFounders;
    // Poison moves only once every founder stands, and never onto one, so none ends up on a founder placed earlier.
    const reach = r + config.world.itemRadius;
    this.gridCrowd(this.table.length);
    const onFounder = (px: number, py: number): boolean => this.crowd.anyWithin(px, py, reach);
    for (const s of this.table.states) this.items.clearPoison(s.x, s.y, r, this.rng, onFounder);
  }

  // Makes food invisible to every creature's rays, or visible again; eating is unchanged (RL memory envs, which run with wasm off).
  // The WASM sense kernel walks its own packed item copy and would still see food, so hiding needs the JS path.
  setFoodHidden(hidden: boolean): void {
    if (hidden && this.kernels) throw new Error("hiding food needs the JS sense path (eco.wasm false)");
    this.items.foodHidden = hidden;
  }

  // Items of each kind in the world now.
  get food(): number { return this.economy.food; }
  set food(v: number) { this.economy.food = v; }
  get poison(): number { return this.economy.poison; }
  set poison(v: number) { this.economy.poison = v; }

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
    return this.table.byId.get(id);
  }

  step(): void {
    if (this.extinct) return;
    const prof = this.profile;
    prof?.start();
    this.prepareTick();
    prof?.lap("crowd grid");
    this.sensePhase();
    prof?.lap("sense and think, rest");
    this.finishTick();
  }

  // The rows of the members' bodies and rowAt (member index to f64 index of its row), for the helper coordinator's bulk copies; null without resident bodies.
  residentRows(): { store: ResidentStore; rowAt: Int32Array } | null {
    return this.resident ? { store: this.resident, rowAt: this.table.rowAt } : null;
  }

  // Helper threads with resident bodies: the whole sense batch, as row addresses and member indices (n entries each), valid until the next spawn or removal.
  senseBatchRows(): { rows: Int32Array; selves: Int32Array; n: number } {
    return { rows: this.table.slotRows, selves: this.table.slotSelves, n: this.table.bySlot.length };
  }

  // Phase 1a for the resident bodies at selves, after prepareTick: those of them that think this tick (eco.thinkEvery) sense and think.
  senseRows(rows: Int32Array, selves: Int32Array, n: number): void {
    const kernels = this.kernels!;
    kernels.detail = this.detail === null ? null : (this.table.byId.get(this.detail)?.creature ?? null);
    senseThinkRows(kernels, this.items, this.crowd, rows, selves, n, this.tick, this.config.eco.thinkEvery, this.idOf, kernels.detail, this.profile);
  }

  // Phase 1b for the resident bodies at selves: memory and motion, and the item each touches into touched[self].
  advanceRows(rows: Int32Array, selves: Int32Array, n: number, touched: Int32Array): void {
    advanceBodies(this.kernels!, rows, selves, n, this.aging, this.items, this.config.creature.radius, touched);
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

  private gridCrowd(n: number, species?: Int32Array): void {
    const wasm = this.wasmCrowd;
    if (wasm && n > SMALL_SORT) {
      wasm.rebuild(this.table.rowAt, n, species);
      this.gridVersion = this.table.version;
    } else this.crowd.rebuild(this.table.states, n, species);
  }

  // Grids the creatures as they stand at the tick start, for sensePhase.
  prepareTick(): void {
    if (this.table.length < 2 && this.crowd.count < 2) return; // a lone creature, or none, only sees itself in a grid of at most itself
    const n = this.table.length;
    const species = this.multi ? this.table.kinds : undefined;
    // No one came or went since the last WebAssembly grid (sharedPhase's): its order still holds unless someone changed cell, and the rest is re-read.
    if (this.table.version === this.gridVersion && n > SMALL_SORT && this.wasmCrowd?.refresh(this.table.rowAt, n, species)) return;
    this.gridCrowd(n, species);
  }

  // Phase 1a for every member, after prepareTick: sense and think into each creature's outputs.
  sensePhase(): void {
    if (this.kernels) {
      // Resident bodies: the batch is the maintained row list, nothing to gather per creature.
      this.profile?.lap("batch build");
      this.senseRows(this.table.slotRows, this.table.slotSelves, this.members.length);
      return;
    }
    const batch = this.batch;
    batch.clear();
    for (const m of this.table.bySlot) batch.add(m.creature, m.index);
    batch.sorted = true;
    this.profile?.lap("batch build");
    this.senseBatch(batch);
  }

  // Brings the detail creature's rays and brain input up to date outside a tick (display only, on the JS path): on selecting it,
  // or while paused. Rebuilds the crowd grid, which every tick does first anyway, and leaves the simulation state alone.
  refreshDetail(): void {
    const i = this.detail === null ? -1 : this.members.findIndex((m) => m.id === this.detail);
    if (i < 0) return;
    this.gridCrowd(this.table.length, this.multi ? this.table.kinds : undefined);
    const c = this.members[i]!.creature;
    c.sense(this.items, this.crowd, i);
    c.encode();
  }

  // Phase 1a for a batch of members on the JS path, each at its list index, after prepareTick: those that think this tick (eco.thinkEvery).
  senseBatch(batch: SenseBatch): void {
    senseThinkBatch(this.items, this.crowd, thinkersOf(batch, this.thinkBatch, this.tick, this.config.eco.thinkEvery, this.idOf), this.profile);
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
      if (this.kernels) this.kernels.stepper.step(this.table.slotRows, this.members.length, this.aging, this.items.terrain);
      else {
        // The batch holds every member in creature construction order: the objects are read front to back.
        const { creatures, count } = this.batch;
        for (let k = 0; k < count; k++) {
          const c = creatures[k]!;
          c.remember();
          c.steer();
        }
      }
      this.profile?.lap("memory and steer");
    }
    this.sharedPhase(touched);
  }

  // Phase 2, after every creature moved.
  private sharedPhase(touched?: Int32Array): void {
    const members = this.members;
    let n = members.length;
    // Eating and hunting move no one, so the moved positions are gridded once, here, for the item lookups (in cell order, so
    // neighbours read the same cells), hunting and collisions.
    const eco = this.config.eco;
    const gridded = (eco.collisions || this.hunters) && n > 0;
    if (gridded) {
      this.gridCrowd(n, this.table.kinds);
      if (!touched) {
        const crowd = this.crowd;
        touched = this.lookups = refit(this.lookups, n);
        const tables = crowd.kernel ? this.kernels!.itemTables(this.items) : null;
        if (tables) crowd.kernel!.touch(tables, this.items.rows, 1 / this.items.cell, this.config.creature.radius + this.items.itemRadius, touched); // twin of touchedBatch
        else this.items.touchedBatch(crowd.xs, crowd.ys, crowd.owners, n, this.config.creature.radius, touched);
      }
    }
    let first = this.rng.int(n);
    if (touched) {
      // Only creatures touching an item can eat: list them, then walk the list from the random start, in the same order as a walk
      // over every member.
      const hits = (this.hits = refit(this.hits, n));
      let h = 0;
      let from = 0;
      for (let at = 0; at < n; at++) {
        if (touched[at]! < 0) continue;
        if (at < first) from++;
        hits[h++] = at;
      }
      for (let k = 0; k < h; k++) {
        let q = from + k;
        if (q >= h) q -= h;
        this.eat(hits[q]!, touched);
      }
    } else {
      for (let k = 0; k < n; k++) this.eat((first + k) % n);
    }

    const prof = this.profile;
    prof?.lap("eat");
    if (this.hunters) this.contacts.hunt();
    prof?.lap("hunt");
    if (eco.collisions) this.contacts.collideAll();
    prof?.lap("collisions");

    const scan = n > SMALL_SCAN ? this.wasmMembers : null; // a kernel call costs about 0.4 us, the loops below 0.01 us a member
    if (scan) {
      // the scan counts the tick for everyone with energy left and lists the others, highest first
      const dying = scan.settle(this.table.rowAt, n);
      for (let k = 0; k < dying.length; k++) this.settleAt(dying[k]!);
    } else for (let i = n - 1; i >= 0; i--) this.settleAt(i);
    this.contacts.endTick();
    prof?.lap("settle and deaths");

    n = members.length;
    first = n > 0 ? this.rng.int(n) : 0;
    const birthCap = eco.maxPopulation - eco.birthReserve;
    // The energy test reads no creature object: table.states[i] is members[i].creature.state and table.birthEnergies[i] its birth energy. Births replace the table's arrays when they fill up.
    if (scan) {
      // only the members with energy for a child, in the order of the walk from first; births change no one else's energy
      const ready = scan.birthCandidates(this.table.rowAt, n, this.table.birthEnergies, first);
      for (let k = 0; k < ready.length && members.length < birthCap && this.weights <= this.birthWeightCap; k++) {
        const parent = members[ready[k]!]!;
        if (this.tick - parent.lastBirthTick >= parent.cooldownTicks) this.giveBirth(parent);
      }
    } else for (let k = 0; k < n && members.length < birthCap && this.weights <= this.birthWeightCap; k++) {
      const at = (first + k) % n;
      if (this.table.states[at]!.energy < this.table.birthEnergies[at]!) continue;
      const parent = members[at]!;
      if (this.tick - parent.lastBirthTick >= parent.cooldownTicks) this.giveBirth(parent);
    }
    if (this.spent) {
      // Parents that gave all they had are gone.
      for (let i = members.length - 1; i >= 0; i--) if (!this.table.states[i]!.alive) this.remove(i);
      this.spent = false;
    }
    prof?.lap("births");

    this.economy.regrow(this.tick);
    prof?.lap("regrow");
    this.tick++;
  }

  // Member at eats (see Contacts.eatAt); the counts follow.
  private eat(at: number, touched?: Int32Array): void {
    const kind = this.contacts.eatAt(at, touched);
    if (kind === HIT_NONE) return;
    if (kind === HIT_FOOD) {
      this.economy.food--;
      this.foodEaten++;
    } else {
      this.economy.poison--;
      this.poisonEaten++;
    }
  }

  // Ends member i's tick (settle), removing it when it died.
  private settleAt(i: number): void {
    const state = this.table.states[i]!;
    settle(state);
    if (!state.alive) {
      this.contacts.died(state, this.members[i]!.hue);
      this.remove(i);
    }
  }

  // The collision events since the last call, or null for none.
  drainEvents(): Float32Array | null {
    return this.contacts.drainEvents();
  }

  private giveBirth(parent: EcoCreature): void {
    const { eco, creature: cc } = this.config;
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
    mutate(genome, this.config.mutation.rate, this.config.mutation.std * parent.mutationScale, this.rng, this.wasmMembers);
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
    this.contacts.confine(spot);
    const child = this.spawn(genome, plan, spot.x, spot.y, angle, paid, parent.species, traits, parent.mutationScale);
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
    this.contacts.confine(s);
    child.parentId = parent.id;
    child.founderId = parent.founderId;
    this.lineages.born(child.founderId);
    child.depth = parent.depth + 1;
    child.hue = bandHue(sp, parent.hue + this.rng.normal() * eco.hueDrift);
    this.births++;
    this.counts[parent.species]!.births++;
  }

  // Places founder i with the birth traits in this.traits; the one path for drawn and cast founders.
  private found(i: number, c: CastMember, fromPool: boolean): void {
    const m = this.spawn(c.genome, c.plan, c.x, c.y, c.heading, c.energy ?? this.species[c.species]!.startEnergy, c.species, this.traits);
    m.hue = c.hue;
    this.lineages.describe(i, c.hue, c.species, fromPool);
  }

  // The most recent dead creature of this species among the last SPARE_LOOK whose brain has genomeLength genes (so its bank block and buffers fit as they are), else the latest one.
  private takeSpare(species: number, genomeLength: number): EcoCreature | undefined {
    const list = this.spare[species]!;
    const top = list.length - 1;
    for (let i = top; i >= 0 && i > top - SPARE_LOOK; i--) {
      if (list[i]!.creature.brain.genome.length !== genomeLength) continue;
      const m = list[i]!;
      list[i] = list[top]!;
      list.pop();
      return m;
    }
    return list.pop();
  }

  // Adds a creature with these birth traits, reusing a dead one's storage when there is one; genome and plan are copied.
  private spawn(genome: Genome, plan: PlanView, x: number, y: number, heading: number, energy: number, species: number, birth: BirthTraits, mutationScale = 1): EcoCreature {
    let m = this.takeSpare(species, genome.length);
    if (m) m.creature.reset(genome, x, y, heading, energy, plan);
    else {
      m = new EcoCreature(new Creature(this.engines[species]!, genome, x, y, heading, plan, this.kernels, species));
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
    m.bumpKills = 0;
    m.lastBirthTick = -Infinity;
    m.birth.energy = birth.energy;
    m.birth.cost = birth.cost;
    m.birth.cooldown = birth.cooldown;
    m.cooldownTicks = Math.round(birth.cooldown / this.config.dt);
    m.mutationScale = mutationScale;
    this.weights += m.creature.brain.genome.length;
    this.journal?.born.push(m.id);
    this.table.admit(m);
    return m;
  }

  // Swap-removes members[i].
  private remove(i: number): void {
    const m = this.table.swapRemove(i);
    this.weights -= m.creature.brain.genome.length;
    this.onDeath?.(m);
    this.lineages.died(m.founderId);
    this.journal?.died.push(m.id);
    this.spare[m.species]!.push(m);
    this.deaths++;
    const count = this.counts[m.species]!;
    count.population--;
    count.deaths++;
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
      const s = this.table.states[i]!;
      frame.ids[i] = m.id;
      frame.x[i] = s.x;
      frame.y[i] = s.y;
      frame.heading[i] = wrapAngle(s.heading);
      frame.energy[i] = s.energy;
      frame.hue[i] = m.hue;
      frame.founder[i] = m.founderId;
      frame.species[i] = m.species;
    }
    frame.count = n;
    return frame;
  }

  // --- Live world hooks (insert, save and restore, retune); step does not use them ---

  // Adds a creature of the visitor's own design at runtime, as the founder of a new lineage (its id is its founder id; name tags live on the lineage).
  // Goes through spawn like a birth, so the journal and helper threads see it; uses no random numbers, so it can be called between any two ticks.
  // Rejects, without changing anything, bad numbers, a genome that does not fit the plan, a position outside the walls and a full world.
  insertCreature(spec: InsertSpec): InsertResult {
    const checked = checkInsert(spec, { config: this.config, species: this.species, ranges: this.ranges, engines: this.engines, population: this.members.length, terrain: this.items.terrain }, this.traits);
    if (!checked.ok) return checked;
    const { genome, sp, heading, energy, mutationScale } = checked;
    const p = spec.plan;
    const traits = this.traits;
    const m = this.spawn(genome, p, spec.x, spec.y, heading, energy, sp, traits, mutationScale);
    m.hue = ((spec.hue % 360) + 360) % 360;
    this.lineages.describe(m.id, m.hue, sp, false, spec.name);
    this.lineages.found(m.id);
    return { ok: true, id: m.id };
  }

  // The old-age rule in force, or null; helper threads take it from the packet header.
  get agingRule(): Aging | null {
    return this.aging;
  }

  // The name tag the founder was inserted with, "" for none.
  lineageName(founder: number): string {
    return this.lineages.name(founder);
  }

  // The family table, for saveState and restoreState.
  get lineageTable(): Lineages {
    return this.lineages;
  }

  // The scalars of the run, for saveState.
  exportCore(): EcoCore {
    return {
      tick: this.tick, births: this.births, deaths: this.deaths, foodEaten: this.foodEaten, poisonEaten: this.poisonEaten,
      food: this.food, poison: this.poison, rngState: this.rng.state, foodDue: this.economy.foodDue, poisonDue: this.economy.poisonDue, nextId: this.nextId,
      founders: this.founders, poolFounders: this.poolFounders, itemCapacity: this.items.count, counts: this.counts.map((c) => ({ ...c })),
    };
  }

  // Sets the scalars of a saved run, for restoreState on a world built with the restore option.
  importCore(c: EcoCore): void {
    this.tick = c.tick; this.births = c.births; this.deaths = c.deaths; this.foodEaten = c.foodEaten; this.poisonEaten = c.poisonEaten;
    this.food = c.food; this.poison = c.poison; this.rng.state = c.rngState; this.economy.foodDue = c.foodDue; this.economy.poisonDue = c.poisonDue; this.nextId = c.nextId;
    if (c.counts.length !== this.counts.length) throw new Error("saved species counts do not fit this world");
    c.counts.forEach((x, i) => {
      const to = this.counts[i]!;
      to.population = x.population; to.births = x.births; to.deaths = x.deaths; to.eaten = x.eaten;
    });
  }

  // Appends a saved creature to the end of the member list (call in saved order), with its id and every field; the journal sees it as born.
  restoreMember(r: MemberRecord): EcoCreature {
    const m = new EcoCreature(new Creature(this.engines[r.species]!, r.genome, r.x, r.y, r.heading, r.plan, this.kernels, r.species));
    const c = m.creature;
    const s = c.state;
    s.vx = r.vx; s.vy = r.vy; s.turnRate = r.turnRate; s.energy = r.energy; s.ticksAlive = r.ticksAlive;
    c.heading.cos = r.cos; c.heading.sin = r.sin;
    c.setMemory(r.memory, 0);
    c.aging = this.aging;
    m.id = r.id; m.parentId = r.parentId; m.depth = r.depth; m.birthTick = r.birthTick; m.children = r.children; m.eaten = r.eaten; m.kills = r.kills; m.bumpKills = r.bumpKills ?? 0;
    m.species = r.species; m.hue = r.hue; m.founderId = r.founderId; m.lastBirthTick = r.lastBirthTick;
    m.birth.energy = r.birthEnergy; m.birth.cost = r.birthCost; m.birth.cooldown = r.birthCooldown; m.cooldownTicks = r.cooldownTicks; m.mutationScale = r.mutationScale ?? 1;
    this.weights += c.brain.genome.length;
    this.journal?.born.push(m.id);
    this.table.admit(m);
    return m;
  }

  // Changes settings of the running world, all or none; LIVE_FIELDS lists what is allowed. Takes effect from the next tick.
  // Changes the config object this world was built with. Helper threads follow it through the packet header.
  retune(patch: RetunePatch): RetuneResult {
    const checked = checkRetune(patch, this.config);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    const config = this.config;
    const sections = config as unknown as Record<string, Record<string, unknown>>;
    const eco = { ...config.eco } as Record<string, unknown>;
    for (const [section, key, v] of checked.fields) if (section === "eco") eco[key] = v;
    const caps = capsOf(config, eco as unknown as EcoConfig["eco"]);
    const foodCap = caps.food;
    const poisonCap = caps.poison;
    if (foodCap + poisonCap > this.items.count) return { ok: false, reason: `food and poison caps need ${foodCap + poisonCap} item slots, this world has ${this.items.count}` };
    for (const [section, key, v] of checked.fields) sections[section]![key] = Array.isArray(v) ? v.slice() : v;
    this.economy.retune(caps);
    this.aging = agingOf(config.eco, config.dt);
    for (const m of this.members) m.creature.aging = this.aging;
    if (checked.fields.some(([, key]) => key.startsWith("birth") && key.endsWith("Range"))) {
      const sp = this.species[0]!;
      sp.birthEnergyRange = config.eco.birthEnergyRange;
      sp.birthCostRange = config.eco.birthCostRange;
      sp.birthCooldownRange = config.eco.birthCooldownRange;
      this.ranges[0] = speciesRanges(config, sp);
    }
    return { ok: true, changed: checked.fields.map(([section, key]) => `${section}.${key}`) };
  }

  // Hash of the counts and every creature's id, position and energy; equal runs give equal fingerprints.
  fingerprint(): number {
    const P = 1_000_000_007;
    let h = (this.tick * 31 + this.births) % P;
    for (const v of [this.deaths, this.food, this.poison, this.members.length]) h = (h * 31 + v) % P;
    for (let i = 0; i < this.members.length; i++) {
      const s = this.table.states[i]!;
      h = (h * 31 + this.members[i].id) % P;
      h = (h * 31 + (Math.round(s.x * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.y * 100) % P)) % P;
      h = (h * 31 + (Math.round(s.energy * 1000) % P)) % P;
    }
    return h;
  }
}
